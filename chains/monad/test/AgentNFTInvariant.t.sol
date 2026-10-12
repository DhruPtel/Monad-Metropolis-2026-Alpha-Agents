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

    /// A wallet that minted before mints again: its second mint lands, any
    /// later one is refused (two per wallet, NFT-U1).
    function mintAgain(uint256 which, uint8 times) external {
        if (wallets == 0) return;
        address wallet = address(uint160(0x10000 + 1 + (which % wallets)));
        times = uint8(bound(times, 1, 3));
        for (uint256 i = 0; i < times; ++i) {
            vm.prank(wallet);
            try NFT.mint() {} catch {}
        }
    }

    function walletCount() external view returns (uint256) {
        return wallets;
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
        uint256[35] memory counts = speciesCounts();
        uint256[4] memory tiers;
        uint256 revealed;
        for (uint8 s = 1; s <= SPECIES_COUNT; ++s) {
            assertLe(counts[s], SPECIES_COUNTS[s - 1], "species over its count");
            assertEq(counts[s] + nft.remainingOf(s), SPECIES_COUNTS[s - 1], "deck out of step");
            tiers[tierOfSpecies(s)] += counts[s];
            revealed += counts[s];
        }
        assertEq(counts[0], 0, "an agent below nextToReveal is unrevealed");
        assertLe(tiers[1], TIER_SUPPLY_BASE);
        assertLe(tiers[2], TIER_SUPPLY_MEDIUM);
        assertLe(tiers[3], TIER_SUPPLY_PRO);
        assertEq(revealed, nft.nextToReveal() - 1);
        assertEq(nft.remainingSupply(), 1000 - revealed);
    }

    /// No wallet ever mints more than two, and without an escrow nobody
    /// holds more than it minted (NFT-U1).
    function invariant_NoWalletMintsMoreThanTwo() public view {
        uint256 n = handler.walletCount();
        uint256 minted;
        for (uint256 i = 1; i <= n; ++i) {
            address wallet = address(uint160(0x10000 + i));
            assertLe(nft.mintsOf(wallet), 2, "more than two mints");
            assertEq(nft.balanceOf(wallet), nft.mintsOf(wallet), "held what it minted");
            minted += nft.mintsOf(wallet);
        }
        assertEq(minted, nft.totalMinted(), "every mint is a wallet's");
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
