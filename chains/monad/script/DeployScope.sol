// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";

/// The CREATE2 salts every deploy script uses, and the chains each may run on.
///
/// A deterministic address depends only on the salt and the init code, so a
/// throwaway deployment made with the plan's own salts could take the address
/// a later deployment computes (D-249). The local fork keeps the `v1` salts,
/// `alpha-agents.<name>.v1`. Monad testnet in P2-EC must use the `p2ec.testnet`
/// scope, `alpha-agents.p2ec.testnet.<name>.v1`, set by `DEPLOY_SALT_SCOPE`;
/// testnet without it is refused, so no P2-EC contract sits at a `v1` address.
/// Mainnet (143) is refused here; PB-U1 and the canary add their own paths.
abstract contract DeployScope is Script {
    /// The local fork's own chain ID (D-195).
    uint256 internal constant LOCAL_FORK_CHAIN_ID = 143143;
    uint256 internal constant MONAD_TESTNET_CHAIN_ID = 10143;
    string internal constant P2EC_TESTNET_SCOPE = "p2ec.testnet";

    /// The scope in force, checked against the chain: "" on the fork, `p2ec.testnet` on testnet.
    function saltScope() public view returns (string memory scope) {
        scope = vm.envOr("DEPLOY_SALT_SCOPE", string(""));
        if (block.chainid == LOCAL_FORK_CHAIN_ID) {
            require(bytes(scope).length == 0, "the local fork uses the v1 salts; unset DEPLOY_SALT_SCOPE");
        } else if (block.chainid == MONAD_TESTNET_CHAIN_ID) {
            require(
                keccak256(bytes(scope)) == keccak256(bytes(P2EC_TESTNET_SCOPE)),
                "Monad testnet deployments use DEPLOY_SALT_SCOPE=p2ec.testnet (D-249)"
            );
        } else {
            revert("not the local fork (143143) or Monad testnet (10143)");
        }
    }

    /// `keccak256("alpha-agents.<name>.v1")` on the fork, `keccak256("alpha-agents.<scope>.<name>.v1")` elsewhere.
    function salt(string memory name) public view returns (bytes32) {
        string memory scope = saltScope();
        if (bytes(scope).length == 0) return keccak256(abi.encodePacked("alpha-agents.", name, ".v1"));
        return keccak256(abi.encodePacked("alpha-agents.", scope, ".", name, ".v1"));
    }

    /// Broadcasts with DEPLOYER_PRIVATE_KEY when it is set (testnet), else as
    /// the unlocked `--sender` (the local fork's anvil account).
    function _startBroadcast() internal {
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (key == 0) vm.startBroadcast();
        else vm.startBroadcast(key);
    }
}
