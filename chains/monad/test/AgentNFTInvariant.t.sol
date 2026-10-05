// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {AgentNFTBase} from "./AgentNFTBase.sol";
import {MockEntropy} from "./mocks/AgentNFTMocks.sol";

/// Drives random sequences of mints, reveal requests, deliveries (including
/// stale and repeated ones), partial reveals, timeouts and retries.
contract AgentNFTHandler is Test {
    AgentNFT internal immutable NFT;
    MockEntropy internal immutable ENTROPY;
    uint256 internal wallets;
    uint64[] internal sequences;

    constructor(AgentNFT nft, MockEntropy entropy) {
        NFT = nft;
        ENTROPY = entropy;
    }

    function mint(uint8 count) external {
        count = uint8(bound(count, 1, 40));
        for (uint256 i = 0; i < count; ++i) {
            vm.prank(address(uint160(0x10000 + ++wallets)));
            try NFT.mint() {} catch {}
        }
    }

    function requestReveal() external {
        vm.deal(address(this), 10 ether);
        try NFT.requestReveal{value: 2 ether}() returns (uint64 sequence) {
            sequences.push(sequence);
        } catch {}
    }

    function deliver(uint256 which, bytes32 randomNumber) external {
        if (sequences.length == 0) return;
        ENTROPY.fulfill(sequences[which % sequences.length], randomNumber);
    }

    function reveal(uint16 maxCount) external {
        try NFT.reveal(bound(maxCount, 1, 300)) {} catch {}
    }

    function waitOut() external {
        vm.warp(block.timestamp + NFT.REVEAL_TIMEOUT());
    }

    receive() external payable {}
}

contract AgentNFTInvariantTest is AgentNFTBase {
    AgentNFTHandler internal handler;

    function setUp() public override {
        super.setUp();
        openMint();
        handler = new AgentNFTHandler(nft, entropy);
        targetContract(address(handler));
    }

    /// No species or tier is ever over its count, and the deck accounts for
    /// every revealed agent.
    function invariant_NoCountIsEverExceeded() public view {
        uint256[26] memory counts = speciesCounts();
        uint256[4] memory tiers;
        uint256 revealed;
        for (uint8 s = 1; s <= 25; ++s) {
            assertLe(counts[s], SPECIES_COUNTS[s - 1], "species over its count");
            assertEq(counts[s] + nft.remainingOf(s), SPECIES_COUNTS[s - 1], "deck out of step");
            tiers[s <= 5 ? 1 : s <= 13 ? 2 : 3] += counts[s];
            revealed += counts[s];
        }
        assertEq(counts[0], 0, "an agent below nextToReveal is unrevealed");
        assertLe(tiers[1], 600);
        assertLe(tiers[2], 300);
        assertLe(tiers[3], 100);
        assertEq(revealed, nft.nextToReveal() - 1);
        assertEq(nft.remainingSupply(), 1000 - revealed);
    }

    function invariant_TotalNeverPasses1000() public view {
        assertLe(nft.totalMinted(), 1000);
        assertLe(nft.nextToReveal() - 1, nft.totalMinted());
    }

    function invariant_AgentsAboveTheRevealPointAreUnrevealed() public view {
        uint256 minted = nft.totalMinted();
        for (uint256 id = nft.nextToReveal(); id <= minted; ++id) {
            assertEq(nft.speciesOf(id), 0);
        }
    }
}
