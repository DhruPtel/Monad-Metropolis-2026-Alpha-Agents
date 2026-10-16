// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";

/// The CREATE2 salts every deploy script uses, and the chains each may run on.
///
/// A deterministic address depends only on the salt and the init code, so a
/// throwaway deployment made with the plan's own salts could take the address
/// a later deployment computes (D-249). The local fork uses unscoped salts,
/// `alpha-agents.<name>.v<version>`: v1 for AgentNFT, v2 for the custody set
/// since its oracle's arguments changed (D-317). Monad testnet in P2-EC must use the `p2ec.testnet`
/// scope, `alpha-agents.p2ec.testnet.<name>.v1`, set by `DEPLOY_SALT_SCOPE`;
/// testnet without it is refused, so no P2-EC contract sits at a `v1` address.
/// On Monad mainnet (143) only the P2-EC canary deploys here (D-250 to D-252):
/// it needs `DEPLOY_SALT_SCOPE=p2ec.canary` and `CANARY_SIGNING_ENABLED=true`;
/// anything else on 143 is refused (PB-U1 adds its own path).
abstract contract DeployScope is Script {
    /// The local fork's own chain ID (D-195).
    uint256 internal constant LOCAL_FORK_CHAIN_ID = 143143;
    /// The Base fork's own chain ID (M-FAST): an anvil fork of Base mainnet on this machine, never
    /// Base's 8453, with the unscoped salts like the local fork; no real chain answers it.
    uint256 internal constant BASE_FORK_CHAIN_ID = 84538453;
    uint256 internal constant MONAD_TESTNET_CHAIN_ID = 10143;
    uint256 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    string internal constant P2EC_TESTNET_SCOPE = "p2ec.testnet";
    string internal constant P2EC_CANARY_SCOPE = "p2ec.canary";
    /// CO-U1: Base Sepolia and Arbitrum Sepolia, the Colosseum testnets.
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 internal constant ARBITRUM_SEPOLIA_CHAIN_ID = 421614;
    string internal constant CO_TESTNET_SCOPE = "co.testnet";
    /// 2026-10-16: the monad-dev stack's own fresh set on Monad testnet (nad.fun, the testnet price mode).
    string internal constant CO_DEV_SCOPE = "co.dev";

    /// The scope in force, checked against the chain: "" on the fork, `p2ec.testnet` on testnet,
    /// `p2ec.canary` on mainnet behind the canary's gate.
    function saltScope() public view returns (string memory scope) {
        scope = vm.envOr("DEPLOY_SALT_SCOPE", string(""));
        if (block.chainid == LOCAL_FORK_CHAIN_ID || block.chainid == BASE_FORK_CHAIN_ID) {
            require(bytes(scope).length == 0, "a local fork uses the unscoped salts; unset DEPLOY_SALT_SCOPE");
        } else if (block.chainid == MONAD_TESTNET_CHAIN_ID) {
            // CO-U1: the clean Monad testnet redeploy takes fresh addresses under co.testnet.
            require(
                keccak256(bytes(scope)) == keccak256(bytes(P2EC_TESTNET_SCOPE))
                    || keccak256(bytes(scope)) == keccak256(bytes(CO_TESTNET_SCOPE))
                    || keccak256(bytes(scope)) == keccak256(bytes(CO_DEV_SCOPE)),
                "Monad testnet deployments use DEPLOY_SALT_SCOPE=p2ec.testnet (D-249), co.testnet (CO-U1) or co.dev"
            );
        } else if (block.chainid == BASE_SEPOLIA_CHAIN_ID || block.chainid == ARBITRUM_SEPOLIA_CHAIN_ID) {
            require(
                keccak256(bytes(scope)) == keccak256(bytes(CO_TESTNET_SCOPE)),
                "Base Sepolia and Arbitrum Sepolia deployments use DEPLOY_SALT_SCOPE=co.testnet (CO-U1)"
            );
        } else if (block.chainid == MONAD_MAINNET_CHAIN_ID) {
            require(
                keccak256(bytes(scope)) == keccak256(bytes(P2EC_CANARY_SCOPE)),
                "Monad mainnet deployments here are the P2-EC canary's: DEPLOY_SALT_SCOPE=p2ec.canary (D-249)"
            );
            require(
                vm.envOr("CANARY_SIGNING_ENABLED", false),
                "the canary deploys to Monad mainnet only with CANARY_SIGNING_ENABLED=true (D-251)"
            );
        } else {
            revert(
                "not the local fork (143143), the Base fork (84538453), Monad testnet (10143), Base Sepolia (84532), Arbitrum Sepolia (421614) or the mainnet canary (143)"
            );
        }
    }

    /// `keccak256("alpha-agents.<name>.v1")` on the fork, `keccak256("alpha-agents.<scope>.<name>.v1")` elsewhere.
    function salt(string memory name) public view returns (bytes32) {
        return salt(name, 1);
    }

    /// The same at another version, `...<name>.v<version>`: a contract set whose
    /// arguments changed moves to a new version, so its new deployment sits
    /// beside the old one instead of colliding with what the old one bound (D-317).
    function salt(string memory name, uint256 version) public view returns (bytes32) {
        return saltFor(saltScope(), name, version);
    }

    /// The salt for a scope, name and version, without reading the environment.
    function saltFor(string memory scope, string memory name, uint256 version) public pure returns (bytes32) {
        require(version > 0, "salt versions start at 1");
        string memory v = string.concat(".v", vm.toString(version));
        if (bytes(scope).length == 0) return keccak256(abi.encodePacked("alpha-agents.", name, v));
        return keccak256(abi.encodePacked("alpha-agents.", scope, ".", name, v));
    }

    /// Broadcasts with DEPLOYER_PRIVATE_KEY when it is set (testnet), else as
    /// the unlocked `--sender` (the local fork's anvil account).
    function _startBroadcast() internal {
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (key == 0) vm.startBroadcast();
        else vm.startBroadcast(key);
    }
}
