// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IChainlinkFeed, IOracleAdapter, IUniswapV4StateView, OracleReason} from "../interfaces/IOracle.sol";

/// @title OracleAdapter
/// @notice Prices for the custody core and the Executor (FINAL_PLAN 4.1.9),
/// written clean-room from the plan.
///
/// - WMON is priced by Chainlink MON/USD, with USD taken as USDC. A reading is
///   refused when the feed reverts or answers short, its decimals changed, the
///   answer is not positive, the round is incomplete, `updatedAt` is in the
///   future, or the answer is as old as the feed's bound or older (strict:
///   300 seconds for MON/USD, D-151, D-168).
/// - USDC is exactly 1. Chainlink USDC/USD is read only by the depeg guard,
///   which deposits call: never by valuation or trading, so a USDC/USD outage
///   cannot block the USDC path (D-168).
/// - A trade also needs the traded pool's spot price (the hookless Uniswap v4
///   MON/USDC 0.05% pool, D-166) within 2% of the oracle's, so a pool pushed
///   away from the market cannot be traded against.
///
/// Every setting is immutable. Changing a feed, a bound or the pool means a
/// new adapter, which AccountFactory accepts only through its 9-day timelock;
/// removing an asset from buying is AccountFactory's instant `removeBuyable`
/// (D-232).
contract OracleAdapter is IOracleAdapter {
    uint256 public constant BPS = 10_000;
    /// The USDC value of one whole USDC, scaled by 1e18.
    uint256 public constant ONE_E18 = 1e18;
    /// 10^(18 + 18 - 6): a raw USDC-per-raw-MON pool price to a whole-token price scaled by 1e18.
    uint256 internal constant POOL_PRICE_SCALE = 1e30;
    uint256 internal constant Q96 = 2 ** 96;

    address public immutable USDC;
    address public immutable WMON;

    IChainlinkFeed public immutable MON_USD_FEED;
    uint8 public immutable MON_USD_DECIMALS;
    /// A MON/USD answer this many seconds old or older is stale.
    uint256 public immutable MON_USD_MAX_AGE;

    IChainlinkFeed public immutable USDC_USD_FEED;
    uint8 public immutable USDC_USD_DECIMALS;
    /// A USDC/USD answer this many seconds old or older is stale (the hourly heartbeat plus 5 minutes).
    uint256 public immutable USDC_USD_MAX_AGE;

    IUniswapV4StateView public immutable STATE_VIEW;
    /// The traded pool. Its currency0 is native MON (address zero sorts first
    /// in v4, so native MON is always currency0) and currency1 is USDC.
    bytes32 public immutable POOL_ID;

    /// Most a pool may be from the oracle, as a share of the oracle price.
    uint256 public immutable MAX_DEVIATION_BPS;
    /// Most USDC/USD may be from 1 before deposits stop.
    uint256 public immutable MAX_DEPEG_BPS;

    struct Config {
        address usdc;
        address wmon;
        IChainlinkFeed monUsdFeed;
        uint8 monUsdDecimals;
        uint256 monUsdMaxAge;
        IChainlinkFeed usdcUsdFeed;
        uint8 usdcUsdDecimals;
        uint256 usdcUsdMaxAge;
        IUniswapV4StateView stateView;
        bytes32 poolId;
        uint256 maxDeviationBps;
        uint256 maxDepegBps;
    }

    error BadConfig(string what);

    constructor(Config memory c) {
        if (c.usdc == address(0) || c.wmon == address(0) || c.usdc == c.wmon) revert BadConfig("assets");
        if (address(c.monUsdFeed) == address(0) || address(c.usdcUsdFeed) == address(0)) revert BadConfig("feeds");
        if (c.monUsdDecimals > 18 || c.usdcUsdDecimals > 18) revert BadConfig("decimals");
        if (c.monUsdMaxAge == 0 || c.usdcUsdMaxAge == 0) revert BadConfig("max age");
        if (address(c.stateView) == address(0) || c.poolId == bytes32(0)) revert BadConfig("pool");
        if (c.maxDeviationBps == 0 || c.maxDeviationBps >= BPS) revert BadConfig("deviation");
        if (c.maxDepegBps == 0 || c.maxDepegBps >= BPS) revert BadConfig("depeg");
        USDC = c.usdc;
        WMON = c.wmon;
        MON_USD_FEED = c.monUsdFeed;
        MON_USD_DECIMALS = c.monUsdDecimals;
        MON_USD_MAX_AGE = c.monUsdMaxAge;
        USDC_USD_FEED = c.usdcUsdFeed;
        USDC_USD_DECIMALS = c.usdcUsdDecimals;
        USDC_USD_MAX_AGE = c.usdcUsdMaxAge;
        STATE_VIEW = c.stateView;
        POOL_ID = c.poolId;
        MAX_DEVIATION_BPS = c.maxDeviationBps;
        MAX_DEPEG_BPS = c.maxDepegBps;
    }

    // ---------------------------------------------------------------------
    // Views that never revert: for the chain tools and the sentinel
    // ---------------------------------------------------------------------

    /// The oracle price of an asset and why it is unusable, if it is.
    /// USDC is always (1e18, now, OK).
    function price(address asset) public view returns (uint256 priceE18_, uint256 updatedAt, OracleReason reason) {
        if (asset == USDC) return (ONE_E18, block.timestamp, OracleReason.OK);
        if (asset != WMON) return (0, 0, OracleReason.UNKNOWN_ASSET);
        return _feed(MON_USD_FEED, MON_USD_DECIMALS, MON_USD_MAX_AGE);
    }

    /// The traded pool's spot price for an asset, same scale. USDC is always 1.
    function poolPrice(address asset) public view returns (uint256 priceE18_, OracleReason reason) {
        if (asset == USDC) return (ONE_E18, OracleReason.OK);
        if (asset != WMON) return (0, OracleReason.UNKNOWN_ASSET);
        return _pool();
    }

    /// The pool's distance from the oracle in basis points (rounded down), and
    /// OK, POOL_DEVIATION, or the reason either price is unusable. The limit
    /// is checked exactly, not on the rounded figure.
    function poolDeviationBps(address asset) public view returns (uint256 bps, OracleReason reason) {
        (, bps, reason) = _deviation(asset);
    }

    /// Whether an asset can be traded now: a usable oracle price and the pool within 2% of it.
    function tradable(address asset) public view returns (bool ok, OracleReason reason) {
        (, reason) = poolDeviationBps(asset);
        ok = reason == OracleReason.OK;
    }

    /// USDC/USD as a price scaled by 1e18, and OK, USDC_DEPEGGED, or why it is unusable.
    function usdcPeg() public view returns (uint256 usdcUsdE18, uint256 updatedAt, OracleReason reason) {
        (usdcUsdE18, updatedAt, reason) = _feed(USDC_USD_FEED, USDC_USD_DECIMALS, USDC_USD_MAX_AGE);
        if (reason != OracleReason.OK) return (usdcUsdE18, updatedAt, reason);
        uint256 diff = usdcUsdE18 > ONE_E18 ? usdcUsdE18 - ONE_E18 : ONE_E18 - usdcUsdE18;
        if (diff * BPS > ONE_E18 * MAX_DEPEG_BPS) reason = OracleReason.USDC_DEPEGGED;
    }

    // ---------------------------------------------------------------------
    // IOracleAdapter: the reverting forms the custody core calls
    // ---------------------------------------------------------------------

    /// @inheritdoc IOracleAdapter
    function priceE18(address asset) external view returns (uint256 p) {
        OracleReason reason;
        (p,, reason) = price(asset);
        if (reason != OracleReason.OK) revert OracleUnavailable(asset, reason);
    }

    /// @inheritdoc IOracleAdapter
    function tradablePriceE18(address asset) external view returns (uint256 p) {
        OracleReason reason;
        (p,, reason) = _deviation(asset);
        if (reason != OracleReason.OK) revert OracleUnavailable(asset, reason);
    }

    /// @inheritdoc IOracleAdapter
    function requireUsdcPeg() external view {
        (,, OracleReason reason) = usdcPeg();
        if (reason != OracleReason.OK) revert OracleUnavailable(USDC, reason);
    }

    /// The USDC value (6 decimals) of an amount of a held asset at the oracle
    /// price, rounded down. Reverts like `priceE18`. For tools and tests; the
    /// custody core reads the price once per transaction instead.
    function valueUsdc(address asset, uint256 amount) external view returns (uint256) {
        (uint256 p,, OracleReason reason) = price(asset);
        if (reason != OracleReason.OK) revert OracleUnavailable(asset, reason);
        return asset == USDC ? amount : Math.mulDiv(amount, p, 1e30);
    }

    // ---------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------

    /// The oracle price, the pool's distance from it, and the first reason either fails.
    function _deviation(address asset) internal view returns (uint256 oracle, uint256 bps, OracleReason reason) {
        (oracle,, reason) = price(asset);
        if (reason != OracleReason.OK || asset == USDC) return (oracle, 0, reason);
        uint256 pool;
        (pool, reason) = _pool();
        if (reason != OracleReason.OK) return (oracle, 0, reason);
        uint256 diff = pool > oracle ? pool - oracle : oracle - pool;
        bps = diff * BPS / oracle;
        reason = diff * BPS <= oracle * MAX_DEVIATION_BPS ? OracleReason.OK : OracleReason.POOL_DEVIATION;
    }

    /// One Chainlink feed, every check in a fixed order (the offchain mirror,
    /// `feedReading` in packages/policy, checks in the same order).
    function _feed(IChainlinkFeed feed, uint8 decimals, uint256 maxAge)
        internal
        view
        returns (uint256 priceE18_, uint256 updatedAt, OracleReason reason)
    {
        (bool ok, bytes memory ret) = address(feed).staticcall(abi.encodeCall(IChainlinkFeed.decimals, ()));
        if (!ok || ret.length < 32) return (0, 0, OracleReason.FEED_REVERTED);
        if (abi.decode(ret, (uint256)) != decimals) return (0, 0, OracleReason.DECIMALS_MISMATCH);

        (ok, ret) = address(feed).staticcall(abi.encodeCall(IChainlinkFeed.latestRoundData, ()));
        if (!ok || ret.length < 160) return (0, 0, OracleReason.FEED_REVERTED);
        // Decoded as full words, so a malformed answer cannot make the decode revert.
        (uint256 roundId, int256 answer,, uint256 updated, uint256 answeredInRound) =
            abi.decode(ret, (uint256, int256, uint256, uint256, uint256));

        if (answer <= 0) return (0, updated, OracleReason.ANSWER_NOT_POSITIVE);
        uint256 scale = 10 ** (18 - uint256(decimals));
        if (uint256(answer) > type(uint128).max / scale) return (0, updated, OracleReason.ANSWER_OUT_OF_RANGE);
        if (updated == 0 || answeredInRound < roundId) return (0, updated, OracleReason.ROUND_INCOMPLETE);
        // A leader's few seconds of skew cannot matter against 300 seconds.
        // forge-lint: disable-next-line(block-timestamp)
        if (updated > block.timestamp) return (0, updated, OracleReason.FUTURE_TIMESTAMP);
        if (block.timestamp - updated >= maxAge) return (0, updated, OracleReason.STALE);
        return (uint256(answer) * scale, updated, OracleReason.OK);
    }

    /// The pool's spot price as the USDC value of one whole MON, scaled by 1e18.
    function _pool() internal view virtual returns (uint256 priceE18_, OracleReason reason) {
        (bool ok, bytes memory ret) =
            address(STATE_VIEW).staticcall(abi.encodeCall(IUniswapV4StateView.getSlot0, (POOL_ID)));
        if (!ok || ret.length < 128) return (0, OracleReason.POOL_UNREADABLE);
        uint256 sqrtPriceX96 = abi.decode(ret, (uint256));
        if (sqrtPriceX96 == 0 || sqrtPriceX96 > type(uint160).max) return (0, OracleReason.POOL_UNREADABLE);
        priceE18_ = Math.mulDiv(Math.mulDiv(sqrtPriceX96, sqrtPriceX96, Q96), POOL_PRICE_SCALE, Q96);
        if (priceE18_ == 0) return (0, OracleReason.POOL_UNREADABLE);
        return (priceE18_, OracleReason.OK);
    }
}
