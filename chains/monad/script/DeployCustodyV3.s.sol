// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console} from "forge-std/Script.sol";
import {AccountFactoryV3} from "../src/fund/AccountFactoryV3.sol";
import {OracleAdapterV3} from "../src/fund/OracleAdapterV3.sol";
import {PersonalAccountV3} from "../src/fund/PersonalAccountV3.sol";
import {StrategyVaultV3} from "../src/fund/StrategyVaultV3.sol";
import {IAgentNFTView} from "../src/interfaces/ICustody.sol";
import {ITokenRegistry, Lane} from "../src/interfaces/IFund.sol";
import {DeployScope} from "./DeployScope.sol";

/// Deploys AccountFactoryV3, and with it the PersonalAccountV3 implementation,
/// beside the v1 and v2 custody sets and the fund agent's v3 set (F-U3). Run by
/// `pnpm deploy:custody-v3` (scripts/lib/custody-v3.js), which passes:
///   CUSTODY_V3_ADMIN, CUSTODY_V3_GUARDIAN, CUSTODY_V3_SENTINEL,
///   CUSTODY_V3_AGENT_NFT, CUSTODY_V3_USDC, CUSTODY_V3_TOKEN_REGISTRY,
///   CUSTODY_V3_ORACLE, CUSTODY_V3_EXECUTOR (zero until F-U4: Executor v3 is
///   its unit, and it deploys this factory again with the Executor given),
///   CUSTODY_V3_PERSONAL_CAP, CUSTODY_V3_VAULT_CAP, CUSTODY_V3_PLATFORM_CAP,
///   CUSTODY_V3_DEPOSITS_ENABLED (P7-U4: false until the launch decision) and
///   CUSTODY_V3_ALLOWLIST (comma-separated).
/// CREATE2 with the `alpha-agents.account-factory.v3` salt: running it again
/// with the same arguments finds the same contract. The onchain state is
/// asserted (MV-S15). Nothing that exists is touched.
contract DeployCustodyV3 is DeployScope {
    uint256 public constant SALT_VERSION = 3;
    string public constant SALT_NAME = "account-factory";

    function run() external returns (AccountFactoryV3 factory) {
        AccountFactoryV3.Deployment memory d = AccountFactoryV3.Deployment({
            admin: vm.envAddress("CUSTODY_V3_ADMIN"),
            guardian: vm.envAddress("CUSTODY_V3_GUARDIAN"),
            sentinel: vm.envAddress("CUSTODY_V3_SENTINEL"),
            oracle: vm.envAddress("CUSTODY_V3_ORACLE"),
            executor: vm.envOr("CUSTODY_V3_EXECUTOR", address(0)),
            agentNft: IAgentNFTView(vm.envAddress("CUSTODY_V3_AGENT_NFT")),
            usdc: vm.envAddress("CUSTODY_V3_USDC"),
            tokenRegistry: ITokenRegistry(vm.envAddress("CUSTODY_V3_TOKEN_REGISTRY")),
            personalCap: vm.envUint("CUSTODY_V3_PERSONAL_CAP"),
            vaultCap: vm.envUint("CUSTODY_V3_VAULT_CAP"),
            platformCap: vm.envUint("CUSTODY_V3_PLATFORM_CAP"),
            depositsEnabled: vm.envBool("CUSTODY_V3_DEPOSITS_ENABLED"),
            allowlist: vm.envAddress("CUSTODY_V3_ALLOWLIST", ","),
            personalImplementation: _implementation(
                "personal-account-implementation", type(PersonalAccountV3).creationCode
            ),
            vaultImplementation: vm.envOr("CUSTODY_V3_VAULTS", true)
                ? _implementation("vault-implementation", type(StrategyVaultV3).creationCode)
                : address(0)
        });
        _checkReferences(d);

        bytes memory initCode = abi.encodePacked(type(AccountFactoryV3).creationCode, abi.encode(d));
        bytes32 factorySalt = salt(SALT_NAME, SALT_VERSION);
        address predicted = vm.computeCreate2Address(factorySalt, keccak256(initCode), CREATE2_FACTORY);
        bool fresh = predicted.code.length == 0;
        if (fresh) {
            _startBroadcast();
            (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(factorySalt, initCode));
            vm.stopBroadcast();
            require(ok && predicted.code.length != 0, "CREATE2 deployment failed");
        } else {
            console.log("AccountFactoryV3 already deployed");
        }
        factory = AccountFactoryV3(predicted);

        _assertImmutables(factory, d);
        if (fresh) _assertInitialState(factory, d);
        console.log("ACCOUNT_FACTORY_V3_ADDRESS", address(factory));
        console.log("ACCOUNT_FACTORY_V3_CODE_SIZE", address(factory).code.length);
        console.log("PERSONAL_ACCOUNT_V3_IMPLEMENTATION", factory.PERSONAL_ACCOUNT_IMPLEMENTATION());
        console.log("PERSONAL_ACCOUNT_V3_CODE_SIZE", factory.PERSONAL_ACCOUNT_IMPLEMENTATION().code.length);
        console.log("STRATEGY_VAULT_V3_IMPLEMENTATION", factory.VAULT_IMPLEMENTATION());
        console.log("STRATEGY_VAULT_V3_CODE_SIZE", factory.VAULT_IMPLEMENTATION().code.length);
        console.log("ACCOUNT_FACTORY_V3_SALT");
        console.logBytes32(factorySalt);
    }

    /// CO-U1: an account implementation, deployed beforehand by CREATE2 (found again on a rerun),
    /// so the factory's own initcode stays under Base's and Arbitrum's limits.
    function _implementation(string memory name, bytes memory creationCode) internal returns (address impl) {
        bytes memory initCode = abi.encodePacked(
            creationCode,
            abi.encode(
                vm.envAddress("CUSTODY_V3_AGENT_NFT"),
                vm.envAddress("CUSTODY_V3_USDC"),
                vm.envAddress("CUSTODY_V3_TOKEN_REGISTRY")
            )
        );
        bytes32 implSalt = salt(name, SALT_VERSION);
        impl = vm.computeCreate2Address(implSalt, keccak256(initCode), CREATE2_FACTORY);
        if (impl.code.length > 0) return impl;
        _startBroadcast();
        (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(implSalt, initCode));
        vm.stopBroadcast();
        require(ok && impl.code.length != 0, string.concat(name, ": CREATE2 deployment failed"));
    }

    /// The set this factory binds to must exist and agree with itself.
    function _checkReferences(AccountFactoryV3.Deployment memory d) internal view {
        require(address(d.agentNft).code.length > 0, "AgentNFT missing: run pnpm deploy:agent-nft");
        require(address(d.tokenRegistry).code.length > 0, "TokenRegistry missing: run pnpm deploy:fund");
        require(d.oracle.code.length > 0, "OracleAdapterV3 missing: run pnpm deploy:fund");
        require(d.usdc.code.length > 0, "USDC missing");
        require(CREATE2_FACTORY.code.length > 0, "CREATE2 factory missing");
        require(d.tokenRegistry.tokenRecord(d.usdc).lane == Lane.CORE, "USDC is not a core token of the registry");
        OracleAdapterV3 oracle = OracleAdapterV3(d.oracle);
        require(address(oracle.TOKENS()) == address(d.tokenRegistry), "the oracle reads another registry");
        require(oracle.USDC() == d.usdc, "the oracle's USDC differs");
        if (d.executor != address(0)) require(d.executor.code.length > 0, "Executor given but missing");
    }

    /// What can never change after deployment.
    function _assertImmutables(AccountFactoryV3 f, AccountFactoryV3.Deployment memory d) internal view {
        require(address(f.AGENT_NFT()) == address(d.agentNft), "agent nft");
        require(f.USDC() == d.usdc, "usdc");
        require(address(f.TOKEN_REGISTRY()) == address(d.tokenRegistry), "token registry");
        require(f.RISK_TIMELOCK() == 9 days, "timelock");
        PersonalAccountV3 impl = PersonalAccountV3(f.PERSONAL_ACCOUNT_IMPLEMENTATION());
        require(address(impl).code.length > 0, "implementation");
        require(address(impl.AGENT_NFT()) == address(d.agentNft), "implementation agent nft");
        require(impl.USDC() == d.usdc, "implementation usdc");
        require(address(impl.TOKENS()) == address(d.tokenRegistry), "implementation registry");
        require(impl.MAX_HELD_TOKENS() == 16, "held list bound");
        require(f.VAULT_IMPLEMENTATION() == d.vaultImplementation, "vault implementation given");
        require(f.EXECUTION_WINDOW() == 7 days, "execution window");
        // CO-U1: no vaults where none was given (Base and Arbitrum).
        if (d.vaultImplementation == address(0)) return;
        StrategyVaultV3 vaultImpl = StrategyVaultV3(f.VAULT_IMPLEMENTATION());
        require(address(vaultImpl).code.length > 0, "vault implementation");
        require(address(vaultImpl.AGENT_NFT()) == address(d.agentNft), "vault agent nft");
        require(vaultImpl.USDC() == d.usdc, "vault usdc");
        require(address(vaultImpl.TOKENS()) == address(d.tokenRegistry), "vault registry");
        require(vaultImpl.MAX_LOCKUP() == 7 days && vaultImpl.MIN_LOCKUP() == 1 days, "vault lockups");
        require(vaultImpl.RISK_TIMELOCK() == 9 days, "vault timelock");
        require(f.EXECUTION_WINDOW() == 7 days, "execution window");
    }

    /// A fresh deployment must be exactly what was intended. A later run
    /// against an existing deployment skips this, since the admin may have
    /// changed the settings since (MV-S15: Veda's live config drifted from its repo).
    function _assertInitialState(AccountFactoryV3 f, AccountFactoryV3.Deployment memory d) internal view {
        require(f.owner() == d.admin, "admin");
        require(f.pendingOwner() == address(0), "no pending admin");
        require(f.guardian() == d.guardian && f.sentinel() == d.sentinel, "roles");
        require(f.executor() == d.executor, "executor at deploy");
        require(f.oracle() == d.oracle, "oracle at deploy");
        require(f.personalCap() == d.personalCap && f.platformCap() == d.platformCap, "caps");
        require(f.vaultCap() == d.vaultCap, "vault cap");
        require(f.platformTotal() == 0, "nothing deposited at deploy");
        require(f.allowlistEnabled(), "allowlist on at deploy");
        require(f.depositsEnabled() == d.depositsEnabled, "public deposits flag");
        for (uint256 i = 0; i < d.allowlist.length; i++) {
            require(f.isAllowlisted(d.allowlist[i]), "allowlist entry");
        }
    }
}
