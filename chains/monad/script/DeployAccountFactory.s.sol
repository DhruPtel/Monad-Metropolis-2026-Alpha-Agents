// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console} from "forge-std/Script.sol";
import {AccountFactory} from "../src/custody/AccountFactory.sol";
import {PersonalAccount} from "../src/custody/PersonalAccount.sol";
import {IAgentNFTView} from "../src/interfaces/ICustody.sol";

/// Deploys AccountFactory (and with it the PersonalAccount implementation)
/// through the deterministic CREATE2 factory, or finds the existing
/// deployment, then asserts the onchain state matches the intended
/// configuration (MV-S15). Run it through `pnpm deploy:account-factory`, which
/// refuses anything but the local fork and sets these variables:
///   ACCOUNT_FACTORY_ADMIN, ACCOUNT_FACTORY_GUARDIAN, ACCOUNT_FACTORY_SENTINEL,
///   ACCOUNT_FACTORY_AGENT_NFT, ACCOUNT_FACTORY_USDC, ACCOUNT_FACTORY_WMON,
///   ACCOUNT_FACTORY_PERSONAL_CAP, ACCOUNT_FACTORY_PLATFORM_CAP and
///   ACCOUNT_FACTORY_ALLOWLIST (comma-separated).
contract DeployAccountFactory is Script {
    bytes32 public constant SALT = keccak256("alpha-agents.account-factory.v1");

    /// The local fork's own chain ID (D-195). Testnet and mainnet are added by
    /// the units that deploy there (PB-U1 for the beta).
    uint256 internal constant LOCAL_FORK_CHAIN_ID = 143143;

    struct Config {
        address admin;
        address guardian;
        address sentinel;
        address agentNft;
        address usdc;
        address wmon;
        uint256 personalCap;
        uint256 platformCap;
        address[] allowlist;
    }

    function run() external returns (AccountFactory factory) {
        require(block.chainid == LOCAL_FORK_CHAIN_ID, "not the local fork (143143)");
        Config memory c = Config({
            admin: vm.envAddress("ACCOUNT_FACTORY_ADMIN"),
            guardian: vm.envAddress("ACCOUNT_FACTORY_GUARDIAN"),
            sentinel: vm.envAddress("ACCOUNT_FACTORY_SENTINEL"),
            agentNft: vm.envAddress("ACCOUNT_FACTORY_AGENT_NFT"),
            usdc: vm.envAddress("ACCOUNT_FACTORY_USDC"),
            wmon: vm.envAddress("ACCOUNT_FACTORY_WMON"),
            personalCap: vm.envUint("ACCOUNT_FACTORY_PERSONAL_CAP"),
            platformCap: vm.envUint("ACCOUNT_FACTORY_PLATFORM_CAP"),
            allowlist: vm.envAddress("ACCOUNT_FACTORY_ALLOWLIST", ",")
        });
        require(c.agentNft.code.length > 0, "AgentNFT missing: run pnpm deploy:agent-nft");
        require(c.usdc.code.length > 0 && c.wmon.code.length > 0, "USDC or WMON missing");
        require(CREATE2_FACTORY.code.length > 0, "CREATE2 factory missing");

        bytes memory initCode = abi.encodePacked(
            type(AccountFactory).creationCode,
            abi.encode(
                c.admin,
                c.guardian,
                c.sentinel,
                c.agentNft,
                c.usdc,
                c.wmon,
                c.personalCap,
                c.platformCap,
                c.allowlist
            )
        );
        address predicted = vm.computeCreate2Address(SALT, keccak256(initCode), CREATE2_FACTORY);

        bool fresh = predicted.code.length == 0;
        if (!fresh) {
            console.log("AccountFactory already deployed");
            factory = AccountFactory(predicted);
        } else {
            vm.startBroadcast();
            factory = new AccountFactory{salt: SALT}(
                c.admin,
                c.guardian,
                c.sentinel,
                IAgentNFTView(c.agentNft),
                c.usdc,
                c.wmon,
                c.personalCap,
                c.platformCap,
                c.allowlist
            );
            vm.stopBroadcast();
            require(address(factory) == predicted, "deployed address differs from prediction");
        }

        _assertImmutables(factory, c);
        if (fresh) _assertInitialState(factory, c);
        console.log("ACCOUNT_FACTORY_ADDRESS", address(factory));
        console.log("ACCOUNT_FACTORY_CODE_SIZE", address(factory).code.length);
        console.log("PERSONAL_ACCOUNT_IMPLEMENTATION", factory.PERSONAL_ACCOUNT_IMPLEMENTATION());
        console.log("PERSONAL_ACCOUNT_CODE_SIZE", factory.PERSONAL_ACCOUNT_IMPLEMENTATION().code.length);
    }

    /// What can never change after deployment.
    function _assertImmutables(AccountFactory f, Config memory c) internal view {
        require(address(f.AGENT_NFT()) == c.agentNft, "agent nft");
        require(f.USDC() == c.usdc && f.WMON() == c.wmon, "assets");
        require(f.RISK_TIMELOCK() == 9 days, "timelock");
        PersonalAccount impl = PersonalAccount(f.PERSONAL_ACCOUNT_IMPLEMENTATION());
        require(address(impl).code.length > 0, "implementation");
        require(address(impl.AGENT_NFT()) == c.agentNft, "implementation agent nft");
        require(impl.USDC() == c.usdc && impl.WMON() == c.wmon, "implementation assets");
    }

    /// A fresh deployment must be exactly what was intended. A later run
    /// against an existing deployment skips this, since the admin may have
    /// changed the settings since (MV-S15: Veda's live config drifted from its repo).
    function _assertInitialState(AccountFactory f, Config memory c) internal view {
        require(f.owner() == c.admin, "admin");
        require(f.pendingOwner() == address(0), "no pending admin");
        require(f.guardian() == c.guardian && f.sentinel() == c.sentinel, "roles");
        require(f.executor() == address(0), "executor unset at deploy");
        require(f.oracle() == address(0), "oracle unset at deploy");
        require(f.personalCap() == c.personalCap && f.platformCap() == c.platformCap, "caps");
        require(f.platformTotal() == 0, "nothing deposited at deploy");
        require(f.allowlistEnabled(), "allowlist on at deploy");
        for (uint256 i = 0; i < c.allowlist.length; i++) {
            require(f.isAllowlisted(c.allowlist[i]), "allowlist entry");
        }
        require(f.isBuyable(c.usdc) && f.isBuyable(c.wmon), "buy list");
    }
}
