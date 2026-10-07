// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {OracleAdapter} from "../../src/oracle/OracleAdapter.sol";
import {IChainlinkFeed, OracleReason} from "../../src/interfaces/IOracle.sol";
import {MockFeed} from "../mocks/OracleMocks.sol";
import {OracleBase, PoolPriceHarness} from "./OracleBase.sol";

/// Every oracle rule (FINAL_PLAN 4.1.9, MV-S11, D-151, D-168) at its boundary.
contract OracleAdapterTest is OracleBase {
    // ----- configuration -----

    function test_StoresTheLaunchConfiguration() public view {
        assertEq(adapter.USDC(), usdcToken);
        assertEq(adapter.WMON(), wmonToken);
        assertEq(address(adapter.MON_USD_FEED()), address(monFeed));
        assertEq(adapter.MON_USD_MAX_AGE(), 300);
        assertEq(adapter.USDC_USD_MAX_AGE(), 3_900);
        assertEq(adapter.MAX_DEVIATION_BPS(), 200);
        assertEq(adapter.MAX_DEPEG_BPS(), 100);
        assertEq(adapter.POOL_ID(), POOL_ID);
    }

    function test_RefusesABadConfiguration() public {
        OracleAdapter.Config memory c = config();
        c.wmon = c.usdc;
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.BadConfig.selector, "assets"));
        new OracleAdapter(c);
        c = config();
        c.usdcUsdFeed = IChainlinkFeed(address(0));
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.BadConfig.selector, "feeds"));
        new OracleAdapter(c);
        c = config();
        c.monUsdDecimals = 19;
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.BadConfig.selector, "decimals"));
        new OracleAdapter(c);
        c = config();
        c.monUsdMaxAge = 0;
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.BadConfig.selector, "max age"));
        new OracleAdapter(c);
        c = config();
        c.poolId = bytes32(0);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.BadConfig.selector, "pool"));
        new OracleAdapter(c);
        c = config();
        c.maxDeviationBps = 10_000;
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.BadConfig.selector, "deviation"));
        new OracleAdapter(c);
        c = config();
        c.maxDepegBps = 0;
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.BadConfig.selector, "depeg"));
        new OracleAdapter(c);
    }

    // ----- prices -----

    function test_UsdcIsExactlyOne_AndReadsNoFeed() public {
        monFeed.setFailure(MockFeed.Failure.RevertRound);
        usdcFeed.setFailure(MockFeed.Failure.RevertRound);
        (uint256 p, uint256 at, OracleReason r) = adapter.price(usdcToken);
        assertEq(p, 1e18);
        assertEq(at, block.timestamp);
        assertReason(r, OracleReason.OK);
        assertEq(adapter.priceE18(usdcToken), 1e18);
        assertEq(adapter.tradablePriceE18(usdcToken), 1e18);
        assertEq(adapter.valueUsdc(usdcToken, 123e6), 123e6);
    }

    function test_PricesWmonFromMonUsd_ScaledTo18Decimals() public view {
        (uint256 p, uint256 at, OracleReason r) = adapter.price(wmonToken);
        assertEq(p, MON_PRICE_E18);
        assertEq(at, block.timestamp);
        assertReason(r, OracleReason.OK);
        // 1,000 WMON at $0.0343682 is 34.3682 USDC.
        assertEq(adapter.valueUsdc(wmonToken, 1_000e18), 34_368_200);
    }

    function test_AnUnknownAssetHasNoPrice() public {
        address other = makeAddr("other");
        (,, OracleReason r) = adapter.price(other);
        assertReason(r, OracleReason.UNKNOWN_ASSET);
        (bool ok, OracleReason t) = adapter.tradable(other);
        assertFalse(ok);
        assertReason(t, OracleReason.UNKNOWN_ASSET);
        vm.expectRevert(unavailable(other, OracleReason.UNKNOWN_ASSET));
        adapter.priceE18(other);
    }

    // ----- staleness: strict, per feed (D-151, D-168) -----

    function test_MonUsdIsStaleAtExactly300Seconds() public {
        vm.warp(block.timestamp + 299);
        assertEq(adapter.priceE18(wmonToken), MON_PRICE_E18, "299 s passes");
        vm.warp(block.timestamp + 1);
        (,, OracleReason r) = adapter.price(wmonToken);
        assertReason(r, OracleReason.STALE);
        vm.expectRevert(unavailable(wmonToken, OracleReason.STALE));
        adapter.priceE18(wmonToken);
        vm.expectRevert(unavailable(wmonToken, OracleReason.STALE));
        adapter.tradablePriceE18(wmonToken);
    }

    function test_UsdcUsdIsStaleAtExactly3900Seconds() public {
        vm.warp(block.timestamp + 3_899);
        monFeed.push(MON_ANSWER);
        adapter.requireUsdcPeg();
        vm.warp(block.timestamp + 1);
        monFeed.push(MON_ANSWER);
        (,, OracleReason r) = adapter.usdcPeg();
        assertReason(r, OracleReason.STALE);
        vm.expectRevert(unavailable(usdcToken, OracleReason.STALE));
        adapter.requireUsdcPeg();
        // USDC/USD is never a price or a trade gate: USDC and WMON still price and trade.
        assertEq(adapter.priceE18(usdcToken), 1e18);
        assertEq(adapter.tradablePriceE18(wmonToken), MON_PRICE_E18);
    }

    function test_ATimestampFromTheFutureIsRefused() public {
        monFeed.setRound(9, MON_ANSWER, block.timestamp + 1, 9);
        (,, OracleReason r) = adapter.price(wmonToken);
        assertReason(r, OracleReason.FUTURE_TIMESTAMP);
        monFeed.setRound(9, MON_ANSWER, block.timestamp, 9);
        (,, r) = adapter.price(wmonToken);
        assertReason(r, OracleReason.OK);
    }

    // ----- invalid answers (MV-S11) -----

    function test_AZeroOrNegativeAnswerIsRefused() public {
        monFeed.push(0);
        (,, OracleReason r) = adapter.price(wmonToken);
        assertReason(r, OracleReason.ANSWER_NOT_POSITIVE);
        monFeed.push(-1);
        vm.expectRevert(unavailable(wmonToken, OracleReason.ANSWER_NOT_POSITIVE));
        adapter.priceE18(wmonToken);
        monFeed.push(1);
        assertEq(adapter.priceE18(wmonToken), 1e10, "the smallest positive answer");
    }

    function test_AnAbsurdAnswerIsRefused() public {
        // Scaled to 18 decimals the price must fit in 128 bits.
        int256 max = int256(uint256(type(uint128).max) / 1e10);
        monFeed.push(max);
        assertEq(adapter.priceE18(wmonToken), uint256(max) * 1e10);
        monFeed.push(max + 1);
        vm.expectRevert(unavailable(wmonToken, OracleReason.ANSWER_OUT_OF_RANGE));
        adapter.priceE18(wmonToken);
        monFeed.push(type(int256).max);
        vm.expectRevert(unavailable(wmonToken, OracleReason.ANSWER_OUT_OF_RANGE));
        adapter.priceE18(wmonToken);
    }

    function test_AnIncompleteRoundIsRefused() public {
        monFeed.setRound(10, MON_ANSWER, 0, 10);
        (,, OracleReason r) = adapter.price(wmonToken);
        assertReason(r, OracleReason.ROUND_INCOMPLETE);
        monFeed.setRound(10, MON_ANSWER, block.timestamp, 9);
        (,, r) = adapter.price(wmonToken);
        assertReason(r, OracleReason.ROUND_INCOMPLETE);
        monFeed.setRound(10, MON_ANSWER, block.timestamp, 11);
        (,, r) = adapter.price(wmonToken);
        assertReason(r, OracleReason.OK);
    }

    function test_ChangedDecimalsAreRefused() public {
        monFeed.setDecimals(18);
        (,, OracleReason r) = adapter.price(wmonToken);
        assertReason(r, OracleReason.DECIMALS_MISMATCH);
        vm.expectRevert(unavailable(wmonToken, OracleReason.DECIMALS_MISMATCH));
        adapter.tradablePriceE18(wmonToken);
    }

    function test_ARevertingOrShortFeedIsRefused() public {
        MockFeed.Failure[4] memory failures = [
            MockFeed.Failure.RevertRound,
            MockFeed.Failure.RevertDecimals,
            MockFeed.Failure.ShortRound,
            MockFeed.Failure.ShortDecimals
        ];
        for (uint256 i = 0; i < failures.length; ++i) {
            monFeed.setFailure(failures[i]);
            (uint256 p,, OracleReason r) = adapter.price(wmonToken);
            assertEq(p, 0);
            assertReason(r, OracleReason.FEED_REVERTED);
            vm.expectRevert(unavailable(wmonToken, OracleReason.FEED_REVERTED));
            adapter.priceE18(wmonToken);
        }
        // The same failures on USDC/USD stop deposits only.
        monFeed.setFailure(MockFeed.Failure.None);
        usdcFeed.setFailure(MockFeed.Failure.RevertRound);
        vm.expectRevert(unavailable(usdcToken, OracleReason.FEED_REVERTED));
        adapter.requireUsdcPeg();
        assertEq(adapter.tradablePriceE18(wmonToken), MON_PRICE_E18);
    }

    function test_AFeedWithNoCodeIsRefused() public {
        OracleAdapter.Config memory c = config();
        c.monUsdFeed = IChainlinkFeed(makeAddr("no code"));
        OracleAdapter a = new OracleAdapter(c);
        (,, OracleReason r) = a.price(wmonToken);
        assertReason(r, OracleReason.FEED_REVERTED);
    }

    // ----- the USDC depeg guard (deposits only) -----

    function test_TheDepegGuardAllowsExactly1Percent() public {
        usdcFeed.push(99_000_000); // 0.99: exactly 1% under
        adapter.requireUsdcPeg();
        usdcFeed.push(101_000_000); // 1.01: exactly 1% over
        adapter.requireUsdcPeg();
        usdcFeed.push(98_999_999);
        (uint256 p,, OracleReason r) = adapter.usdcPeg();
        assertEq(p, 0.98999999e18);
        assertReason(r, OracleReason.USDC_DEPEGGED);
        vm.expectRevert(unavailable(usdcToken, OracleReason.USDC_DEPEGGED));
        adapter.requireUsdcPeg();
        usdcFeed.push(101_000_001);
        vm.expectRevert(unavailable(usdcToken, OracleReason.USDC_DEPEGGED));
        adapter.requireUsdcPeg();
        // A depeg never changes USDC's price or blocks a trade.
        assertEq(adapter.priceE18(usdcToken), 1e18);
        assertEq(adapter.tradablePriceE18(wmonToken), MON_PRICE_E18);
    }

    function test_TheDepegGuardChecksTheFeedFirst() public {
        usdcFeed.push(0);
        vm.expectRevert(unavailable(usdcToken, OracleReason.ANSWER_NOT_POSITIVE));
        adapter.requireUsdcPeg();
        usdcFeed.push(100_000_000);
        usdcFeed.setDecimals(6);
        vm.expectRevert(unavailable(usdcToken, OracleReason.DECIMALS_MISMATCH));
        adapter.requireUsdcPeg();
    }

    // ----- the pool: spot price and the 2% rule -----

    function test_ReadsThePoolPriceFromSqrtPriceX96() public view {
        (uint256 p, OracleReason r) = adapter.poolPrice(wmonToken);
        assertReason(r, OracleReason.OK);
        // The square root loses a little: within one part in 10^12.
        assertApproxEqRel(p, MON_PRICE_E18, 1e6);
        (uint256 bps, OracleReason d) = adapter.poolDeviationBps(wmonToken);
        assertEq(bps, 0);
        assertReason(d, OracleReason.OK);
        (bool ok,) = adapter.tradable(wmonToken);
        assertTrue(ok);
    }

    /// The pinned block's real pool: sqrtPriceX96 14689533063741189719999 is
    /// $0.0343761..., 2 bp from the oracle's $0.0343682 (computed independently).
    function test_ThePinnedPoolPrice() public {
        stateView.setSqrtPrice(14_689_533_063_741_189_719_999);
        (uint256 p,) = adapter.poolPrice(wmonToken);
        assertEq(p, 34_376_116_674_083_669);
        (uint256 bps, OracleReason r) = adapter.poolDeviationBps(wmonToken);
        assertEq(bps, 2);
        assertReason(r, OracleReason.OK);
    }

    function test_ExactlyTwoPercentPasses_OneWeiMoreIsRefused() public {
        PoolPriceHarness h = new PoolPriceHarness(config());
        uint256 o = MON_PRICE_E18; // divisible by 50, so 2% is exact
        uint256 two = o / 50;
        h.forcePool(o + two);
        (uint256 bps, OracleReason r) = h.poolDeviationBps(wmonToken);
        assertEq(bps, 200);
        assertReason(r, OracleReason.OK);
        assertEq(h.tradablePriceE18(wmonToken), o, "a trade gets the oracle price, not the pool's");
        h.forcePool(o - two);
        (, r) = h.poolDeviationBps(wmonToken);
        assertReason(r, OracleReason.OK);

        h.forcePool(o + two + 1);
        (bps, r) = h.poolDeviationBps(wmonToken);
        assertEq(bps, 200, "the rounded figure still reads 200");
        assertReason(r, OracleReason.POOL_DEVIATION);
        vm.expectRevert(unavailable(wmonToken, OracleReason.POOL_DEVIATION));
        h.tradablePriceE18(wmonToken);
        h.forcePool(o - two - 1);
        (, r) = h.poolDeviationBps(wmonToken);
        assertReason(r, OracleReason.POOL_DEVIATION);
    }

    /// BUILD_PLAN P2-U3: a 3% pool move blocks trades, and M-29: it never moves valuation.
    function test_AThreePercentPoolMoveBlocksTrades_ButNotValuation() public {
        stateView.setSqrtPrice(sqrtFor(MON_PRICE_E18 * 103 / 100));
        (bool ok, OracleReason r) = adapter.tradable(wmonToken);
        assertFalse(ok);
        assertReason(r, OracleReason.POOL_DEVIATION);
        vm.expectRevert(unavailable(wmonToken, OracleReason.POOL_DEVIATION));
        adapter.tradablePriceE18(wmonToken);
        assertEq(adapter.priceE18(wmonToken), MON_PRICE_E18, "valuation reads only the feed");
        stateView.setSqrtPrice(sqrtFor(MON_PRICE_E18 * 80 / 100));
        assertEq(adapter.priceE18(wmonToken), MON_PRICE_E18, "a 20% pool push moves nothing");
    }

    function test_AnUnreadablePoolBlocksTrades() public {
        stateView.setReverts(true);
        (, OracleReason r) = adapter.poolPrice(wmonToken);
        assertReason(r, OracleReason.POOL_UNREADABLE);
        vm.expectRevert(unavailable(wmonToken, OracleReason.POOL_UNREADABLE));
        adapter.tradablePriceE18(wmonToken);
        stateView.setReverts(false);
        stateView.setSqrtPrice(0);
        (, r) = adapter.poolDeviationBps(wmonToken);
        assertReason(r, OracleReason.POOL_UNREADABLE);
        assertEq(adapter.priceE18(wmonToken), MON_PRICE_E18);
    }

    function test_AStaleFeedIsReportedBeforeThePool() public {
        stateView.setReverts(true);
        vm.warp(block.timestamp + 300);
        (, OracleReason r) = adapter.poolDeviationBps(wmonToken);
        assertReason(r, OracleReason.STALE);
    }

    // ----- fuzz -----

    /// Whatever a feed answers, the views never revert, and a usable price is exactly answer × 10^10.
    function testFuzz_ViewsNeverRevert(
        uint80 roundId,
        int256 answer,
        uint256 updatedAt,
        uint80 answeredInRound,
        uint8 decimals,
        uint160 sqrtPrice
    ) public {
        monFeed.setRound(roundId, answer, updatedAt, answeredInRound);
        monFeed.setDecimals(decimals);
        stateView.setSqrtPrice(sqrtPrice);
        (uint256 p, uint256 at, OracleReason r) = adapter.price(wmonToken);
        adapter.poolPrice(wmonToken);
        adapter.poolDeviationBps(wmonToken);
        adapter.tradable(wmonToken);
        if (r == OracleReason.OK) {
            assertEq(decimals, 8);
            assertGt(answer, 0);
            assertEq(p, uint256(answer) * 1e10);
            assertEq(at, updatedAt);
            assertLt(block.timestamp - updatedAt, MON_MAX_AGE);
            assertGe(answeredInRound, roundId);
        } else {
            assertEq(p, 0);
        }
    }

    /// Deviation is symmetric and its verdict matches the exact 2% rule.
    function testFuzz_DeviationVerdictMatchesTheRule(uint256 oracleAnswer, uint256 pool) public {
        oracleAnswer = bound(oracleAnswer, 1, uint256(type(uint128).max) / 1e10);
        pool = bound(pool, 1, type(uint128).max);
        monFeed.push(int256(oracleAnswer));
        PoolPriceHarness h = new PoolPriceHarness(config());
        h.forcePool(pool);
        uint256 o = oracleAnswer * 1e10;
        uint256 diff = pool > o ? pool - o : o - pool;
        (uint256 bps, OracleReason r) = h.poolDeviationBps(wmonToken);
        assertEq(bps, diff * 10_000 / o);
        assertEq(r == OracleReason.OK, diff * 10_000 <= o * 200);
        if (r != OracleReason.OK) assertReason(r, OracleReason.POOL_DEVIATION);
    }

    function testFuzz_ValueIsAmountTimesPrice(uint128 amount, uint64 answer) public {
        vm.assume(answer > 0);
        monFeed.push(int256(uint256(answer)));
        assertEq(adapter.valueUsdc(wmonToken, amount), uint256(amount) * uint256(answer) * 1e10 / 1e30);
    }
}
