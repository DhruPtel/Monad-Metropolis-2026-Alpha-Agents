// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {LocalFeed} from "../script/LocalFeed.sol";

/// packages/devenv carries LocalFeed's runtime code to put at the feed
/// addresses on the local fork (D-237). This fails if that copy differs from
/// what the compiler builds now; `pnpm devenv:local-feed` rewrites it.
contract LocalFeedCodeTest is Test {
    function test_DevenvCarriesTheBuiltCode() public view {
        string memory file = vm.readFile("../../packages/devenv/src/local-feed-code.ts");
        string[] memory parts = vm.split(file, '"');
        assertEq(parts.length, 3, "one quoted string in local-feed-code.ts");
        assertEq(vm.parseBytes(parts[1]), type(LocalFeed).runtimeCode, "run pnpm devenv:local-feed");
    }

    /// The storage layout devenv writes (LOCAL_FEED_SLOTS) is the one the contract reads.
    function test_TheStorageLayoutDevenvWrites() public {
        LocalFeed f = new LocalFeed();
        uint256 packed = uint256(77) | (uint256(8) << 80);
        vm.store(address(f), bytes32(uint256(0)), bytes32(packed));
        vm.store(address(f), bytes32(uint256(1)), bytes32(uint256(3_436_820)));
        vm.store(address(f), bytes32(uint256(2)), bytes32(uint256(1_790_876_425)));
        assertEq(f.decimals(), 8);
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            f.latestRoundData();
        assertEq(roundId, 77);
        assertEq(answer, 3_436_820);
        assertEq(startedAt, 1_790_876_425);
        assertEq(updatedAt, 1_790_876_425);
        assertEq(answeredInRound, 77);
        vm.store(address(f), bytes32(uint256(0)), bytes32(packed | (uint256(1) << 88)));
        vm.expectRevert("local feed down");
        f.latestRoundData();
        // A negative answer is a two's-complement word.
        vm.store(address(f), bytes32(uint256(0)), bytes32(packed));
        vm.store(address(f), bytes32(uint256(1)), bytes32(uint256(type(uint256).max)));
        (, answer,,,) = f.latestRoundData();
        assertEq(answer, -1);
    }
}
