// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {PersonalAccountV3} from "../../src/fund/PersonalAccountV3.sol";
import {AccountMode} from "../../src/interfaces/ICustody.sol";
import {SwapParamsV3} from "../../src/interfaces/ICustodyV3.sol";
import {PriceReason} from "../../src/interfaces/IFund.sol";
import {MockToken} from "../mocks/CustodyMocks.sol";
import {MockExecutorV3} from "../mocks/CustodyV3Mocks.sol";
import {MockFeed} from "../mocks/OracleMocks.sol";
import {CustodyV3Base} from "./CustodyV3Base.sol";

/// Trading through the custody core v3 (F-U3): the Executor's one path, the
/// core's own backstops over many tokens, the cost-basis ledger and the class A
/// caps that hold by basis even with a wrong price, and the screened-lane opt-in.
contract CustodyV3TradingTest is CustodyV3Base {
    function test_NobodyTradesWhileTheExecutorIsUnset() public {
        deposit(usdc, 50e6);
        SwapParamsV3 memory p = params(address(usdc), address(tokA), 1e6);
        address[5] memory callers = [owner, admin, guardian, address(factory), address(executor)];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotExecutor.selector, callers[i]));
            account.executeSwap(p);
        }
    }

    function test_AnHonestSwapPasses_RecordsIt_AndLeavesNoAllowance() public {
        tradingAccount();
        SwapParamsV3 memory p = params(address(usdc), address(tokA), 60e6);
        uint256 navBefore = account.navUsdc();
        vm.expectEmit(address(account));
        emit CustodyCoreV3.CostBasisChanged(address(tokA), 300e6, 360e6);
        vm.expectEmit(address(account));
        emit CustodyCoreV3.SwapExecuted(
            address(executor),
            address(usdc),
            address(tokA),
            bytes32(0),
            CustodyCoreV3.TradeRecord({
                amountIn: 60e6,
                amountOut: 10e18,
                valueIn: 60e6,
                valueOut: 60e6,
                priceInE18: 1e18,
                priceOutE18: 6e18,
                navBefore: 900e6,
                navAfter: 900e6,
                ownershipEpoch: 0,
                configEpoch: 0
            })
        );
        swap(p);
        assertEq(usdcBal(address(account)), 540e6);
        assertEq(tokA.balanceOf(address(account)), 60e18);
        assertEq(account.navUsdc(), navBefore);
        assertEq(usdc.allowance(address(account), address(executor)), 0);
        assertEq(usdcBal(address(executor)) - 1e30, 60e6);
        assertEq(account.costBasis(address(tokA)), 360e6);
        assertEq(account.costBasis(address(usdc)), 540e6);
    }

    function test_ABuyAddsTheTokenToTheHeldList_AndSellingItAllRemovesIt() public {
        tradingAccount();
        swap(params(address(usdc), address(tokB), 40e6));
        address[] memory held = new address[](3);
        (held[0], held[1], held[2]) = (address(usdc), address(tokA), address(tokB));
        assertHeld(held);
        assertEq(tokB.balanceOf(address(account)), 1e8);
        assertEq(account.costBasis(address(tokB)), 40e6);
        (uint256 px,) = account.lastPrice(address(tokB));
        assertEq(px, 40e18);

        vm.expectEmit(address(account));
        emit CustodyCoreV3.HeldTokenRemoved(address(tokB));
        swap(params(address(tokB), address(usdc), 1e8));
        assertHeld(two(address(usdc), address(tokA)));
        assertEq(account.costBasis(address(tokB)), 0);
        assertEq(usdcBal(address(account)), 600e6);
    }

    /// The basis follows the USDC paid: a swap between two tokens moves the
    /// sold share from one to the other, and a sale into USDC realizes it.
    function test_ASwapBetweenTwoTokensMovesTheCostBasis() public {
        tradingAccount();
        swap(params(address(tokA), address(tokB), 10e18)); // 60 USDC of A becomes 1.5 B
        assertEq(tokB.balanceOf(address(account)), 1.5e8);
        assertEq(account.costBasis(address(tokA)), 240e6);
        assertEq(account.costBasis(address(tokB)), 60e6);
        swap(params(address(tokB), address(usdc), 0.5e8));
        assertEq(account.costBasis(address(tokB)), 40e6);
        assertEq(usdcBal(address(account)), 620e6);
        (, uint256 totalBasis, uint256 classABasis) = account.capValues();
        assertEq(totalBasis, 620e6 + 240e6 + 40e6);
        assertEq(classABasis, 0);
    }

    function test_ADonationCountsInValueButNotInBasis() public {
        tradingAccount();
        tokA.mint(address(account), 10e18);
        assertEq(account.navUsdc(), 960e6);
        assertEq(account.costBasis(address(tokA)), 300e6);
        // Selling a sixth of the balance takes a sixth of the basis.
        swap(params(address(tokA), address(usdc), 10e18));
        assertEq(account.costBasis(address(tokA)), 250e6);
    }

    function test_OnlyTheExecutorSwaps_AndPullsOnlyInsideASwap() public {
        tradingAccount();
        SwapParamsV3 memory p = params(address(usdc), address(tokA), 1e6);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotExecutor.selector, stranger));
        account.executeSwap(p);
        vm.prank(address(executor));
        vm.expectRevert(CustodyCoreV3.SwapContextInvalid.selector);
        account.pullForSwap(address(usdc), 1e6);
        vm.prank(stranger);
        vm.expectRevert(CustodyCoreV3.SwapContextInvalid.selector);
        account.pullForSwap(address(usdc), 1e6);
    }

    /// MV-S5: the core catches a buggy or compromised Executor on its own.
    function test_TheCoreCatchesAMisbehavingExecutor() public {
        tradingAccount();
        deposit(tokB, 1e8);
        executor.setOtherToken(address(tokB));
        SwapParamsV3 memory p = params(address(usdc), address(tokA), 60e6);
        _expectSwapRevert(
            MockExecutorV3.Behaviour.PullTwice, p, abi.encodeWithSelector(CustodyCoreV3.SwapContextInvalid.selector)
        );
        _expectSwapRevert(
            MockExecutorV3.Behaviour.PullMore, p, abi.encodeWithSelector(CustodyCoreV3.SwapContextInvalid.selector)
        );
        _expectSwapRevert(
            MockExecutorV3.Behaviour.PullOtherToken,
            p,
            abi.encodeWithSelector(CustodyCoreV3.SwapContextInvalid.selector)
        );
        _expectSwapRevert(
            MockExecutorV3.Behaviour.PayNothing, p, abi.encodeWithSelector(CustodyCoreV3.OutputTooLow.selector, 0, 1)
        );
        _expectSwapRevert(
            MockExecutorV3.Behaviour.PayWrongToken, p, abi.encodeWithSelector(CustodyCoreV3.OutputTooLow.selector, 0, 1)
        );
        _expectSwapRevert(
            MockExecutorV3.Behaviour.PayLess,
            p,
            abi.encodeWithSelector(CustodyCoreV3.SlippageTooHigh.selector, 60e6, 30e6)
        );
        _expectSwapRevert(
            MockExecutorV3.Behaviour.BurnOtherToken,
            p,
            abi.encodeWithSelector(CustodyCoreV3.OtherBalanceFell.selector, address(tokB))
        );
        _expectSwapRevert(
            MockExecutorV3.Behaviour.ReenterExecute,
            p,
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
        _expectSwapRevert(
            MockExecutorV3.Behaviour.ReenterWithdraw,
            p,
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(usdcBal(address(account)), 600e6);
        assertEq(tokA.balanceOf(address(account)), 50e18);
        assertEq(tokB.balanceOf(address(account)), 1e8);
    }

    function _expectSwapRevert(MockExecutorV3.Behaviour b, SwapParamsV3 memory p, bytes memory err) internal {
        executor.setBehaviour(b);
        vm.expectRevert(err);
        executor.swap(account, p);
        executor.setBehaviour(MockExecutorV3.Behaviour.Honest);
    }

    function test_TheMinimumOutputHolds() public {
        tradingAccount();
        SwapParamsV3 memory p = params(address(usdc), address(tokA), 60e6);
        p.minAmountOut = 10e18 + 1;
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.OutputTooLow.selector, 10e18, 10e18 + 1));
        swap(p);
    }

    function test_SlippageBackstopAtOnePercent() public {
        tradingAccount();
        SwapParamsV3 memory p = params(address(tokA), address(usdc), 15e18); // 90 USDC
        executor.setOutputBps(9_900);
        swap(p);
        executor.setOutputBps(9_899);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.SlippageTooHigh.selector, 90e6, 89.091e6));
        swap(p);
    }

    function test_TradeSizeBackstopAtTwelvePercent() public {
        tradingAccount();
        // NAV 900 USDC: a sale worth 108.000001 is refused; one worth exactly 108 passes.
        SwapParamsV3 memory over = params(address(tokA), address(usdc), 18_000_000_166_666_666_667);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.TradeTooLarge.selector, 108_000_001, 900e6));
        swap(over);
        swap(params(address(tokA), address(usdc), 18e18));
    }

    function test_ConcentrationBackstopAtFortyFivePercentByValueForClassF() public {
        tradingAccount();
        // A is 300 of 900: buying 105 more reaches exactly 45%, then any more is refused.
        swap(params(address(usdc), address(tokA), 105e6));
        SwapParamsV3 memory more = params(address(usdc), address(tokA), 1.2e6);
        vm.expectRevert(
            abi.encodeWithSelector(CustodyCoreV3.ConcentrationTooHigh.selector, address(tokA), 406.2e6, 900e6)
        );
        swap(more);
        // Selling into USDC is never limited by concentration.
        swap(params(address(tokA), address(usdc), 10e18));
    }

    // ----- class A: the cost-basis caps (D-337) -----

    function test_TheClassAPositionCapHoldsByCostBasis_AtTheThresholdAndOneOver() public {
        tradingAccount();
        swap(attested(address(usdc), address(tokC), 100e6));
        assertEq(tokC.balanceOf(address(account)), 250e18);
        assertEq(account.costBasis(address(tokC)), 100e6);
        swap(attested(address(usdc), address(tokC), 35e6)); // exactly 15% of the 900 basis
        assertEq(account.costBasis(address(tokC)), 135e6);
        (uint256 capped, uint256 totalBasis, uint256 classABasis) = account.capValues();
        assertEq(capped, 900e6);
        assertEq(totalBasis, 900e6);
        assertEq(classABasis, 135e6);
        SwapParamsV3 memory over = attested(address(usdc), address(tokC), 1);
        vm.expectRevert(
            abi.encodeWithSelector(CustodyCoreV3.ClassAPositionTooLarge.selector, address(tokC), 135_000_001, 900e6)
        );
        swap(over);
    }

    function test_TheClassATotalCapHoldsAcrossPositions() public {
        tradingAccount();
        optIn();
        address[3] memory a = [address(tokC), address(tokD), address(tokE)];
        for (uint256 i = 0; i < 3; ++i) {
            swap(attested(address(usdc), a[i], 100e6));
            swap(attested(address(usdc), a[i], 35e6));
        }
        swap(attested(address(usdc), address(tokF), 45e6)); // 450 of 900: exactly 50%
        (, uint256 totalBasis, uint256 classABasis) = account.capValues();
        assertEq(totalBasis, 900e6);
        assertEq(classABasis, 450e6);
        SwapParamsV3 memory over = attested(address(usdc), address(tokF), 1);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.ClassATooLarge.selector, 450_000_001, 900e6));
        swap(over);
        // Selling class A back into USDC frees the room again.
        swap(attested(address(tokF), address(usdc), 1e18)); // 10 USDC of F
        swap(attested(address(usdc), address(tokF), 10e6));
    }

    /// The caps need no price: a wrong attestation, high or low, cannot widen
    /// a position or enlarge the trades the account may make.
    function test_TheClassACapsHoldEvenWithAWrongPrice() public {
        tradingAccount();
        swap(attested(address(usdc), address(tokC), 100e6));
        // The attestor now says C is worth a hundred times more: the position
        // is still capped by what was paid for it.
        SwapParamsV3 memory p = params(address(usdc), address(tokC), 35e6);
        p.attestationOut = attestation(address(tokC), 40e18);
        executor.setPrice(address(tokC), 40e18);
        swap(p);
        assertEq(account.costBasis(address(tokC)), 135e6);
        SwapParamsV3 memory over = params(address(usdc), address(tokC), 1);
        over.attestationOut = attestation(address(tokC), 40e18);
        vm.expectRevert(
            abi.encodeWithSelector(CustodyCoreV3.ClassAPositionTooLarge.selector, address(tokC), 135_000_001, 900e6)
        );
        swap(over);
        // And a hundred times less: the capped value counts C at that value,
        // so trades shrink with it rather than growing with a pumped price.
        address[] memory t = one(address(tokC));
        bytes[] memory atts = new bytes[](1);
        atts[0] = attestation(address(tokC), 0.004e18);
        account.poke(t, atts);
        (uint256 capped,,) = account.capValues();
        // 465 USDC, 300 of A, and the 250.875 C (250 bought at 0.40, 0.875 at 40)
        // at the lower of their 135 basis and their 1.0035 value.
        assertEq(capped, 766.0035e6);
        SwapParamsV3 memory sale = params(address(tokA), address(usdc), 15_333_333_333_333_333_334);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.TradeTooLarge.selector, 92_000_000, 766.0035e6));
        swap(sale);
    }

    function test_AClassATokenNeedsAFreshAttestationOnItsSide() public {
        tradingAccount();
        SwapParamsV3 memory bare = params(address(usdc), address(tokC), 50e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.UnpricedToken.selector, address(tokC)));
        swap(bare);
        SwapParamsV3 memory expired = params(address(usdc), address(tokC), 50e6);
        attestor.set(address(tokC), PX_C, uint64(block.timestamp - 1));
        expired.attestationOut = abi.encode(address(tokC));
        vm.expectRevert(abi.encodeWithSelector(OracleAdapterV3.BadAttestation.selector, address(tokC)));
        swap(expired);
        swap(attested(address(usdc), address(tokC), 50e6));
        // The cached price values the position, but a sale needs its own attestation.
        assertEq(account.navUsdc(), 900e6);
        SwapParamsV3 memory sale = params(address(tokC), address(usdc), 10e18);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.UnpricedToken.selector, address(tokC)));
        swap(sale);
        swap(attested(address(tokC), address(usdc), 10e18));
        assertEq(account.costBasis(address(tokC)), 46e6);
    }

    // ----- the screened lane (D-351) -----

    function test_ScreenedTokensAreUnbuyableUntilTheOwnerOptsIn_AndOptingOutIsInstant() public {
        tradingAccount();
        SwapParamsV3 memory buy = attested(address(usdc), address(tokD), 50e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotBuyable.selector, address(tokD)));
        swap(buy);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, stranger));
        account.setScreenedOptIn(true);
        assertFalse(tokens.buyableFor(address(tokD), address(account)));

        vm.prank(owner);
        vm.expectEmit(address(account));
        emit PersonalAccountV3.ScreenedOptInSet(false, true);
        account.setScreenedOptIn(true);
        assertTrue(account.screenedOptIn());
        assertTrue(tokens.buyableFor(address(tokD), address(account)));
        swap(attested(address(usdc), address(tokD), 50e6));
        assertEq(tokD.balanceOf(address(account)), 25e6);
        assertTrue(account.isHeld(address(tokD)));

        vm.prank(owner);
        account.setScreenedOptIn(false);
        SwapParamsV3 memory again = attested(address(usdc), address(tokD), 1e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotBuyable.selector, address(tokD)));
        swap(again);
        // What is held is still sold, and always withdrawn.
        swap(attested(address(tokD), address(usdc), 5e6));
        vm.prank(owner);
        account.withdraw(address(tokD), 20e6, owner);
        assertEq(tokD.balanceOf(owner), 20e6);
    }

    /// A core token is buyable with no opt-in; a screened one never is for a
    /// vault, whatever it answers (the registry's rule, read by the core).
    function test_CoreTokensNeedNoOptIn() public {
        tradingAccount();
        swap(attested(address(usdc), address(tokC), 10e6));
        assertFalse(account.screenedOptIn());
    }

    // ----- modes, epochs and refusals -----

    function test_ReduceOnlyAndPausedAllowOnlySwapsIntoUsdc() public {
        tradingAccount();
        AccountMode[2] memory modes = [AccountMode.REDUCE_ONLY, AccountMode.PAUSED];
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(sentinel);
            if (modes[i] == AccountMode.REDUCE_ONLY) account.setReduceOnly();
            else account.pause();
            SwapParamsV3 memory buy = params(address(usdc), address(tokA), 1e6);
            vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.ReduceOnly.selector, modes[i]));
            swap(buy);
            swap(params(address(tokA), address(usdc), 2e18));
        }
    }

    function test_ASaleStopsTrading_AndAStaleEpochNeverRevives() public {
        tradingAccount();
        SwapParamsV3 memory p = params(address(usdc), address(tokA), 1e6);
        address buyer = makeAddr("buyer");
        nft.setOwner(AGENT, buyer);
        vm.expectRevert(abi.encodeWithSelector(PersonalAccountV3.NotAgentOwner.selector, buyer));
        swap(p);
        nft.setOwner(AGENT, owner);
        vm.expectRevert(abi.encodeWithSelector(PersonalAccountV3.StaleEpoch.selector, 0, 2));
        swap(p);
        swap(params(address(usdc), address(tokA), 1e6));
    }

    function test_ExpiredSameTokenZeroUnheldAndUnregisteredSwapsAreRefused() public {
        tradingAccount();
        SwapParamsV3 memory p = params(address(usdc), address(tokA), 1e6);
        vm.warp(p.deadline + 1);
        refreshFeeds();
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.Expired.selector, p.deadline));
        swap(p);
        SwapParamsV3 memory same = params(address(usdc), address(usdc), 1e6);
        vm.expectRevert(CustodyCoreV3.SameToken.selector);
        swap(same);
        SwapParamsV3 memory zero = params(address(usdc), address(tokA), 0);
        vm.expectRevert(CustodyCoreV3.ZeroAmount.selector);
        swap(zero);
        SwapParamsV3 memory unheld = params(address(tokB), address(usdc), 1e8);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotHeldAsset.selector, address(tokB)));
        swap(unheld);
        MockToken other = new MockToken("OTHER", 6);
        SwapParamsV3 memory unregistered = params(address(usdc), address(other), 1e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotBuyable.selector, address(other)));
        swap(unregistered);
    }

    /// The held list is separate from the registry's status (D-056): sell-only
    /// is still sold and withdrawn, frozen is only withdrawn.
    function test_ASellOnlyTokenIsStillSoldAndWithdrawn_AFrozenOneOnlyWithdrawn() public {
        tradingAccount();
        vm.prank(SCREENER);
        tokens.setSellOnly(address(tokA));
        SwapParamsV3 memory buy = params(address(usdc), address(tokA), 1e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotBuyable.selector, address(tokA)));
        swap(buy);
        swap(params(address(tokA), address(usdc), 2e18));
        vm.prank(SCREENER);
        tokens.freeze(address(tokA));
        SwapParamsV3 memory sale = params(address(tokA), address(usdc), 2e18);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotSellable.selector, address(tokA)));
        swap(sale);
        vm.prank(owner);
        account.withdraw(address(tokA), 48e18, owner);
        assertEq(tokA.balanceOf(owner), 48e18);
    }

    function test_TradingFailsClosedOnTheOracle_WithdrawalDoesNot() public {
        tradingAccount();
        vm.warp(block.timestamp + 3_900);
        monUsd.push(2e8);
        usdcUsd.push(1e8);
        bRate.push(20e18);
        SwapParamsV3 memory buy = params(address(usdc), address(tokA), 1e6);
        bytes memory stale =
            abi.encodeWithSelector(OracleAdapterV3.PriceUnavailable.selector, address(tokA), PriceReason.STALE);
        vm.expectRevert(stale);
        swap(buy);
        vm.expectRevert(stale);
        account.navUsdc();
        vm.expectRevert(stale);
        account.poke();
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 600e6);
        assertEq(tokA.balanceOf(owner), 50e18);
    }

    function test_ClearingTheExecutorStopsTradingAtOnce() public {
        tradingAccount();
        vm.prank(guardian);
        factory.clearExecutor();
        SwapParamsV3 memory p = params(address(usdc), address(tokA), 1e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotExecutor.selector, address(executor)));
        swap(p);
    }

    function test_ACreditCannotBeTraded() public {
        tradingAccount();
        usdc.setBlocked(owner, true);
        vm.prank(owner);
        account.withdrawAll(owner);
        usdc.setBlocked(owner, false);
        assertEq(account.claimable(address(usdc), owner), 600e6);
        SwapParamsV3 memory p = params(address(usdc), address(tokA), 1e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.InsufficientFree.selector, address(usdc), 0));
        swap(p);
    }

    function test_ASeventeenthTokenCannotBeBought() public {
        tradingAccount();
        MockToken[] memory more = coreTokens(14);
        for (uint256 i = 0; i < 14; ++i) {
            deposit(more[i], 1e18);
        }
        assertEq(account.heldCount(), 16);
        SwapParamsV3 memory p = params(address(usdc), address(tokB), 40e6);
        vm.expectRevert(CustodyCoreV3.TooManyHeldTokens.selector);
        swap(p);
        // Selling one entirely frees its slot for the buy.
        swap(params(address(more[0]), address(usdc), 1e18));
        swap(params(address(usdc), address(tokB), 40e6));
        assertEq(account.heldCount(), 16);
    }

    /// A trade with sixteen tokens held stays well inside a block (gas measured in the report).
    function test_ATradeAcrossSixteenHeldTokensFits() public {
        tradingAccount();
        MockToken[] memory more = coreTokens(14);
        for (uint256 i = 0; i < 14; ++i) {
            deposit(more[i], 1e18);
        }
        uint256 gasBefore = gasleft();
        swap(params(address(usdc), address(tokA), 10e6));
        uint256 used = gasBefore - gasleft();
        assertLt(used, 3_000_000, "a 16-token trade under 3M gas");
    }
}
