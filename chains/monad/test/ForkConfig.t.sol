// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

/// Checks the committed fork pin without touching any RPC, so it runs in CI.
contract ForkConfigTest is Test {
    uint256 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    /// Monad mainnet passed this height before P0-U2 (October 2026). A pin below it is a
    /// placeholder or a typo, and the non-archive RPC could not serve it anyway.
    uint256 internal constant MIN_PLAUSIBLE_BLOCK = 100_000_000;

    function test_PinnedConfigTargetsMonadMainnet() public view {
        string memory json = vm.readFile("./fork.json");
        assertEq(vm.parseJsonUint(json, ".chainId"), MONAD_MAINNET_CHAIN_ID, "fork.json chainId");
        assertGe(vm.parseJsonUint(json, ".blockNumber"), MIN_PLAUSIBLE_BLOCK, "fork.json blockNumber is a placeholder");
    }
}
