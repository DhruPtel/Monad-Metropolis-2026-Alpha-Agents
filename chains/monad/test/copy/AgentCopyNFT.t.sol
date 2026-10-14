// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {AgentCopyNFT} from "../../src/AgentCopyNFT.sol";

contract AgentCopyNFTTest is Test {
    AgentCopyNFT internal nft;
    address internal admin = makeAddr("admin");
    address internal minter = makeAddr("minter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        nft = new AgentCopyNFT(admin, minter, "https://example.test/agents/");
    }

    function test_TheMinterMintsACopyWithTheMonadIdTierAndSpecies() public {
        vm.expectEmit(true, true, false, false);
        emit AgentCopyNFT.AgentMinted(4, alice, address(0));
        vm.expectEmit(true, false, false, true);
        emit AgentCopyNFT.AgentRevealed(4, 2, 14);
        vm.prank(minter);
        nft.mintCopy(alice, 4, 2, 14);
        assertEq(nft.ownerOf(4), alice);
        assertEq(nft.ownerEpoch(4), 0);
        (uint8 tier, uint8 species) = nft.copyOf(4);
        assertEq(tier, 2);
        assertEq(species, 14);
        assertEq(
            nft.tokenURI(4),
            'data:application/json;utf8,{"name":"Vivarium Agent #4","image":"https://example.test/agents/14.png","attributes":[{"trait_type":"Tier","value":2},{"trait_type":"Species","value":14}]}'
        );
    }

    function test_OnlyTheMinterMintsOrMoves() public {
        vm.expectRevert(abi.encodeWithSelector(AgentCopyNFT.NotMinter.selector, alice));
        vm.prank(alice);
        nft.mintCopy(alice, 4, 2, 14);
        vm.prank(minter);
        nft.mintCopy(alice, 4, 2, 14);
        vm.expectRevert(abi.encodeWithSelector(AgentCopyNFT.NotMinter.selector, alice));
        vm.prank(alice);
        nft.moveCopy(4, bob);
    }

    function test_OwnersCannotTransferOrApprove() public {
        vm.prank(minter);
        nft.mintCopy(alice, 4, 2, 14);
        vm.startPrank(alice);
        vm.expectRevert(AgentCopyNFT.TransfersRestricted.selector);
        nft.transferFrom(alice, bob, 4);
        vm.expectRevert(AgentCopyNFT.TransfersRestricted.selector);
        nft.approve(bob, 4);
        vm.expectRevert(AgentCopyNFT.TransfersRestricted.selector);
        nft.setApprovalForAll(bob, true);
        vm.stopPrank();
    }

    function test_MovingACopyFollowsTheMonadOwnerAndBumpsTheEpoch() public {
        vm.startPrank(minter);
        nft.mintCopy(alice, 4, 2, 14);
        vm.expectEmit(true, true, true, true);
        emit AgentCopyNFT.OwnerEpochBumped(4, 1, alice, bob);
        nft.moveCopy(4, bob);
        vm.stopPrank();
        assertEq(nft.ownerOf(4), bob);
        assertEq(nft.ownerEpoch(4), 1);
    }

    function test_ACopyCannotBeMintedTwiceOrEmpty() public {
        vm.startPrank(minter);
        nft.mintCopy(alice, 4, 2, 14);
        vm.expectRevert();
        nft.mintCopy(bob, 4, 2, 14);
        vm.expectRevert(AgentCopyNFT.BadCopy.selector);
        nft.mintCopy(bob, 5, 2, 0);
        vm.stopPrank();
    }
}
