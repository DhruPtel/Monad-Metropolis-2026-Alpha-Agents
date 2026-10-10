// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {AccountMode} from "../../src/interfaces/ICustody.sol";
import {SwapParamsV3} from "../../src/interfaces/ICustodyV3.sol";
import {PriceReason} from "../../src/interfaces/IFund.sol";
import {MockToken, RevertingLedger} from "../mocks/CustodyMocks.sol";
import {MockFeed} from "../mocks/OracleMocks.sol";
import {CustodyV3Base} from "./CustodyV3Base.sol";

/// The breaker across the whole portfolio (F-U3, D-233): internal units over
/// many tokens, class A at its attested price and then at zero, the 7-day
/// peak, and withdrawals that value what left at the last prices, reading no oracle.
contract CustodyV3BreakerTest is CustodyV3Base {
    function perUnit() internal view returns (uint256 p) {
        (, p,,) = account.breakerState();
    }

    function poke() internal returns (uint256 nav, uint256 p, uint256 peak) {
        return account.poke();
    }

    /// Moves A's USD feed (8 decimals) with a fresh round; the executor's quotes follow.
    function setA(int256 answer) internal {
        aUsd.push(answer);
        executor.setPrice(address(tokA), uint256(answer) * 1e10);
    }

    function warpDays(uint256 d) internal {
        vm.warp(block.timestamp + d * 1 days);
        refreshFeeds();
    }

    function withdraw(address token, uint256 amount) internal {
        vm.prank(owner);
        account.withdraw(token, amount, owner);
    }

    // ----- units and valuation -----

    function test_TheFirstDepositMintsOneUnitPerUsdc() public {
        deposit(usdc, 40e6);
        assertEq(account.units(), 40e18);
        (uint256 nav, uint256 p, uint256 peak, uint256 dd) = account.breakerState();
        assertEq(nav, 40e6);
        assertEq(p, 1e18);
        assertEq(peak, 1e18);
        assertEq(dd, 0);
    }

    function test_ManyTokensAreValuedAtTheirOwnPrices() public {
        deposit(usdc, 100e6);
        deposit(tokA, 10e18); // 60
        deposit(tokB, 2e8); // 80
        depositWmon(5e18); // 10
        assertEq(account.navUsdc(), 250e6);
        assertEq(account.units(), 250e18);
        assertEq(perUnit(), 1e18);
        // A moves: only A's share of the value moves.
        setA(12e8);
        assertEq(account.navUsdc(), 310e6);
        monUsd.push(4e8); // MON doubles: WMON and the composite B double
        assertEq(account.navUsdc(), 100e6 + 120e6 + 160e6 + 20e6);
    }

    function testFuzz_ValuationIsBalancesAtOraclePrices(uint64 usdcIn, uint96 aIn, uint64 bIn, uint64 answer) public {
        usdcIn = uint64(bound(usdcIn, 1, 200e6));
        answer = uint64(bound(answer, 1e6, 1_000e8));
        setA(int256(uint256(answer)));
        aIn = uint96(bound(aIn, 1, uint256(300e6) * 1e30 / (uint256(answer) * 1e10)));
        bIn = uint64(bound(bIn, 1, 5e8));
        deposit(usdc, usdcIn);
        deposit(tokA, aIn);
        deposit(tokB, bIn);
        uint256 expected = uint256(usdcIn) + uint256(aIn) * uint256(answer) * 1e10 / 1e30 + uint256(bIn) * 40e18 / 1e20;
        assertEq(account.navUsdc(), expected);
        // A donation counts, and a credit does not.
        usdc.mint(address(account), 7);
        assertEq(account.navUsdc(), expected + 7);
    }

    // ----- fail closed, except withdrawals -----

    /// M-26 for a PersonalAccount: no feed, pool, registry or factory state stops the owner's exit.
    function test_WithdrawalsNeverReadTheOracle() public {
        deposit(usdc, 30e6);
        deposit(tokA, 20e18);
        deposit(tokB, 1e8);
        aUsd.setFailure(MockFeed.Failure.RevertRound);
        monUsd.setFailure(MockFeed.Failure.RevertDecimals);
        vm.etch(address(oracle), address(new RevertingLedger()).code);
        vm.etch(address(tokens), address(new RevertingLedger()).code);
        vm.expectRevert();
        account.navUsdc();
        withdraw(address(usdc), 10e6);
        withdraw(address(tokA), 5e18);
        withdraw(address(tokB), 1e7);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 30e6);
        assertEq(tokA.balanceOf(owner), 20e18);
        assertEq(tokB.balanceOf(owner), 1e8);
        assertEq(account.units(), 0);
    }

    function test_APokeFailsClosedButTouchesNothing() public {
        deposit(tokA, 50e18);
        vm.warp(block.timestamp + 3_900);
        monUsd.push(2e8);
        usdcUsd.push(1e8);
        vm.expectRevert(
            abi.encodeWithSelector(OracleAdapterV3.PriceUnavailable.selector, address(tokA), PriceReason.STALE)
        );
        account.poke();
        aUsd.push(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                OracleAdapterV3.PriceUnavailable.selector, address(tokA), PriceReason.ANSWER_NOT_POSITIVE
            )
        );
        account.poke();
        assertMode(AccountMode.NORMAL);
    }

    // ----- flows never move the value per unit -----

    function test_DepositsAndWithdrawalsNeverMoveTheValuePerUnit() public {
        deposit(usdc, 30e6);
        deposit(tokA, 20e18);
        deposit(tokB, 1e8);
        poke();
        withdraw(address(usdc), 25e6);
        deposit(usdc, 40e6);
        withdraw(address(tokA), 19e18);
        deposit(tokB, 3e8);
        withdraw(address(tokB), 2e8);
        depositWmon(3e18);
        (,, uint256 peak) = poke();
        assertEq(perUnit(), 1e18);
        assertEq(peak, 1e18);
        assertMode(AccountMode.NORMAL);
    }

    /// Flows of any token, at any size and in any order, at fixed prices never
    /// lower the value per unit (rounding only ever favours the units left) and never trip.
    function testFuzz_FlowsNeverTripTheBreaker(uint256 seed, uint64 answer) public {
        answer = uint64(bound(answer, 1e6, 1_000e8));
        setA(int256(uint256(answer)));
        deposit(usdc, 10e6);
        poke();
        uint256 floor = perUnit();
        MockToken[3] memory toks = [usdc, tokA, tokB];
        uint256[3] memory px = [uint256(1e18), uint256(answer) * 1e10, uint256(40e18)];
        uint256[3] memory unit = [uint256(1e6), uint256(1e18), uint256(1e8)];
        for (uint256 i = 0; i < 12; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 k = r % 3;
            uint256 held = toks[k].balanceOf(address(account));
            if ((r >> 8) % 2 == 0 && held > 0) {
                withdraw(address(toks[k]), 1 + (r >> 16) % held);
            } else {
                uint256 room = PERSONAL_CAP - account.principal();
                if (room == 0) continue;
                uint256 value = 1 + (r >> 16) % room;
                uint256 amount = value * unit[k] * 1e12 / px[k];
                if (amount == 0) continue;
                deposit(toks[k], amount);
            }
            if (account.units() == 0) continue;
            poke();
            assertMode(AccountMode.NORMAL);
            assertGe(perUnit(), floor, "a flow lowered the value per unit");
        }
    }

    // ----- the breaker: exactly 10% and 20% -----

    function test_TripsReduceOnlyAtExactly10Percent() public {
        deposit(tokA, 50e18); // 300 USDC
        poke();
        setA(540_000_002); // 9.9999997% down
        poke();
        assertMode(AccountMode.NORMAL);
        setA(540_000_000); // exactly 10% down
        vm.expectEmit(address(account));
        emit CustodyCoreV3.BreakerTripped(AccountMode.REDUCE_ONLY, 0.9e18, 1e18, 1_000);
        poke();
        assertMode(AccountMode.REDUCE_ONLY);
    }

    function test_TripsPausedAtExactly20Percent_FromReduceOnly() public {
        deposit(tokA, 50e18);
        poke();
        setA(510_000_000);
        poke();
        assertMode(AccountMode.REDUCE_ONLY);
        setA(480_000_002);
        poke();
        assertMode(AccountMode.REDUCE_ONLY);
        setA(480_000_000);
        vm.expectEmit(address(account));
        emit CustodyCoreV3.BreakerTripped(AccountMode.PAUSED, 0.8e18, 1e18, 2_000);
        poke();
        assertMode(AccountMode.PAUSED);
    }

    function test_AMixedAccountTripsOnItsOwnDrop() public {
        // A is 300 of 600: A must fall 20% for the account to fall 10%.
        deposit(usdc, 300e6);
        deposit(tokA, 50e18);
        poke();
        setA(480_000_002);
        poke();
        assertMode(AccountMode.NORMAL);
        setA(480_000_000);
        poke();
        assertMode(AccountMode.REDUCE_ONLY);
    }

    function test_TheBreakerNeverLoosens() public {
        deposit(tokA, 50e18);
        poke();
        setA(4e8);
        poke();
        assertMode(AccountMode.PAUSED);
        setA(12e8);
        poke();
        assertMode(AccountMode.PAUSED);
    }

    function test_ADepositAfterADropDoesNotHideIt() public {
        deposit(tokA, 50e18);
        poke();
        setA(5e8); // no poke yet
        deposit(usdc, 40e6);
        (,, uint256 peak) = poke();
        assertEq(peak, 1e18);
        assertMode(AccountMode.REDUCE_ONLY);
    }

    function test_AWithdrawalAfterADropDoesNotHideOrFakeIt() public {
        deposit(usdc, 300e6);
        deposit(tokA, 50e18);
        poke();
        setA(4.2e8);
        poke(); // the account is down 15%: REDUCE_ONLY, and A's price is cached
        assertMode(AccountMode.REDUCE_ONLY);
        uint256 before = perUnit();
        withdraw(address(usdc), 299e6);
        assertEq(perUnit(), before, "the value per unit is unchanged");
        setA(3.6e8);
        poke();
        assertMode(AccountMode.PAUSED);
    }

    /// A withdrawal made while a feed is down values what left at the last
    /// price; once prices return, the value per unit is what the prices say.
    function test_AWithdrawalWithTheOracleDownUsesTheLastPrices() public {
        deposit(usdc, 300e6);
        deposit(tokA, 50e18);
        deposit(tokB, 1e8);
        poke();
        aUsd.setFailure(MockFeed.Failure.RevertRound);
        monUsd.setFailure(MockFeed.Failure.RevertRound);
        withdraw(address(usdc), 20e6);
        withdraw(address(tokB), 5e7);
        aUsd.setFailure(MockFeed.Failure.None);
        monUsd.setFailure(MockFeed.Failure.None);
        assertEq(perUnit(), 1e18);
        poke();
        assertMode(AccountMode.NORMAL);
    }

    // ----- class A in the breaker (D-337) -----

    /// A class A token counts at its attested price; a day without one and it
    /// counts as zero, which can only tighten; a fresh attestation through
    /// `poke` values it again but never loosens the mode.
    function test_AClassATokenCountsAtItsAttestedPriceThenAtZeroAfterADay() public {
        tradingAccount();
        swap(attested(address(usdc), address(tokC), 100e6));
        swap(attested(address(usdc), address(tokC), 35e6)); // 135 of 900 in C
        (uint256 nav,,) = poke();
        assertEq(nav, 900e6);
        vm.warp(block.timestamp + 1 days - 1);
        refreshFeeds();
        (nav,,) = poke();
        assertEq(nav, 900e6, "still counted a second under a day");
        assertMode(AccountMode.NORMAL);
        vm.warp(block.timestamp + 1);
        refreshFeeds();
        (nav,,) = poke();
        assertEq(nav, 765e6, "counted at zero from a day on");
        assertMode(AccountMode.REDUCE_ONLY);
        assertEq(account.navUsdc(), 765e6);
        // A fresh attestation values it again; the mode stays until the owner reviews.
        address[] memory t = one(address(tokC));
        bytes[] memory atts = new bytes[](1);
        atts[0] = attestation(address(tokC), PX_C);
        vm.expectEmit(address(account));
        emit CustodyCoreV3.AttestedPriceUsed(address(tokC), PX_C);
        (nav,,) = account.poke(t, atts);
        assertEq(nav, 900e6);
        assertMode(AccountMode.REDUCE_ONLY);
        (uint256 px, uint64 pricedAt) = account.lastPrice(address(tokC));
        assertEq(px, PX_C);
        assertEq(pricedAt, block.timestamp);
        vm.prank(owner);
        account.unpause();
        assertMode(AccountMode.NORMAL);
    }

    function test_PokeChecksItsAttestations() public {
        tradingAccount();
        swap(attested(address(usdc), address(tokC), 100e6));
        address[] memory t = one(address(tokC));
        bytes[] memory none = new bytes[](0);
        vm.expectRevert(CustodyCoreV3.LengthMismatch.selector);
        account.poke(t, none);
        bytes[] memory atts = new bytes[](1);
        attestor.set(address(tokC), PX_C, uint64(block.timestamp - 1));
        atts[0] = abi.encode(address(tokC));
        vm.expectRevert(abi.encodeWithSelector(OracleAdapterV3.BadAttestation.selector, address(tokC)));
        account.poke(t, atts);
        // An attestation for a class F token is ignored: its feed prices it.
        t[0] = address(tokA);
        atts[0] = attestation(address(tokA), 1e18);
        (uint256 nav,,) = account.poke(t, atts);
        assertEq(nav, 900e6);
    }

    // ----- the 7-day peak -----

    function test_APeakCountsForSevenDays() public {
        deposit(tokA, 50e18);
        poke();
        warpDays(7);
        setA(5.4e8);
        poke();
        assertMode(AccountMode.REDUCE_ONLY);
    }

    function test_APeakOlderThanItsWindowIsForgotten() public {
        deposit(tokA, 50e18);
        poke();
        warpDays(8);
        setA(5.4e8);
        (,, uint256 peak) = poke();
        assertEq(peak, 0.9e18, "the old peak has left the window");
        assertMode(AccountMode.NORMAL);
    }

    function test_ThePeakIsTheHighestOfTheWindow() public {
        deposit(tokA, 50e18);
        poke();
        warpDays(1);
        setA(7.2e8);
        poke();
        warpDays(1);
        setA(6.6e8);
        poke();
        assertEq(account.peakPerUnit7d(), 1.2e18);
        setA(6.48e8); // 10% under the 1.20 peak, though above the start
        poke();
        assertMode(AccountMode.REDUCE_ONLY);
    }

    // ----- who loosens -----

    function test_OnlyTheOwnerUnpauses_AndUnpausingStartsThePeakAfresh() public {
        deposit(tokA, 50e18);
        poke();
        setA(4.2e8);
        poke();
        assertMode(AccountMode.PAUSED);
        address[3] memory others = [sentinel, guardian, stranger];
        for (uint256 i = 0; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.NotOwner.selector, others[i]));
            account.unpause();
        }
        account.poke();
        assertMode(AccountMode.PAUSED);
        vm.expectEmit(address(account));
        emit CustodyCoreV3.PeakReset(owner);
        vm.prank(owner);
        account.unpause();
        assertEq(account.peakPerUnit7d(), 0);
        (,, uint256 peak) = poke();
        assertEq(peak, 0.7e18);
        assertMode(AccountMode.NORMAL);
        setA(3.78e8); // a fresh 10% drop from the reviewed level
        poke();
        assertMode(AccountMode.REDUCE_ONLY);
    }

    function test_EmptyingTheAccountClearsUnitsAndPeak() public {
        deposit(tokA, 50e18);
        deposit(tokB, 1e8);
        poke();
        setA(4.2e8);
        poke();
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(account.units(), 0);
        assertEq(account.peakPerUnit7d(), 0);
        assertMode(AccountMode.PAUSED);
        vm.prank(owner);
        account.unpause();
        deposit(usdc, 10e6);
        assertEq(account.units(), 10e18);
        assertEq(perUnit(), 1e18);
    }

    function test_APokeOnAnEmptyAccountRecordsNothing() public {
        (uint256 nav, uint256 p, uint256 peak) = poke();
        assertEq(nav + p + peak, 0);
    }

    // ----- trades -----

    function test_ADrawdownNobodyPokedStillRefusesNewRisk_AndASaleRecordsIt() public {
        tradingAccount();
        poke();
        setA(4.2e8); // A is down 30%: the account is down 10%, unpoked
        SwapParamsV3 memory buy = params(address(usdc), address(tokA), 1e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCoreV3.ReduceOnly.selector, AccountMode.REDUCE_ONLY));
        swap(buy);
        assertMode(AccountMode.NORMAL);
        swap(params(address(tokA), address(usdc), 5e18));
        assertMode(AccountMode.REDUCE_ONLY);
    }

    function test_ATradeThatLosesValueMovesTheValuePerUnit() public {
        tradingAccount();
        poke();
        executor.setOutputBps(9_950);
        swap(params(address(tokA), address(usdc), 10e18));
        assertLt(perUnit(), 1e18);
        assertMode(AccountMode.NORMAL);
    }
}
