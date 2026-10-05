// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {AgentNFT} from "../src/AgentNFT.sol";
import {AgentNFTBase} from "./AgentNFTBase.sol";

/// Two-step reveal (D-180, D-187): batches, deck draws and exact counts.
contract AgentNFTRevealTest is AgentNFTBase {
    function setUp() public override {
        super.setUp();
        openMint();
    }

    function test_RevealAssignsTierAndSpeciesWithEvents() public {
        mintMany(3);
        uint64 sequence = requestReveal();
        entropy.fulfill(sequence, keccak256("r"));
        vm.recordLogs();
        assertEq(nft.reveal(10), 3);
        assertEq(vm.getRecordedLogs().length, 6, "AgentRevealed and MetadataUpdate per agent");
        for (uint256 id = 1; id <= 3; ++id) {
            uint8 species = nft.speciesOf(id);
            assertTrue(nft.isRevealed(id));
            assertGe(species, 1);
            assertLe(species, 25);
            uint8 tier = nft.tierOf(id);
            assertEq(tier, species <= 5 ? 1 : species <= 13 ? 2 : 3);
            assertEq(nft.slotsOf(id), tier == 1 ? 3 : tier == 2 ? 5 : 8);
        }
        assertEq(nft.nextToReveal(), 4);
        assertEq(nft.remainingSupply(), 997);
        (uint64 pending,,,) = nft.pendingReveal();
        assertEq(pending, 0, "batch closed");
    }

    function test_RequestRevealEmitsBatchAndRefundsExcess() public {
        mintMany(4);
        vm.deal(address(this), 5 ether);
        uint256 before = address(this).balance;
        vm.expectEmit(address(nft));
        emit AgentNFT.RevealRequested(1001, 1, 4, false);
        nft.requestReveal{value: 3 ether}();
        assertEq(before - address(this).balance, entropy.fee(), "pays exactly the fee");
        assertEq(address(nft).balance, 0);
        assertEq(address(entropy).balance, entropy.fee());
    }

    function test_RequestRevealNeedsTheFee() public {
        mintMany(1);
        vm.deal(address(this), 5 ether);
        uint256 fee = entropy.fee();
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.InsufficientRevealFee.selector, fee - 1, fee));
        nft.requestReveal{value: fee - 1}();
    }

    function test_NothingToRevealWithoutUnrevealedAgents() public {
        vm.expectRevert(AgentNFT.NothingToReveal.selector);
        nft.requestReveal{value: 0}();
        mintMany(2);
        revealBatch(keccak256("x"));
        vm.deal(address(this), 5 ether);
        vm.expectRevert(AgentNFT.NothingToReveal.selector);
        nft.requestReveal{value: 2 ether}();
    }

    function test_RevealWithoutSeedReverts() public {
        mintMany(1);
        vm.expectRevert(AgentNFT.NoSeed.selector);
        nft.reveal(1);
        requestReveal();
        vm.expectRevert(AgentNFT.NoSeed.selector);
        nft.reveal(1);
    }

    function test_OnlyEntropyCanDeliver() public {
        mintMany(1);
        uint64 sequence = requestReveal();
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.NotEntropy.selector, address(this)));
        nft._entropyCallback(sequence, address(0), keccak256("forged"));
    }

    function test_RevealInChunksAndByAnyone() public {
        mintMany(10);
        uint64 sequence = requestReveal();
        entropy.fulfill(sequence, keccak256("chunks"));
        vm.prank(freshWallet());
        assertEq(nft.reveal(4), 4);
        assertEq(nft.nextToReveal(), 5);
        vm.prank(freshWallet());
        assertEq(nft.reveal(100), 6);
        assertEq(nft.nextToReveal(), 11);
    }

    function test_AgentsMintedAfterRequestWaitForTheNextBatch() public {
        mintMany(3);
        uint64 sequence = requestReveal();
        mintMany(2); // ids 4 and 5
        entropy.fulfill(sequence, keccak256("a"));
        nft.reveal(type(uint256).max);
        assertTrue(nft.isRevealed(3));
        assertFalse(nft.isRevealed(4));
        assertFalse(nft.isRevealed(5));

        uint64 next = requestReveal();
        entropy.fulfill(next, keccak256("b"));
        nft.reveal(type(uint256).max);
        assertTrue(nft.isRevealed(5));
    }

    function test_SeedIsStoredOnceAndEmitted() public {
        mintMany(1);
        uint64 sequence = requestReveal();
        bytes32 expected = keccak256(abi.encode(keccak256("n"), sequence, block.chainid, address(nft)));
        vm.expectEmit(address(nft));
        emit AgentNFT.RevealSeedStored(sequence, expected);
        entropy.fulfill(sequence, keccak256("n"));
        assertEq(nft.revealSeed(), expected);
    }

    /// Minting all 1,000 and revealing them yields exactly the owner's counts.
    function test_FullSupplyYieldsExactCounts() public {
        _mintAndRevealAll(keccak256("full supply"), 97);
        _assertExactCounts();
    }

    /// forge-config: default.fuzz.runs = 8
    function testFuzz_FullSupplyYieldsExactCountsForAnyRandomness(bytes32 seed, uint16 batch) public {
        _mintAndRevealAll(seed, bound(batch, 1, 400));
        _assertExactCounts();
    }

    function _mintAndRevealAll(bytes32 seed, uint256 batchSize) internal {
        uint256 round;
        while (nft.totalMinted() < 1000) {
            uint256 n = 1000 - nft.totalMinted();
            mintMany(n < batchSize ? n : batchSize);
            revealBatch(keccak256(abi.encode(seed, ++round)));
        }
        assertEq(nft.nextToReveal(), 1001);
        assertEq(nft.remainingSupply(), 0);
    }

    function _assertExactCounts() internal view {
        uint256[26] memory counts = speciesCounts();
        uint256[4] memory tiers;
        for (uint8 s = 1; s <= 25; ++s) {
            assertEq(counts[s], SPECIES_COUNTS[s - 1], "species count");
            assertEq(nft.remainingOf(s), 0);
            tiers[s <= 5 ? 1 : s <= 13 ? 2 : 3] += counts[s];
        }
        assertEq(counts[0], 0, "no unrevealed agent left");
        assertEq(tiers[1], 600);
        assertEq(tiers[2], 300);
        assertEq(tiers[3], 100);
    }
}

