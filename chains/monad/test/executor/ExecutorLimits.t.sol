// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Executor} from "../../src/executor/Executor.sol";
import {AccountMode} from "../../src/interfaces/ICustody.sol";
import {Policy, Reason, SwapIntent} from "../../src/interfaces/IExecutor.sol";
import {ExecutorBase} from "./ExecutorBase.sol";

/// Every launch hard limit (FINAL_PLAN 6.3) at exactly its threshold and one
/// unit over, each with its reason code (P2-U2).
contract ExecutorLimitsTest is ExecutorBase {
    // ----- a valid swap -----

    function test_AValidBuyAndSaleExecute_AndFundsStayInTheAccount() public {
        uint256 out = submit(buy(5e6));
        assertEq(out, 5e18);
        assertEq(usdcOf(address(account)), 65e6);
        assertEq(wmonOf(address(account)), 35e18);
        out = submit(sell(5e18));
        assertEq(out, 5e6);
        assertEq(usdcOf(address(account)), 70e6);
        assertEq(wmonOf(address(account)), 30e18);
        assertEq(usdcOf(address(executor)) + wmonOf(address(executor)), 0, "the Executor keeps nothing");
        assertEq(usdcOf(address(venue)) + wmonOf(address(venue)), 0, "the venue keeps nothing");
        assertEq(usdc.allowance(address(account), address(venue)), 0);
        assertEq(usdc.allowance(address(executor), address(venue)), 0);
    }

    function test_EmitsTheTrade() public {
        SwapIntent memory i = buy(5e6);
        vm.expectEmit(address(executor));
        emit Executor.IntentExecuted(
            i.actionId, address(account), AGENT, address(usdc), address(wmon), 5e6, 5e18, 1e18, 100e6, 100e6
        );
        submit(i);
    }

    // ----- max 10% of account value per trade -----

    function test_TradeSize_ExactlyTenPercentPasses_OneUnitMoreIsRefused() public {
        submit(sell(10e18)); // $10.00 of $100
        holdings(70e6, 30e18);
        // 10 WMON and 1e12 wei is $10.000001.
        expectRejected(sell(10e18 + 1e12), Reason.TRADE_SIZE_EXCEEDED);
        submit(buy(10e6)); // a buy of exactly 10% (and exactly 40% WMON after)
    }

    // ----- max 40% in any non-USDC asset after the trade -----

    function test_Concentration_ExactlyFortyPercentPasses_OneUnitMoreIsRefused() public {
        holdings(65e6, 35e18);
        expectRejected(buy(5e6 + 1), Reason.CONCENTRATION_CAP);
        submit(buy(5e6));
        assertEq(wmonOf(address(account)), 40e18);
    }

    function test_ASaleIntoUsdcIsExemptFromConcentrationAndTheFloor() public {
        // 45% WMON is over the cap; selling some into USDC is still allowed.
        holdings(55e6, 45e18);
        submit(sell(4e18));
        assertEq(wmonOf(address(account)), 41e18);
    }

    // ----- at least 10% in USDC after the trade -----

    /// With two assets, 40% at most in WMON means 60% at least in USDC, and
    /// the custody core's own 45% backstop also holds, so the launch 10% floor
    /// cannot bind. Its rule is tested at its threshold under a stricter floor.
    function test_UsdcFloor_ExactlyTheFloorPasses_OneUnitLessIsRefused() public {
        Policy memory p = launchPolicy();
        p.minUsdcBps = 6_500;
        build(p);
        expectRejected(buy(5e6 + 1), Reason.USDC_FLOOR);
        submit(buy(5e6));
        assertEq(usdcOf(address(account)), 65e6, "exactly 65% USDC");
    }

    // ----- max 0.5% slippage against the oracle -----

    function test_Slippage_TheOracleFloorPasses_OneUnitUnderIsRefused() public {
        uint256 floor = floorFor(address(usdc), address(wmon), 5e6);
        assertEq(floor, 4.975e18, "5 USDC of WMON less 0.5%");
        expectRejected(intent(address(usdc), address(wmon), 5e6, floor - 1), Reason.SLIPPAGE_TOO_HIGH);
        // A fill at exactly the floor passes both the floor and the value-loss bound.
        venue.setOutputBps(9_950);
        submit(intent(address(usdc), address(wmon), 5e6, floor));
        assertEq(wmonOf(address(account)), 30e18 + floor);
    }

    function test_AFillBelowTheIntentsMinimumIsRefusedByTheAccount() public {
        venue.setOutputBps(9_949);
        SwapIntent memory i = buy(5e6);
        vm.prank(session);
        vm.expectRevert(); // the custody core's OutputTooLow
        executor.swap(i);
        assertEq(usdcOf(address(account)), 70e6, "nothing moved");
    }

    // ----- rolling 20 trades per 24 hours -----

    function test_TwentyTradesPerRollingDay_TheTwentyFirstIsRefused() public {
        uint256 t0 = block.timestamp;
        for (uint256 k = 0; k < 20; ++k) {
            submit(sell(1e18));
        }
        expectRejected(sell(1e18), Reason.DAILY_TRADE_LIMIT);
        vm.warp(t0 + 86_399);
        setMon(ONE_DOLLAR);
        expectRejected(sell(1e18), Reason.DAILY_TRADE_LIMIT);
        (, uint256 left, uint256 frees,) = executor.limits(address(account));
        assertEq(left, 0);
        assertEq(frees, t0 + 86_400);
        // Exactly 24 hours old no longer counts.
        vm.warp(t0 + 86_400);
        setMon(ONE_DOLLAR);
        submit(sell(1e18));
    }

    // ----- rolling 24-hour turnover of 100% of value -----

    function test_Turnover_ExactlyOneHundredPercentPasses_OneUnitMoreIsRefused() public {
        for (uint256 k = 0; k < 5; ++k) {
            submit(buy(10e6));
            submit(sell(10e18));
        }
        (,,, uint256 used) = executor.limits(address(account));
        assertEq(used, 100e6, "exactly 100% of the $100 account");
        expectRejected(sell(1e18), Reason.TURNOVER_CAP);
    }

    function test_TurnoverFreesAsTradesLeaveTheWindow() public {
        uint256 t0 = block.timestamp;
        for (uint256 k = 0; k < 5; ++k) {
            submit(buy(10e6));
            submit(sell(10e18));
        }
        vm.warp(t0 + 86_400);
        setMon(ONE_DOLLAR);
        submit(sell(10e18));
    }

    // ----- deadlines: at most 2 minutes ahead, never past -----

    function test_Deadline_TwoMinutesAheadPasses_OneSecondMoreIsTooFar() public {
        SwapIntent memory i = sell(1e18);
        i.deadline = uint64(block.timestamp + 121);
        expectRejected(i, Reason.DEADLINE_TOO_FAR);
        i.deadline = uint64(block.timestamp + 120);
        submit(i);
    }

    function test_Deadline_NowPasses_OneSecondAgoIsExpired() public {
        SwapIntent memory i = sell(1e18);
        i.deadline = uint64(block.timestamp - 1);
        expectRejected(i, Reason.DEADLINE_EXPIRED);
        i.deadline = uint64(block.timestamp);
        submit(i);
    }

    // ----- the oracle: freshness and the 2% pool rule -----

    function test_AStaleOracleIsRefused() public {
        SwapIntent memory i = sell(1e18);
        vm.warp(block.timestamp + 300);
        i.deadline = uint64(block.timestamp + 60);
        expectRejected(i, Reason.ORACLE_STALE);
        monFeed.push(0);
        expectRejected(i, Reason.ORACLE_STALE);
    }

    function test_APoolMoreThanTwoPercentFromTheOracleIsRefused() public {
        stateView.setSqrtPrice(uint160(Math.sqrt(Math.mulDiv(1.0201e18, 2 ** 192, 1e30))));
        expectRejected(sell(1e18), Reason.ORACLE_POOL_DEVIATION);
        stateView.setSqrtPrice(uint160(Math.sqrt(Math.mulDiv(1.0199e18, 2 ** 192, 1e30))));
        submit(sell(1e18));
        stateView.setReverts(true);
        expectRejected(sell(1e18), Reason.ORACLE_POOL_DEVIATION);
    }

    // ----- modes and the circuit breaker -----

    function test_ReduceOnlyAllowsOnlySalesIntoUsdc() public {
        vm.prank(sentinel);
        account.setReduceOnly();
        expectRejected(buy(1e6), Reason.REDUCE_ONLY_MODE);
        submit(sell(1e18));
    }

    function test_PausedAllowsNothing() public {
        vm.prank(sentinel);
        account.pause();
        expectRejected(buy(1e6), Reason.PAUSED);
        expectRejected(sell(1e18), Reason.PAUSED);
    }

    function test_ADrawdownNobodyPokedCountsAsItsMode() public {
        account.poke();
        setMon(80_000_000); // 30% WMON down 20%: the account is down 6%
        submit(sell(1e18));
        holdings(10e6, 90e18);
        setMon(ONE_DOLLAR);
        account.poke();
        setMon(88_000_000); // 90% WMON down 12%: 10.8% drawdown, unpoked
        expectRejected(buy(1e6), Reason.REDUCE_ONLY_MODE);
        submit(sell(1e18));
        setMon(77_000_000); // down 20.7%
        expectRejected(sell(1e18), Reason.PAUSED);
    }

    function test_TheGuardianPausesEverySwap_AndOnlyTheTimelockResumes() public {
        vm.prank(guardian);
        executor.pauseAll();
        expectRejected(sell(1e18), Reason.PAUSED);
        bytes memory yes = abi.encode(true);
        uint8 unpause = executor.UNPAUSE();
        vm.prank(guardian);
        vm.expectRevert();
        executor.propose(unpause, yes);
        vm.prank(admin);
        executor.propose(unpause, yes);
        vm.warp(block.timestamp + 9 days);
        executor.execute(unpause, yes);
        setMon(ONE_DOLLAR);
        vm.prank(owner);
        executor.registerSession(AGENT, session, uint64(block.timestamp + 1 days));
        submit(sell(1e18));
    }

    // ----- assets, balance and the account -----

    function test_AssetsOffTheListAreRefused() public {
        vm.prank(admin);
        factory.removeBuyable(address(wmon));
        expectRejected(buy(1e6), Reason.ASSET_NOT_ALLOWED);
        submit(sell(1e18)); // selling it stays allowed
        SwapIntent memory i = sell(1e18);
        i.tokenIn = makeAddr("other token");
        expectRejected(i, Reason.ASSET_NOT_ALLOWED);
    }

    function test_SellingMoreThanTheFreeBalanceIsRefused() public {
        expectRejected(sell(30e18 + 1), Reason.INSUFFICIENT_BALANCE);
    }

    function test_AMalformedIntentIsRefused() public {
        SwapIntent memory i = sell(1e18);
        i.chainId = 143;
        expectRejected(i, Reason.INTENT_INVALID);
        i = sell(1e18);
        i.schemaVersion = 2;
        expectRejected(i, Reason.INTENT_INVALID);
        i = sell(1e18);
        i.minAmountOut = 0;
        expectRejected(i, Reason.INTENT_INVALID);
        i = sell(1e18);
        i.tokenOut = address(wmon);
        expectRejected(i, Reason.INTENT_INVALID);
        i = sell(1e18);
        i.policyHash = keccak256("an older policy");
        expectRejected(i, Reason.INTENT_INVALID);
        i = sell(1e18);
        i.account = makeAddr("someone else's account");
        expectRejected(i, Reason.INTENT_INVALID);
    }

    function test_AnActionIdIsUsedOnce() public {
        SwapIntent memory i = sell(1e18);
        submit(i);
        i.deadline = uint64(block.timestamp + 60);
        expectRejected(i, Reason.ACTION_REPLAYED);
    }

    // ----- the policy: tighten at once, loosen by timelock -----

    function test_TheGuardianTightensAtOnce_LooseningWaitsTheTimelock() public {
        Policy memory p = launchPolicy();
        p.maxTradeBps = 500;
        bytes32 before = executor.policyHash();
        vm.prank(guardian);
        executor.tightenPolicy(p);
        assertTrue(executor.policyHash() != before);
        // An intent checked under the old policy no longer matches.
        SwapIntent memory i = sell(1e18);
        i.policyHash = before;
        expectRejected(i, Reason.INTENT_INVALID);
        expectRejected(sell(6e18), Reason.TRADE_SIZE_EXCEEDED);
        submit(sell(5e18));

        Policy memory looser = launchPolicy();
        vm.prank(guardian);
        vm.expectRevert(Executor.NotTighter.selector);
        executor.tightenPolicy(looser);
        uint8 setPolicy = executor.SET_POLICY();
        vm.prank(admin);
        executor.propose(setPolicy, abi.encode(looser));
        vm.warp(block.timestamp + 9 days);
        executor.execute(setPolicy, abi.encode(looser));
        assertEq(executor.policy().maxTradeBps, 1_000);
    }

    function test_APolicyOutsideItsBoundsIsRefused() public {
        Policy memory p = launchPolicy();
        p.maxTradesPerWindow = 21; // more than the ring holds
        uint8 setPolicy = executor.SET_POLICY();
        vm.prank(admin);
        vm.expectRevert(Executor.BadPolicy.selector);
        executor.propose(setPolicy, abi.encode(p));
    }

    function test_LimitsReportsWhatIsLeft() public {
        submit(sell(5e18));
        (Policy memory p, uint256 left, uint256 frees, uint256 used) = executor.limits(address(account));
        assertEq(p.maxTradeBps, 1_000);
        assertEq(left, 19);
        assertEq(frees, 0);
        assertEq(used, 5e6);
        assertMode(AccountMode.NORMAL);
    }
}
