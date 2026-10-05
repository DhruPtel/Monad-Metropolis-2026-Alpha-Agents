// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

/// Smoke test against the local anvil fork started by `pnpm dev:up`.
/// Skipped when MONAD_RPC_URL is not set, because then no fork can be running.
contract MonadForkSmokeTest is Test {
    uint256 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    address internal constant ERC6551_REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    string internal constant LOCAL_FORK_URL = "http://127.0.0.1:8545";

    uint256 internal pinnedBlock;

    function setUp() public {
        if (bytes(vm.envOr("MONAD_RPC_URL", string(""))).length == 0) {
            vm.skip(true);
            return;
        }
        pinnedBlock = vm.parseJsonUint(vm.readFile("./fork.json"), ".blockNumber");
        vm.createSelectFork(LOCAL_FORK_URL);
    }

    function test_ChainIdIsMonadMainnet() public view {
        assertEq(block.chainid, MONAD_MAINNET_CHAIN_ID);
    }

    /// The fork starts at the pinned block. Using the dev fork (minting,
    /// deploying, the console's mine-blocks) adds local blocks on top, so the
    /// head is at or after the pin, and the pinned block itself is served.
    function test_ForkStartsAtPinnedBlock() public {
        assertGe(block.number, pinnedBlock);
        vm.rollFork(pinnedBlock);
        assertEq(block.number, pinnedBlock);
        assertGt(ERC6551_REGISTRY.code.length, 0, "pinned block state is served");
    }

    /// An RPC that cannot serve state at the pinned block fails the fork with an error;
    /// it never returns empty code, so empty code here means the registry is absent.
    function test_Erc6551RegistryHasCode() public view {
        assertGt(ERC6551_REGISTRY.code.length, 0, "ERC-6551 registry has no code at the pinned block");
    }
}
