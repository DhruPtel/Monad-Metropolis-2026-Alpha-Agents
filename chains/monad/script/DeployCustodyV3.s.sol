// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console} from "forge-std/Script.sol";
import {AccountFactoryV3} from "../src/fund/AccountFactoryV3.sol";
import {OracleAdapterV3} from "../src/fund/OracleAdapterV3.sol";
import {PersonalAccountV3} from "../src/fund/PersonalAccountV3.sol";
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
///   CUSTODY_V3_PERSONAL_CAP, CUSTODY_V3_PLATFORM_CAP and
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
            platformCap: vm.envUint("CUSTODY_V3_PLATFORM_CAP"),
            allowlist: vm.envAddress("CUSTODY_V3_ALLOWLIST", ",")
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
        console.log("ACCOUNT_FACTORY_V3_SALT");
        console.logBytes32(factorySalt);
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
        require(f.platformTotal() == 0, "nothing deposited at deploy");
        require(f.allowlistEnabled(), "allowlist on at deploy");
        for (uint256 i = 0; i < d.allowlist.length; i++) {
            require(f.isAllowlisted(d.allowlist[i]), "allowlist entry");
        }
    }
}