/// A minter cannot predict the result before minting, or reroll it by
/// delaying, cancelling, or letting a reveal expire.
contract AgentNFTRevealAttackTest is AgentNFTBase {
    address internal minter;

    function setUp() public override {
        super.setUp();
        openMint();
        mintMany(20);
        minter = freshWallet();
        vm.prank(minter);
        nft.mint(); // agent 21
        mintMany(5);
    }

    /// The result depends on a number that does not exist when the minter
    /// commits: different deliveries give different results for the same state.
    function test_ResultIsUnknowableAtMint() public {
        uint64 sequence = requestReveal();
        uint256 snap = vm.snapshotState();
        bool differs;
        entropy.fulfill(sequence, keccak256("world A"));
        nft.reveal(type(uint256).max);
        uint8 a = nft.speciesOf(21);
        for (uint256 i = 0; i < 8 && !differs; ++i) {
            vm.revertToState(snap);
            entropy.fulfill(sequence, keccak256(abi.encode("world B", i)));
            nft.reveal(type(uint256).max);
            differs = nft.speciesOf(21) != a;
        }
        assertTrue(differs, "outcome is decided by the delivered number");
    }

    /// Once the number is known, minting more cannot join that batch, so
    /// knowing a delivered number never lets anyone choose their result.
    function test_CannotMintIntoAKnownBatch() public {
        uint64 sequence = requestReveal();
        entropy.fulfill(sequence, keccak256("public now"));
        address late = freshWallet();
        vm.prank(late);
        uint256 lateId = nft.mint();
        nft.reveal(type(uint256).max);
        assertFalse(nft.isRevealed(lateId));
    }

    /// Who applies the reveal, when, and in how many chunks changes nothing.
    function test_DelayingDoesNotChangeTheResult() public {
        uint64 sequence = requestReveal();
        entropy.fulfill(sequence, keccak256("fixed"));
        uint256 snap = vm.snapshotState();

        nft.reveal(type(uint256).max);
        uint8[26] memory now_ = _snapshotSpecies();

        vm.revertToState(snap);
        vm.warp(block.timestamp + 365 days);
        vm.roll(block.number + 10_000_000);
        for (uint256 i = 0; i < 26; ++i) {
            vm.prank(freshWallet());
            nft.reveal(1);
        }
        uint8[26] memory later = _snapshotSpecies();
        for (uint256 i = 1; i <= 26; ++i) {
            assertEq(later[i - 1], now_[i - 1]);
        }
    }

    /// Mints in between, or other batches, cannot change a batch's deck: only
    /// one request is pending, and mints never touch the deck.
    function test_DeckIsFrozenWhileARequestIsPending() public {
        uint64 sequence = requestReveal();
        uint256 snap = vm.snapshotState();
        entropy.fulfill(sequence, keccak256("frozen"));
        nft.reveal(type(uint256).max);
        uint8 alone = nft.speciesOf(21);

        vm.revertToState(snap);
        mintMany(50);
        vm.deal(address(this), 5 ether);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.RevealPending.selector, sequence));
        nft.requestReveal{value: 2 ether}();
        entropy.fulfill(sequence, keccak256("frozen"));
        nft.reveal(type(uint256).max);
        assertEq(nft.speciesOf(21), alone);
    }

    /// There is nothing to cancel: no cancel function, no burn, no transfer
    /// before the escrow, and no second request while one is pending.
    function test_CannotCancel() public {
        uint64 sequence = requestReveal();
        vm.startPrank(minter);
        vm.expectRevert(AgentNFT.TransfersRestricted.selector);
        nft.transferFrom(minter, freshWallet(), 21);
        vm.stopPrank();
        (bool ok,) = address(nft).call(abi.encodeWithSignature("burn(uint256)", 21));
        assertFalse(ok, "no burn");
        (ok,) = address(nft).call(abi.encodeWithSignature("cancelReveal()"));
        assertFalse(ok, "no cancel");
        vm.deal(minter, 5 ether);
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.RevealPending.selector, sequence));
        nft.requestReveal{value: 2 ether}();
    }

    /// A delivered number is final: expiry never allows a new request.
    function test_ExpiryCannotReplaceADeliveredNumber() public {
        uint64 sequence = requestReveal();
        entropy.fulfill(sequence, keccak256("delivered"));
        vm.warp(block.timestamp + 30 days);
        vm.deal(minter, 5 ether);
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.RevealPending.selector, sequence));
        nft.requestReveal{value: 2 ether}();
        // A second delivery for the same request is ignored too.
        bytes32 seed = nft.revealSeed();
        entropy.fulfill(sequence, keccak256("second delivery"));
        assertEq(nft.revealSeed(), seed);
    }

    /// Before the timeout nobody can re-request; after it, the batch is the
    /// same, and the replaced request's late number is ignored.
    function test_ExpiredRequestKeepsItsBatchAndIgnoresTheOldNumber() public {
        uint64 first = requestReveal();
        vm.warp(block.timestamp + nft.REVEAL_TIMEOUT() - 1);
        vm.deal(minter, 5 ether);
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(AgentNFT.RevealPending.selector, first));
        nft.requestReveal{value: 2 ether}();

        mintMany(3); // ids 27 to 29, after the batch was fixed
        vm.warp(block.timestamp + 1);
        vm.expectEmit(address(nft));
        emit AgentNFT.RevealRequested(first + 1, 1, 26, true);
        vm.prank(minter);
        uint64 second = nft.requestReveal{value: 2 ether}();

        entropy.fulfill(first, keccak256("late old number"));
        assertEq(nft.revealSeed(), bytes32(0), "old request ignored");
        vm.expectRevert(AgentNFT.NoSeed.selector);
        nft.reveal(1);

        entropy.fulfill(second, keccak256("new number"));
        nft.reveal(type(uint256).max);
        assertTrue(nft.isRevealed(26));
        assertFalse(nft.isRevealed(27), "batch did not grow on retry");
    }

    function _snapshotSpecies() internal view returns (uint8[26] memory out) {
        for (uint256 id = 1; id <= 26; ++id) {
            out[id - 1] = nft.speciesOf(id);
        }
    }
}
