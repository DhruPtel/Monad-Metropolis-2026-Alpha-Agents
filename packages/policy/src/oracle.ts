import { BPS_DENOMINATOR, type PriceE18, type RejectionCode } from "@alpha-agents/domain";
import { LAUNCH_LIMITS, type OracleFeed, type PolicyLimits } from "./limits.ts";

/**
 * The oracle adapter's rules, offchain (FINAL_PLAN 4.1.9, P2-U3). Each function
 * mirrors one part of chains/monad/src/oracle/OracleAdapter.sol in the same
 * order and with the same integer arithmetic, so the chain tools and the
 * sentinel can say in advance exactly what the contract will answer. The
 * parity fixture (parity.ts) runs both over the same cases, and a test fails
 * if they ever disagree.
 */

/** Why a price was refused, or OK. The order is the Solidity enum `OracleReason`'s. */
export const ORACLE_REASONS = [
  "OK",
  "UNKNOWN_ASSET",
  "FEED_REVERTED",
  "DECIMALS_MISMATCH",
  "ANSWER_NOT_POSITIVE",
  "ANSWER_OUT_OF_RANGE",
  "ROUND_INCOMPLETE",
  "FUTURE_TIMESTAMP",
  "STALE",
  "POOL_UNREADABLE",
  "POOL_DEVIATION",
  "USDC_DEPEGGED",
] as const;
export type OracleReason = (typeof ORACLE_REASONS)[number];

/**
 * The rejection code an intent gets for each reason (FINAL_PLAN 4.4.3): an
 * unusable price is ORACLE_STALE, a pool too far away ORACLE_POOL_DEVIATION.
 * A depeg stops deposits, never a trade, so it has no trade code.
 */
export const ORACLE_REASON_REJECTION: Readonly<Record<OracleReason, RejectionCode | null>> =
  Object.freeze({
    OK: null,
    UNKNOWN_ASSET: "ORACLE_STALE",
    FEED_REVERTED: "ORACLE_STALE",
    DECIMALS_MISMATCH: "ORACLE_STALE",
    ANSWER_NOT_POSITIVE: "ORACLE_STALE",
    ANSWER_OUT_OF_RANGE: "ORACLE_STALE",
    ROUND_INCOMPLETE: "ORACLE_STALE",
    FUTURE_TIMESTAMP: "ORACLE_STALE",
    STALE: "ORACLE_STALE",
    POOL_UNREADABLE: "ORACLE_POOL_DEVIATION",
    POOL_DEVIATION: "ORACLE_POOL_DEVIATION",
    USDC_DEPEGGED: null,
  });

/** Each feed's decimals as the adapter is built for them (Chainlink USD feeds: 8). */
export const FEED_DECIMALS: Readonly<Record<OracleFeed, number>> = Object.freeze({
  MON_USD: 8,
  USDC_USD: 8,
});

/** What `latestRoundData()` and `decimals()` answered; null when either call failed. */
export interface FeedAnswer {
  readonly decimals: number;
  readonly roundId: bigint;
  readonly answer: bigint;
  readonly updatedAt: bigint;
  readonly answeredInRound: bigint;
}

export interface FeedReading {
  /** The USDC value of one whole token scaled by 1e18; zero unless the reason is OK. */
  readonly priceE18: PriceE18;
  readonly updatedAt: bigint;
  readonly reason: OracleReason;
}

const MAX_PRICE_E18 = (1n << 128n) - 1n;
const Q96 = 1n << 96n;
const MAX_SQRT_PRICE = (1n << 160n) - 1n;
/** 10^(18 + 18 - 6): a raw USDC-per-raw-MON pool price to a whole-token price scaled by 1e18. */
const POOL_PRICE_SCALE = 10n ** 30n;
const ONE_E18 = 10n ** 18n;
const BPS = BigInt(BPS_DENOMINATOR);

const reading = (priceE18: bigint, updatedAt: bigint, reason: OracleReason): FeedReading => ({
  priceE18: priceE18 as PriceE18,
  updatedAt,
  reason,
});

