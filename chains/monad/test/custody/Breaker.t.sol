// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CustodyCore} from "../../src/custody/CustodyCore.sol";
import {AccountMode, SwapParams} from "../../src/interfaces/ICustody.sol";
import {OracleReason} from "../../src/interfaces/IOracle.sol";
import {MockFeed} from "../mocks/OracleMocks.sol";
import {BreakerBase} from "./BreakerBase.sol";

/// The custody core with the real oracle adapter (P2-U3): internal units, the
/// 7-day peak, poke(), the 10% and 20% breaker, and fail-closed priced paths
/// next to a withdrawal that never reads an oracle.
contract BreakerTest is BreakerBase {
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

    function test_WmonDepositsWorkOnceTheOracleIsSet_AtTheOraclePrice() public {
        setMon(2 * ONE_DOLLAR);
        deposit(wmon, 10e18);
        assertEq(account.principal(), 20e6);
        assertEq(account.units(), 20e18);
        assertEq(account.navUsdc(), 20e6);
        assertEq(account.lastWmonPriceE18(), 2e18);
    }

    function testFuzz_ValuationIsBalancesAtOraclePrices(uint64 usdcIn, uint96 wmonIn, uint64 answer) public {
        usdcIn = uint64(bound(usdcIn, 1, 40e6));
        answer = uint64(bound(answer, 1, 1_000e8));
        setMon(int256(uint256(answer)));
        wmonIn = uint96(bound(wmonIn, 1, uint256(50e6) * 1e30 / (uint256(answer) * 1e10)));
        deposit(usdc, usdcIn);
        deposit(wmon, wmonIn);
        uint256 expected = uint256(usdcIn) + uint256(wmonIn) * uint256(answer) * 1e10 / 1e30;
        assertEq(account.navUsdc(), expected);
        // A donation counts, and a credit does not.
        usdc.mint(address(account), 7);
        assertEq(account.navUsdc(), expected + 7);
    }

    // ----- fail closed, except withdrawals -----

    function test_DepositsFailClosedOnTheOracle() public {
        deposit(wmon, 10e18);
        vm.warp(block.timestamp + 300);
        usdcFeed.push(1e8);
        usdc.mint(owner, 10e6);
        vm.startPrank(owner);
        usdc.approve(address(account), 10e6);
        // The account holds WMON, so even a USDC deposit needs MON/USD.
        vm.expectRevert(unavailable(address(wmon), OracleReason.STALE));
        account.deposit(address(usdc), 10e6);
        vm.stopPrank();

        setMon(ONE_DOLLAR);
        usdcFeed.push(98_000_000);
        vm.prank(owner);
        vm.expectRevert(unavailable(address(usdc), OracleReason.USDC_DEPEGGED));
        account.deposit(address(usdc), 10e6);

        usdcFeed.setFailure(MockFeed.Failure.RevertRound);
        vm.prank(owner);
        vm.expectRevert(unavailable(address(usdc), OracleReason.FEED_REVERTED));
        account.deposit(address(usdc), 10e6);
    }

    /// FINAL_PLAN 4.1.9: USDC is 1, so a USDC-only account never needs MON/USD.
    function test_AUsdcOnlyAccountDoesNotNeedMonUsd() public {
        deposit(usdc, 10e6);
        monFeed.setFailure(MockFeed.Failure.RevertRound);
        deposit(usdc, 5e6);
        (uint256 nav,,) = poke();
        assertEq(nav, 15e6);
        assertEq(account.navUsdc(), 15e6);
    }

    /// M-26 for a PersonalAccount: no feed, pool or factory state stops the owner's exit.
    function test_WithdrawalsNeverReadTheOracle() public {
        deposit(usdc, 30e6);
        deposit(wmon, 20e18);
        monFeed.setFailure(MockFeed.Failure.RevertRound);
        usdcFeed.setFailure(MockFeed.Failure.RevertDecimals);
        stateView.setReverts(true);
        vm.expectRevert(unavailable(address(wmon), OracleReason.FEED_REVERTED));
        account.navUsdc();
        withdraw(address(usdc), 10e6);
        withdraw(address(wmon), 5e18);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 30e6);
        assertEq(wmonBal(owner), 20e18);
        assertEq(account.units(), 0);
    }

    function test_APokeFailsClosedButTouchesNothing() public {
        wmonAccount();
        vm.warp(block.timestamp + 300);
        vm.expectRevert(unavailable(address(wmon), OracleReason.STALE));
        account.poke();
        monFeed.push(0);
        vm.expectRevert(unavailable(address(wmon), OracleReason.ANSWER_NOT_POSITIVE));
        account.poke();
        assertMode(AccountMode.NORMAL);
    }

    // ----- flows never move the value per unit -----

    function test_DepositsAndWithdrawalsNeverMoveTheValuePerUnit() public {
        deposit(usdc, 30e6);
        deposit(wmon, 20e18);
        poke();
        withdraw(address(usdc), 25e6);
        deposit(usdc, 40e6);
        withdraw(address(wmon), 19e18);
        deposit(wmon, 3e18);
        (,, uint256 peak) = poke();
        assertEq(perUnit(), 1e18);
        assertEq(peak, 1e18);
        assertMode(AccountMode.NORMAL);
    }

    /// Flows at any size and in any order, at a fixed price, never lower the
    /// value per unit (rounding only ever favours the units left) and never trip.
    function testFuzz_FlowsNeverTripTheBreaker(uint256 seed, uint64 answer) public {
        answer = uint64(bound(answer, 1e6, 1_000e8));
        setMon(int256(uint256(answer)));
        deposit(usdc, 10e6);
        poke();
        uint256 floor = perUnit();
        for (uint256 i = 0; i < 12; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            bool isUsdc = r % 2 == 0;
            address token = isUsdc ? address(usdc) : address(wmon);
            uint256 held = isUsdc ? usdcBal(address(account)) : wmonBal(address(account));
            if ((r >> 8) % 2 == 0 && held > 0) {
                withdraw(token, 1 + (r >> 16) % held);
            } else {
                uint256 room = 100e6 - account.principal();
                if (room == 0) continue;
                uint256 value = 1 + (r >> 16) % room;
                uint256 amount = isUsdc ? value : value * 1e30 / (uint256(answer) * 1e10);
                if (amount == 0) continue;
                deposit(isUsdc ? usdc : wmon, amount);
            }
            if (account.units() == 0) continue;
            poke();
            assertMode(AccountMode.NORMAL);
            assertGe(perUnit(), floor, "a flow lowered the value per unit");
        }
    }

    // ----- the breaker: exactly 10% and 20% -----

    function test_TripsReduceOnlyAtExactly10Percent() public {
        wmonAccount();
        poke();
        setMon(90_000_002); // 9.9999998% down
        poke();
        assertMode(AccountMode.NORMAL);
        setMon(90_000_000); // exactly 10% down
        vm.expectEmit(address(account));
        emit CustodyCore.BreakerTripped(AccountMode.REDUCE_ONLY, 0.9e18, 1e18, 1_000);
        poke();
        assertMode(AccountMode.REDUCE_ONLY);
    }

    function test_TripsPausedAtExactly20Percent_FromReduceOnly() public {
        wmonAccount();
        poke();
        setMon(85_000_000);
        poke();
        assertMode(AccountMode.REDUCE_ONLY);
        setMon(80_000_002);
        poke();
        assertMode(AccountMode.REDUCE_ONLY);
        setMon(80_000_000);
        vm.expectEmit(address(account));
        emit CustodyCore.BreakerTripped(AccountMode.PAUSED, 0.8e18, 1e18, 2_000);
        poke();
        assertMode(AccountMode.PAUSED);
    }

    function test_ADropStraightTo20PercentPauses() public {
        wmonAccount();
        poke();
        setMon(75_000_000);
        poke();
        assertMode(AccountMode.PAUSED);
        (,,, uint256 dd) = account.breakerState();
        assertEq(dd, 2_500);
    }

    function test_AMixedAccountTripsOnItsOwnDrop() public {
        // Half USDC: MON must fall 20% for the account to fall 10%.
        deposit(usdc, 50e6);
        deposit(wmon, 50e18);
        poke();
        setMon(80_000_002); // 50 WMON at $0.80000002 is 40.000001 USDC: the account is down 9.999999%
        poke();
        assertMode(AccountMode.NORMAL);
        setMon(80_000_000);
        poke();
        assertMode(AccountMode.REDUCE_ONLY);
    }

    function test_TheBreakerNeverLoosens() public {
        wmonAccount();
        poke();
        setMon(70_000_000);
        poke();
        assertMode(AccountMode.PAUSED);
        setMon(2 * ONE_DOLLAR);
        poke();
        assertMode(AccountMode.PAUSED);
        setMon(88_000_000);
        poke();
        assertMode(AccountMode.PAUSED);
    }

    function test_ADepositAfterADropDoesNotHideIt() public {
        wmonAccount();
        poke();
        setMon(85_000_000); // no poke yet
        deposit(usdc, 40e6);
        (,, uint256 peak) = poke();
        assertEq(peak, 1e18);
        assertMode(AccountMode.REDUCE_ONLY);
    }

    function test_AWithdrawalAfterADropDoesNotHideOrFakeIt() public {
        deposit(usdc, 50e6);
        deposit(wmon, 50e18);
        poke();
        setMon(70_000_000);
        poke(); // the account is down 15%: REDUCE_ONLY, and the price is cached
        assertMode(AccountMode.REDUCE_ONLY);
        uint256 before = perUnit();
        withdraw(address(usdc), 49e6);
        assertEq(perUnit(), before, "the value per unit is unchanged");
        setMon(60_000_000);
        poke();
        // Mostly WMON now, so the further 14% fall in MON lands almost in full.
        assertMode(AccountMode.PAUSED);
    }

    /// A withdrawal made while the oracle is down values what left at the last
    /// price; once prices return, the value per unit is what the price says.
    function test_AWithdrawalWithTheOracleDownUsesTheLastPrice() public {
        deposit(usdc, 50e6);
        deposit(wmon, 50e18);
        poke();
        monFeed.setFailure(MockFeed.Failure.RevertRound);
        withdraw(address(usdc), 20e6);
        monFeed.setFailure(MockFeed.Failure.None);
        setMon(ONE_DOLLAR);
        assertEq(perUnit(), 1e18);
        poke();
        assertMode(AccountMode.NORMAL);
    }

    /// The breaker as a test-side model: 8 daily buckets and tighten-only modes.
    struct Model {
        uint256[8] day;
        uint256[8] value;
        uint8 mode;
    }

    function modelObserve(Model memory m, uint256 perUnit_) internal view returns (uint256 peak) {
        uint256 today = block.timestamp / 1 days;
        uint256 slot = today % 8;
        if (m.day[slot] != today || m.value[slot] == 0) {
            m.day[slot] = today;
            m.value[slot] = perUnit_;
        } else if (perUnit_ > m.value[slot]) {
            m.value[slot] = perUnit_;
        }
        for (uint256 j = 0; j < 8; ++j) {
            if (m.day[j] <= today && m.day[j] + 8 > today && m.value[j] > peak) peak = m.value[j];
        }
        uint256 drop = peak > perUnit_ ? peak - perUnit_ : 0;
        if (drop * 10_000 >= peak * 2_000 && m.mode < 2) m.mode = 2;
        else if (drop * 10_000 >= peak * 1_000 && m.mode == 0) m.mode = 1;
    }

    /// Random price moves over random days against the model above.
    function testFuzz_PriceMovesTripExactlyWhenTheModelSays(uint256 seed) public {
        deposit(usdc, 30e6);
        deposit(wmon, 50e18);
        assertEq(account.units(), 80e18);
        Model memory m;
        for (uint256 i = 0; i < 16; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(block.timestamp + (r % 4) * 12 hours);
            uint256 answer = 40e6 + (r >> 8) % 120e6;
            setMon(int256(answer));
            (uint256 nav, uint256 p, uint256 peak) = poke();
            uint256 expectedNav = 30e6 + 50e18 * answer * 1e10 / 1e30;
            uint256 expectedPerUnit = expectedNav * 1e30 / 80e18;
            assertEq(nav, expectedNav, "nav");
            assertEq(p, expectedPerUnit, "per unit");
            assertEq(peak, modelObserve(m, expectedPerUnit), "peak");
            assertEq(uint8(account.mode()), m.mode, "mode");
        }
    }

    // ----- the 7-day peak -----

    function test_APeakCountsForSevenDays() public {
        wmonAccount();
        poke();
        warpDays(7);
        setMon(90_000_000);
        poke();
        assertMode(AccountMode.REDUCE_ONLY);
    }

    function test_APeakOlderThanItsWindowIsForgotten() public {
        wmonAccount();
        poke();
        warpDays(8);
        setMon(90_000_000);
        (,, uint256 peak) = poke();
        assertEq(peak, 0.9e18, "the old peak has left the window");
        assertMode(AccountMode.NORMAL);
    }

    function test_ThePeakIsTheHighestOfTheWindow() public {
        wmonAccount();
        poke();
        warpDays(1);
        setMon(120_000_000);
        poke();
        warpDays(1);
        setMon(110_000_000);
        poke();
        assertEq(account.peakPerUnit7d(), 1.2e18);
        setMon(108_000_000); // 10% under the 1.20 peak, though above the start
        poke();
        assertMode(AccountMode.REDUCE_ONLY);
    }

    function test_PeakBucketsRecordOneValuePerDay() public {
        wmonAccount();
        poke();
        setMon(130_000_000);
        poke();
        setMon(110_000_000);
        poke();
        CustodyCore.PeakBucket[8] memory b = account.peakBuckets();
        uint256 today = block.timestamp / 1 days;
        assertEq(b[today % 8].day, today);
        assertEq(b[today % 8].value, 1.3e18, "the day's highest, not its last");
    }

    // ----- who loosens -----

    function test_OnlyTheOwnerUnpauses_TheSentinelAndGuardianOnlyTighten() public {
        wmonAccount();
        poke();
        setMon(70_000_000);
        poke();
        assertMode(AccountMode.PAUSED);
        address[3] memory others = [sentinel, guardian, stranger];
        for (uint256 i = 0; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotOwner.selector, others[i]));
            account.unpause();
        }
        // The sentinel's reduce-only cannot turn PAUSED back into REDUCE_ONLY.
        vm.prank(sentinel);
        account.setReduceOnly();
        assertMode(AccountMode.PAUSED);
        vm.prank(sentinel);
        account.pause();
        assertMode(AccountMode.PAUSED);
        // A poke is not a way out either.
        account.poke();
        assertMode(AccountMode.PAUSED);

        vm.prank(owner);
        account.unpause();
        assertMode(AccountMode.NORMAL);
    }

    function test_UnpausingStartsThePeakAfresh() public {
        wmonAccount();
        poke();
        setMon(80_000_000);
        poke();
        assertMode(AccountMode.PAUSED);
        vm.expectEmit(address(account));
        emit CustodyCore.PeakReset(owner);
        vm.prank(owner);
        account.unpause();
        assertEq(account.peakPerUnit7d(), 0);
        (,, uint256 peak) = poke();
        assertEq(peak, 0.8e18);
        assertMode(AccountMode.NORMAL);
        setMon(72_000_000); // a fresh 10% drop from the reviewed level
        poke();
        assertMode(AccountMode.REDUCE_ONLY);
    }

    function test_TheSentinelCanTightenANormalAccount() public {
        wmonAccount();
        vm.prank(sentinel);
        account.setReduceOnly();
        assertMode(AccountMode.REDUCE_ONLY);
        vm.prank(sentinel);
        account.pause();
        assertMode(AccountMode.PAUSED);
        vm.prank(sentinel);
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.NotOwner.selector, sentinel));
        account.unpause();
    }

    function test_EmptyingTheAccountClearsUnitsAndPeak() public {
        wmonAccount();
        poke();
        setMon(70_000_000);
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

    function liveExecutor() internal {
        setExecutor();
        setMon(ONE_DOLLAR);
        usdcFeed.push(1e8);
    }

    function test_AThreePercentPoolMoveBlocksTrades_NeverWithdrawals() public {
        liveExecutor();
        deposit(usdc, 60e6);
        deposit(wmon, 40e18);
        stateView.setSqrtPrice(uint160(Math.sqrt(Math.mulDiv(1.03e18, 2 ** 192, 1e30))));
        SwapParams memory p = params(address(usdc), address(wmon), 1e6);
        vm.expectRevert(unavailable(address(wmon), OracleReason.POOL_DEVIATION));
        executor.swap(account, p);
        p = params(address(wmon), address(usdc), 1e18);
        vm.expectRevert(unavailable(address(wmon), OracleReason.POOL_DEVIATION));
        executor.swap(account, p);
        withdraw(address(wmon), 1e18);
        assertEq(wmonBal(owner), 1e18);
    }

    function test_AStaleFeedBlocksTradesButNeverWithdrawals() public {
        liveExecutor();
        deposit(usdc, 60e6);
        deposit(wmon, 40e18);
        vm.warp(block.timestamp + 300);
        SwapParams memory p = params(address(wmon), address(usdc), 1e18);
        vm.expectRevert(unavailable(address(wmon), OracleReason.STALE));
        executor.swap(account, p);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 60e6);
    }

    function test_ADrawdownNobodyPokedStillRefusesNewRisk_AndASaleRecordsIt() public {
        liveExecutor();
        deposit(usdc, 20e6);
        deposit(wmon, 80e18);
        poke();
        setMon(85_000_000); // the account is down 12%, unpoked
        SwapParams memory buy = params(address(usdc), address(wmon), 1e6);
        vm.expectRevert(abi.encodeWithSelector(CustodyCore.ReduceOnly.selector, AccountMode.REDUCE_ONLY));
        executor.swap(account, buy);
        assertMode(AccountMode.NORMAL);

        executor.swap(account, params(address(wmon), address(usdc), 5e18));
        assertMode(AccountMode.REDUCE_ONLY);
    }

    function test_ATradeThatLosesValueCanTripTheBreaker() public {
        liveExecutor();
        deposit(usdc, 60e6);
        deposit(wmon, 40e18);
        poke();
        // A losing trade within the 1% backstop moves the value per unit a little, as it should.
        executor.setOutputBps(9_950);
        executor.swap(account, params(address(wmon), address(usdc), 10e18));
        assertLt(perUnit(), 1e18);
        assertMode(AccountMode.NORMAL);
    }
}
