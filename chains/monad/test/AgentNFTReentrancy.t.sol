// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {AgentNFT} from "../src/AgentNFT.sol";
import {IERC6551Registry, IEntropyV2} from "../src/interfaces/IExternal.sol";
import {AgentNFTBase} from "./AgentNFTBase.sol";
import {MockEntropy} from "./mocks/AgentNFTMocks.sol";

/// An Entropy that misbehaves inside `requestV2`: it calls back into AgentNFT
/// before returning, as Slither's reentrancy-eth finding on `requestReveal`
/// supposes. The real Pyth Entropy v2 never does (its callback arrives in a
/// later transaction from the provider); this proves that even if it did,
/// nothing is lost.
contract ReentrantEntropy is MockEntropy {
    AgentNFT public target;
    bool public reenterReveal;
    bool public reenterCallback;
    uint64 public innerSequence;
    bool private _entered;

    function arm(AgentNFT nft, bool reveal_, bool callback_) external {
        target = nft;
        reenterReveal = reveal_;
        reenterCallback = callback_;
    }

    function requestV2() external payable override returns (uint64 sequence) {
        if (msg.value < fee) revert FeeTooLow();
        sequence = ++lastSequence;
        requesterOf[sequence] = msg.sender;
        if (_entered) return sequence;
        _entered = true;
        if (reenterCallback) {
            // Deliver a number for this request before AgentNFT knows its sequence.
            target._entropyCallback(sequence, PROVIDER, keccak256("early"));
        }
        if (reenterReveal) {
            // Start a second request with Entropy's own money.
            innerSequence = target.requestReveal{value: fee}();
        }
        _entered = false;
    }

    receive() external payable {}
}

contract AgentNFTReentrancyTest is AgentNFTBase {
    ReentrantEntropy internal bad;

    function setUp() public override {
        super.setUp();
        bad = new ReentrantEntropy();
        nft = new AgentNFT(
            admin,
            signer.addr,
            treasury,
            IMAGE_BASE,
            IERC6551Registry(address(registry)),
            ACCOUNT_PROXY,
            ACCOUNT_IMPLEMENTATION,
            IEntropyV2(address(bad))
        );
        entropy = bad;
        openMint();
        mintMany(3);
    }

    /// A reentrant request costs the caller exactly one fee, leaves AgentNFT
    /// holding nothing, and the outer request is the one that stays pending:
    /// the inner one is orphaned at Entropy's own expense.
    function test_ReentrantRequestRevealOnlyOrphansEntropysOwnRequest() public {
        uint256 fee = bad.fee();
        vm.deal(address(bad), fee);
        bad.arm(nft, true, false);
        vm.deal(address(this), 5 ether);
        uint256 before = address(this).balance;

        uint64 outer = nft.requestReveal{value: 3 ether}();

        uint64 inner = bad.innerSequence();
        assertTrue(inner != 0 && inner != outer, "the inner request happened");
        (uint64 pending,, uint16 batchLast, bool seedReady) = nft.pendingReveal();
        assertEq(pending, outer, "the outer request is pending");
        assertEq(batchLast, 3);
        assertFalse(seedReady);
        assertEq(before - address(this).balance, fee, "the caller paid one fee");
        assertEq(address(nft).balance, 0, "AgentNFT keeps nothing");

        // The orphaned request's number is ignored; the outer one reveals.
        bad.fulfill(inner, keccak256("inner"));
        (,,, seedReady) = nft.pendingReveal();
        assertFalse(seedReady, "the orphaned number is ignored");
        bad.fulfill(outer, keccak256("outer"));
        assertEq(nft.reveal(10), 3);
    }

    /// A number delivered during the request, before AgentNFT stored its
    /// sequence, is ignored: no seed can be planted for a request in flight.
    function test_CallbackDuringRequestIsIgnored() public {
        bad.arm(nft, false, true);
        vm.deal(address(this), 5 ether);
        uint64 sequence = nft.requestReveal{value: 2 ether}();
        (uint64 pending,,, bool seedReady) = nft.pendingReveal();
        assertEq(pending, sequence);
        assertFalse(seedReady, "the early number did not count");
        assertEq(nft.revealSeed(), bytes32(0));
    }

    /// The refund is the last statement: a caller that reenters from it finds
    /// the batch already pending.
    function test_RefundReentryFindsTheBatchPending() public {
        RefundReentrant caller = new RefundReentrant(nft);
        vm.deal(address(caller), 5 ether);
        caller.go(3 ether);
        assertTrue(caller.reentryReverted(), "the reentrant request reverted");
        (uint64 pending,,,) = nft.pendingReveal();
        assertEq(pending, caller.sequence());
    }
}

contract RefundReentrant {
    AgentNFT public immutable NFT;
    uint64 public sequence;
    bool public reentryReverted;
    bool private _inGo;

    constructor(AgentNFT nft) {
        NFT = nft;
    }

    function go(uint256 value) external {
        _inGo = true;
        sequence = NFT.requestReveal{value: value}();
        _inGo = false;
    }

    receive() external payable {
        if (!_inGo) return;
        _inGo = false;
        try NFT.requestReveal{value: 2 ether}() {}
        catch {
            reentryReverted = true;
        }
    }
}
