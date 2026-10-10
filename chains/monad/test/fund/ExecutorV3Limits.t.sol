// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ExecutorV3} from "../../src/fund/ExecutorV3.sol";
import {RiskTimelock} from "../../src/executor/RiskTimelock.sol";
import {AccountMode, IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {PolicyV3, ReasonV3, SwapIntentV3} from "../../src/interfaces/IExecutorV3.sol";
import {ITokenRegistry} from "../../src/interfaces/IFund.sol";
import {MockToken} from "../mocks/CustodyMocks.sol";
import {ExecutorV3Base} from "./ExecutorV3Base.sol";

/// Every hard limit of Executor v3 at, under and over its threshold, and the
/// trades that pass between them (F-U4).
contract ExecutorV3LimitsTest is ExecutorV3Base {
    // ----- trades that pass -----

    function test_AValidBuyAndSaleExecute_AndFundsStayInTheAccount() public {
        uint256 out = submit(buy(100e6));
        assertEq(out, 50e18);
        assertEq(usdcOf(address(account)), 600e6);
        assertEq(wmonOf(address(account)), 200e18);
        assertNothingKept();
        out = submit(sell(50e18));
        assertEq(out, 100e6);
        assertEq(usdcOf(address(account)), 700e6);
        assertEq(wmonOf(address(account)), 150e18);
        assertNothingKept();
        assertEq(account.navUsdc(), 1_000e6);
    }

    function test_OneTwoAndThreeHopRoutesTradeThroughRegisteredPools() public {
        // One hop: USDC to B through the v4 pool.
        SwapIntentV3 memory one = trade(address(usdc), address(tokB), 100e6);
        assertEq(one.route.length, 1);
        assertEq(submit(one), 2.5e8);
        // Two hops: USDC to WMON (Uniswap v3) to A (PancakeSwap v3).
        SwapIntentV3 memory two = trade(address(usdc), address(tokA), 60e6);
        assertEq(two.route.length, 2);
        assertEq(submit(two), 10e18);
        // Three hops: A to WMON to USDC to B.
        SwapIntentV3 memory three = trade(address(tokA), address(tokB), 10e18);
        assertEq(three.route.length, 3);
        assertEq(submit(three), 1.5e8);
        assertEq(usdcOf(address(account)), 540e6);
        assertEq(bal(address(tokA), address(account)), 0);
        assertEq(bal(address(tokB), address(account)), 4e8);
        assertEq(account.navUsdc(), 1_000e6);
        assertFalse(account.isHeld(address(tokA)), "A left the held list when sold out");
        assertNothingKept();
    }

    function test_EmitsTheTrade() public {
        SwapIntentV3 memory i = buy(100e6);
        vm.expectEmit(true, true, true, true);
        emit ExecutorV3.IntentExecuted(
            i.actionId,
            address(account),
            AGENT,
            ExecutorV3.ExecutedRecord({
                tokenIn: address(usdc),
                tokenOut: address(wmon),
                amountIn: 100e6,
                amountOut: 50e18,
                priceInE18: 1e18,
                priceOutE18: 2e18,
                navBefore: 1_000e6,
                navAfter: 1_000e6,
                routeHash: routeHash(i.route)
            })
        );
        submit(i);
    }

    // ----- size, concentration, floor -----

    function test_TradeSize_ExactlyTenPercentPasses_OneUnitMoreIsRefused() public {
        expectRejected(buy(100e6 + 1), ReasonV3.TRADE_SIZE_EXCEEDED);
        submit(buy(100e6));
    }

    function test_Concentration_ExactlyFortyPercentPasses_OneUnitMoreIsRefused() public {
        holdings(650e6, 175e18); // WMON 350 of 1,000
        expectRejected(buy(50e6 + 1), ReasonV3.CONCENTRATION_CAP);
        submit(buy(50e6));
        assertEq(wmonOf(address(account)), 200e18);
    }

    function test_TheRegistrysLowerCapBindsBeforeThePolicys() public {
        vm.prank(SCREENER);
        tokens.lowerCap(address(wmon), 3_500);
        expectRejected(buy(50e6 + 1), ReasonV3.CONCENTRATION_CAP);
        submit(buy(50e6));
    }

    function test_ABuyFarOverTheCapIsNamedBeforeTheTrade() public {
        holdings(650e6, 175e18);
        // 100 USDC of WMON would be 45%: the Executor names the cap, not the account's backstop.
        expectRejected(buy(100e6), ReasonV3.CONCENTRATION_CAP);
    }

    function test_ASaleIntoUsdcIsExemptFromConcentrationAndTheFloor() public {
        holdings(50e6, 475e18); // USDC 5%, WMON 95%
        submit(sell(25e18));
        expectRejected(trade(address(usdc), address(tokB), 10e6), ReasonV3.USDC_FLOOR);
        expectRejected(buy(10e6), ReasonV3.CONCENTRATION_CAP);
    }

    function test_UsdcFloor_ExactlyTheFloorPasses_OneUnitLessIsRefused() public {
        holdings(150e6, 175e18);
        deposit(address(tokB), 12.5e8); // 500 USDC of B: NAV 1,000, USDC 150
        expectRejected(trade(address(usdc), address(tokA), 50e6 + 1), ReasonV3.USDC_FLOOR);
        submit(trade(address(usdc), address(tokA), 50e6));
        assertEq(usdcOf(address(account)), 100e6);
    }

    // ----- slippage -----

    function test_Slippage_TheOracleFloorPasses_OneUnitUnderIsRefused() public {
        SwapIntentV3 memory i = buy(100e6);
        assertEq(i.minAmountOut, 49.75e18);
        i.minAmountOut -= 1;
        expectRejected(i, ReasonV3.SLIPPAGE_TOO_HIGH);
        i.minAmountOut += 1;
        submit(i);
    }

    function test_AFillHalfAPercentShortPasses_OneUnitMoreIsRefusedOnArrival() public {
        setFill(poolUsdcWmon, address(usdc), 9_949);
        expectRejected(buy(50e6), ReasonV3.SLIPPAGE_TOO_HIGH);
        setFill(poolUsdcWmon, address(usdc), 9_950);
        assertEq(submit(buy(50e6)), 24.875e18);
        assertEq(account.navUsdc(), 1_000e6 - 0.25e6, "the fill's shortfall is the only value lost");
    }

    function test_ClassASlippageIsOnePercent() public {
        setAttestor();
        SwapIntentV3 memory i = trade(address(usdc), address(tokC), 100e6);
        assertEq(i.minAmountOut, 247.5e18, "250 C less 1%");
        i.minAmountOut -= 1;
        expectRejected(i, ReasonV3.SLIPPAGE_TOO_HIGH);
        i.minAmountOut += 1;
        assertEq(submit(i), 250e18);
        assertEq(account.costBasis(address(tokC)), 100e6);
    }

    // ----- rate and turnover -----

    function test_TwentyTradesPerRollingDay_TheTwentyFirstIsRefused() public {
        uint256 first = block.timestamp;
        for (uint256 k = 0; k < 20; ++k) {
            submit(k % 2 == 0 ? buy(10e6) : sell(5e18));
            vm.warp(block.timestamp + 60);
            _refreshFeeds();
        }
        expectRejected(buy(10e6), ReasonV3.DAILY_TRADE_LIMIT);
        (, uint256 left, uint256 freesAt, uint256 used) = executor.limits(address(account));
        assertEq(left, 0);
        assertEq(freesAt, first + 86_400);
        assertEq(used, 200e6);
        vm.warp(freesAt);
        _refreshFeeds();
        submit(buy(10e6));
    }

    function test_Turnover_ExactlyTheCapPasses_OneUnitMoreIsRefused() public {
        PolicyV3 memory p = launchPolicy();
        p.maxTurnoverBps = 2_000;
        tighten(p);
        submit(buy(100e6));
        submit(sell(50e18)); // 200 USDC of turnover: exactly 20%
        expectRejected(buy(1e6), ReasonV3.TURNOVER_CAP);
        vm.warp(block.timestamp + 86_400);
        _refreshFeeds();
        submit(buy(1e6));
    }

    // ----- deadlines -----

    function test_Deadline_TwoMinutesAheadPasses_OneSecondMoreIsTooFar() public {
        SwapIntentV3 memory i = buy(10e6);
        i.deadline = uint64(block.timestamp + 121);
        expectRejected(i, ReasonV3.DEADLINE_TOO_FAR);
        i.deadline = uint64(block.timestamp + 120);
        submit(i);
    }

    function test_Deadline_NowPasses_OneSecondAgoIsExpired() public {
        SwapIntentV3 memory i = buy(10e6);
        i.deadline = uint64(block.timestamp - 1);
        expectRejected(i, ReasonV3.DEADLINE_EXPIRED);
        i.deadline = uint64(block.timestamp);
        submit(i);
    }

    // ----- oracle, pools, balance -----

    function test_AStaleOracleIsRefused() public {
        vm.warp(block.timestamp + 300);
        SwapIntentV3 memory i = intent(address(usdc), address(wmon), 10e6, 1);
        expectRejected(i, ReasonV3.ORACLE_STALE);
        _refreshFeeds();
        submit(buy(10e6));
    }

    function test_AStaleFeedOfAnotherHeldTokenIsRefusedToo() public {
        deposit(address(tokA), 10e18);
        vm.warp(block.timestamp + 3_900);
        monUsd.push(2e8);
        usdcUsd.push(1e8);
        bRate.push(20e18);
        expectRejected(buy(10e6), ReasonV3.ORACLE_STALE);
        aUsd.push(6e8);
        submit(buy(10e6));
    }

    function test_APoolMoreThanTwoPercentFromTheOracleIsRefused() public {
        (address u0,) = _sorted(address(usdc), address(wmon));
        // The spot the oracle reads moves; what the pool pays does not.
        if (u0 == address(wmon)) setSpot(poolUsdcWmon, 2.05e6, 1e18);
        else setSpot(poolUsdcWmon, 1e18, 2.05e6);
        expectRejected(buy(10e6), ReasonV3.ORACLE_POOL_DEVIATION);
        if (u0 == address(wmon)) setSpot(poolUsdcWmon, 2.03e6, 1e18);
        else setSpot(poolUsdcWmon, 1e18, 2.03e6);
        submit(buy(10e6));
    }

    function test_SellingMoreThanTheFreeBalanceIsRefused() public {
        expectRejected(sell(150e18 + 1), ReasonV3.INSUFFICIENT_BALANCE);
    }

    // ----- modes -----

    function test_ReduceOnlyAllowsOnlySalesIntoUsdc() public {
        deposit(address(tokA), 10e18);
        vm.prank(sentinel);
        account.setReduceOnly();
        expectRejected(buy(10e6), ReasonV3.REDUCE_ONLY_MODE);
        expectRejected(trade(address(tokA), address(tokB), 1e18), ReasonV3.REDUCE_ONLY_MODE);
        submit(sell(5e18));
        submit(trade(address(tokA), address(usdc), 1e18));
    }

    function test_PausedAllowsNothing() public {
        vm.prank(guardian);
        account.pause();
        expectRejected(buy(10e6), ReasonV3.PAUSED);
        expectRejected(sell(5e18), ReasonV3.PAUSED);
    }

    function test_ADrawdownNobodyPokedCountsAsItsMode() public {
        account.poke();
        setMon(1.3e8); // WMON 300 to 195: NAV 895, down 10.5%
        assertMode(AccountMode.NORMAL);
        expectRejected(buy(10e6), ReasonV3.REDUCE_ONLY_MODE);
        // A sale into USDC still goes through, and the account trips its own breaker as it observes it.
        submit(sell(5e18));
        assertMode(AccountMode.REDUCE_ONLY);
        setMon(0.6e8); // NAV 790, down 21%: a pause is due though nobody poked
        expectRejected(buy(10e6), ReasonV3.REDUCE_ONLY_MODE);
        expectRejected(sell(5e18), ReasonV3.PAUSED);
        account.poke();
        assertMode(AccountMode.PAUSED);
    }

    // ----- the intent itself -----

    function test_AssetsOffTheListAreRefused() public {
        MockToken x = new MockToken("X", 18);
        expectRejected(intent(address(usdc), address(x), 10e6, 1), ReasonV3.ASSET_NOT_ALLOWED);
        expectRejected(intent(address(x), address(usdc), 1e18, 1), ReasonV3.ASSET_NOT_ALLOWED);
    }

    function test_AMalformedIntentIsRefused() public {
        SwapIntentV3 memory i = buy(10e6);
        i.schemaVersion = 1;
        expectRejected(i, ReasonV3.INTENT_INVALID);
        i = buy(10e6);
        i.chainId += 1;
        expectRejected(i, ReasonV3.INTENT_INVALID);
        i = buy(10e6);
        i.amountIn = 0;
        expectRejected(i, ReasonV3.INTENT_INVALID);
        i = buy(10e6);
        i.minAmountOut = 0;
        expectRejected(i, ReasonV3.INTENT_INVALID);
        i = buy(10e6);
        i.tokenOut = address(usdc);
        expectRejected(i, ReasonV3.INTENT_INVALID);
        i = buy(10e6);
        i.policyHash = bytes32(uint256(1));
        expectRejected(i, ReasonV3.INTENT_INVALID);
        i = buy(10e6);
        i.account = stranger;
        expectRejected(i, ReasonV3.INTENT_INVALID);
    }

    function test_AnActionIdIsUsedOnce() public {
        SwapIntentV3 memory i = buy(10e6);
        submit(i);
        expectRejected(i, ReasonV3.ACTION_REPLAYED);
    }

    // ----- policy and pause -----

    function test_TheGuardianTightensAtOnce_LooseningWaitsTheTimelock() public {
        PolicyV3 memory tight = launchPolicy();
        tight.maxTradeBps = 500;
        tighten(tight);
        expectRejected(buy(60e6), ReasonV3.TRADE_SIZE_EXCEEDED);
        submit(buy(50e6));
        vm.prank(guardian);
        vm.expectRevert(ExecutorV3.NotTighter.selector);
        executor.tightenPolicy(launchPolicy());
        uint8 setPolicy = executor.SET_POLICY();
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        executor.propose(setPolicy, abi.encode(launchPolicy()));
        timelockedExecutor(setPolicy, abi.encode(launchPolicy()));
        submit(sell(25e18));
        submit(buy(60e6));
    }

    function test_APolicyOutsideItsBoundsIsRefused() public {
        PolicyV3 memory p = launchPolicy();
        p.maxClassAPositionBps = 1_501;
        vm.expectRevert(ExecutorV3.BadPolicy.selector);
        new ExecutorV3(
            admin,
            guardian,
            IAgentNFTView(address(nft)),
            ITokenRegistry(address(tokens)),
            address(usdc),
            address(wmon),
            p
        );
        uint8 setPolicy = executor.SET_POLICY();
        p = launchPolicy();
        p.maxTradesPerWindow = 21;
        vm.prank(admin);
        vm.expectRevert(ExecutorV3.BadPolicy.selector);
        executor.propose(setPolicy, abi.encode(p));
        p = launchPolicy();
        p.maxClassATotalBps = 5_001;
        vm.prank(admin);
        vm.expectRevert(ExecutorV3.BadPolicy.selector);
        executor.propose(setPolicy, abi.encode(p));
    }

    function test_LimitsReportsWhatIsLeft() public {
        submit(buy(100e6));
        submit(sell(50e18));
        (PolicyV3 memory p, uint256 left, uint256 freesAt, uint256 used) = executor.limits(address(account));
        assertEq(p.maxTradeBps, 1_000);
        assertEq(left, 18);
        assertEq(freesAt, 0);
        assertEq(used, 200e6);
    }

    function test_TheGuardianPausesEverySwap_AndOnlyTheTimelockResumes() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(RiskTimelock.NotAdminOrGuardian.selector, stranger));
        executor.pauseAll();
        vm.prank(guardian);
        executor.pauseAll();
        expectRejected(buy(10e6), ReasonV3.PAUSED);
        expectRejected(sell(5e18), ReasonV3.PAUSED);
        timelockedExecutor(executor.UNPAUSE(), abi.encode(true));
        submit(buy(10e6));
    }
}
