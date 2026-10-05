// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

/// Smoke test against the local anvil fork started by `pnpm dev:up`.
/// Skipped when MONAD_RPC_URL is not set, because then no fork can be running.
contract MonadForkSmokeTest is Test {
    /// The fork's own chain ID (D-195), distinct from Monad mainnet's 143.
    uint256 internal constant LOCAL_FORK_CHAIN_ID = 143143;
    address internal constant ERC6551_REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    string internal constant LOCAL_FORK_URL = "http://127.0.0.1:8545";

    uint256 internal pinnedBlock;

    function setUp() public {
        if (bytes(vm.envOr("MONAD_RPC_URL", string(""))).length == 0) {
            vm.skip(true);
            return;
        }
        pinnedBlock = vm.parseJsonUint(vm.readFile("./fork.json"), ".blockNumber");
        vm.createSelectFork(vm.envOr("LOCAL_FORK_URL", LOCAL_FORK_URL));
    }

    function test_ChainIdIsTheLocalFork() public view {
        assertEq(block.chainid, LOCAL_FORK_CHAIN_ID);
    }

    /// With its own chain ID the fork must still run Monad's EVM (L-3): a
    /// 30,000-byte contract is over Ethereum's EIP-170 limit of 24,576 bytes
    /// and under Monad's 128 KB, so it deploys only under Monad rules.
    function test_AppliesMonadContractSizeLimit() public {
        // Initcode: PUSH2 30000, PUSH1 0, RETURN, so the runtime is 30,000 zero bytes.
        bytes memory init = hex"6175306000f3";
        address big;
        assembly {
            big := create(0, add(init, 0x20), mload(init))
        }
        assertTrue(big != address(0), "a 30,000-byte deploy was refused: not Monad rules");
        assertEq(big.code.length, 30_000);
    }

    /// The fork starts at the pinned block. Using the dev fork (minting,
    /// deploying, the console's mine-blocks) adds local blocks on top, so the
    /// head is at or after the pin, and the pinned block itself is served.
    function test_ForkStartsAtPinnedBlock() public {
        assertGe(block.number, pinnedBlock);
        vm.rollFork(pinnedBlock);
        assertEq(vm.getBlockNumber(), pinnedBlock);
        assertGt(ERC6551_REGISTRY.code.length, 0, "pinned block state is served");
    }

    /// An RPC that cannot serve state at the pinned block fails the fork with an error;
    /// it never returns empty code, so empty code here means the registry is absent.
    function test_Erc6551RegistryHasCode() public view {
        assertGt(ERC6551_REGISTRY.code.length, 0, "ERC-6551 registry has no code at the pinned block");
    }
}