/**
 * One Chainlink feed (OracleAdapter._feed): decimals, a positive answer that
 * fits, a complete round, not from the future, and strictly younger than the
 * feed's bound (D-151, D-168).
 */
export function readFeed(
  answer: FeedAnswer | null,
  feed: OracleFeed,
  now: bigint,
  limits: PolicyLimits = LAUNCH_LIMITS,
): FeedReading {
  if (answer === null) return reading(0n, 0n, "FEED_REVERTED");
  const decimals = FEED_DECIMALS[feed];
  if (answer.decimals !== decimals) return reading(0n, 0n, "DECIMALS_MISMATCH");
  const { updatedAt } = answer;
  if (answer.answer <= 0n) return reading(0n, updatedAt, "ANSWER_NOT_POSITIVE");
  const scale = 10n ** BigInt(18 - decimals);
  if (answer.answer > MAX_PRICE_E18 / scale) return reading(0n, updatedAt, "ANSWER_OUT_OF_RANGE");
  if (updatedAt === 0n || answer.answeredInRound < answer.roundId)
    return reading(0n, updatedAt, "ROUND_INCOMPLETE");
  if (updatedAt > now) return reading(0n, updatedAt, "FUTURE_TIMESTAMP");
  if (now - updatedAt >= BigInt(limits.oracleMaxAgeSeconds[feed]))
    return reading(0n, updatedAt, "STALE");
  return reading(answer.answer * scale, updatedAt, "OK");
}

export interface PoolReading {
  readonly priceE18: PriceE18;
  readonly reason: OracleReason;
}

/**
 * The v4 pool's spot price (OracleAdapter._pool): currency0 is native MON (18
 * decimals), currency1 USDC (6). Null when StateView could not be read.
 */
export function readPool(sqrtPriceX96: bigint | null): PoolReading {
  const none: PoolReading = { priceE18: 0n as PriceE18, reason: "POOL_UNREADABLE" };
  if (sqrtPriceX96 === null || sqrtPriceX96 === 0n || sqrtPriceX96 > MAX_SQRT_PRICE) return none;
  const price = (((sqrtPriceX96 * sqrtPriceX96) / Q96) * POOL_PRICE_SCALE) / Q96;
  if (price === 0n) return none;
  return { priceE18: price as PriceE18, reason: "OK" };
}

export interface Deviation {
  /** Distance in basis points, rounded down; zero when either price is unusable. */
  readonly bps: bigint;
  /** OK, POOL_DEVIATION, or the first reason either price is unusable. */
  readonly reason: OracleReason;
}

/**
 * The 2% rule (OracleAdapter._deviation): checked exactly, as
 * `diff × 10,000 <= oracle × maxBps`, never on the rounded figure.
 */
export function poolDeviation(
  oracle: FeedReading,
  pool: PoolReading,
  limits: PolicyLimits = LAUNCH_LIMITS,
): Deviation {
  if (oracle.reason !== "OK") return { bps: 0n, reason: oracle.reason };
  if (pool.reason !== "OK") return { bps: 0n, reason: pool.reason };
  const o = oracle.priceE18 as bigint;
  const p = pool.priceE18 as bigint;
  const diff = p > o ? p - o : o - p;
  const within = diff * BPS <= o * BigInt(limits.oracleMaxDeviationBps);
  return { bps: (diff * BPS) / o, reason: within ? "OK" : "POOL_DEVIATION" };
}

/**
 * The depeg guard (OracleAdapter.usdcPeg): USDC/USD must be usable and within
 * the bound of 1. Deposits only; never valuation or trading (D-168).
 */
export function usdcPegReason(
  usdcUsd: FeedReading,
  limits: PolicyLimits = LAUNCH_LIMITS,
): OracleReason {
  if (usdcUsd.reason !== "OK") return usdcUsd.reason;
  const p = usdcUsd.priceE18 as bigint;
  const diff = p > ONE_E18 ? p - ONE_E18 : ONE_E18 - p;
  return diff * BPS > ONE_E18 * BigInt(limits.usdcMaxDepegBps) ? "USDC_DEPEGGED" : "OK";
}
