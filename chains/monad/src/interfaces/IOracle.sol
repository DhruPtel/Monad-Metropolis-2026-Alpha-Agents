// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// Why a price was refused, or OK (FINAL_PLAN 4.1.9, MV-S11). The order
/// matches ORACLE_REASONS in packages/policy/src/oracle.ts, and a policy test
/// checks it: an enum crosses the ABI as its index.
enum OracleReason {
    OK,
    /// Not USDC or WMON: the adapter prices nothing else.
    UNKNOWN_ASSET,
    /// The feed reverted, or answered with too little data to decode.
    FEED_REVERTED,
    /// The feed's decimals are not the ones the adapter was built for.
    DECIMALS_MISMATCH,
    /// The answer is zero or negative.
    ANSWER_NOT_POSITIVE,
    /// The answer, scaled to 18 decimals, is above 2^128 - 1: no real price is.
    ANSWER_OUT_OF_RANGE,
    /// `updatedAt` is zero, or the answer comes from an earlier round.
    ROUND_INCOMPLETE,
    /// `updatedAt` is after the current block's timestamp.
    FUTURE_TIMESTAMP,
    /// The answer is as old as the feed's bound or older (strict, D-151, D-168).
    STALE,
    /// The pool's price could not be read, or is zero.
    POOL_UNREADABLE,
    /// The pool's price is more than 2% from the oracle's.
    POOL_DEVIATION,
    /// USDC/USD is more than the depeg bound from 1.
    USDC_DEPEGGED
}

/// The oracle adapter (P2-U3) as the custody core uses it. Prices are the
/// USDC value of one whole token, scaled by 1e18 (`PriceE18` in packages/domain),
/// with USDC exactly 1. Every function here reverts with
/// `OracleUnavailable(asset, reason)` instead of returning an unusable price.
interface IOracleAdapter {
    error OracleUnavailable(address asset, OracleReason reason);

    /// The oracle price, after the feed checks (valuation: NAV, deposits, the breaker).
    function priceE18(address asset) external view returns (uint256);

    /// The oracle price, after the feed checks and the pool deviation check (trades).
    function tradablePriceE18(address asset) external view returns (uint256);

    /// Reverts unless USDC/USD is fresh, valid and within the depeg bound (deposits).
    function requireUsdcPeg() external view;
}

/// The parts of a Chainlink aggregator proxy the adapter reads.
interface IChainlinkFeed {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// Uniswap v4's StateView, written from its published ABI (clean-room).
interface IUniswapV4StateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}
