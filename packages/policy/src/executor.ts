import { type ExecutorPolicy, type RejectionCode, executorPolicyHash } from "@alpha-agents/domain";
import { LAUNCH_LIMITS } from "./limits.ts";
import type { OracleReason } from "./oracle.ts";

/**
 * The Executor's verdict, offchain (P2-U2). It mirrors Executor.swap in
 * chains/monad/src/executor/Executor.sol: the same checks in the same order,
 * the same integer arithmetic, and the first failing rule as the reason, so
 * the chain tools can say exactly what the contract will answer. A shared
 * fixture (parity.ts, executor cases) holds the two together.
 *
 * Session, epoch, replay and account checks need the Executor's own state and
 * are not mirrored here; they come after the global pause and the intent's
 * shape and before the deadline, so a fixture case always passes them.
 */

export const LAUNCH_EXECUTOR_POLICY: ExecutorPolicy = Object.freeze({
  maxTradeBps: LAUNCH_LIMITS.maxTradeBps,
  maxAssetBps: LAUNCH_LIMITS.maxAssetBps,
  minUsdcBps: LAUNCH_LIMITS.minUsdcBps,
  maxSlippageBps: LAUNCH_LIMITS.maxSlippageBps,
  maxTurnoverBps: LAUNCH_LIMITS.maxTurnoverBps,
  maxTradesPerWindow: LAUNCH_LIMITS.maxTradesPerWindow,
  windowSeconds: LAUNCH_LIMITS.windowSeconds,
  deadlineSeconds: LAUNCH_LIMITS.deadlineSeconds,
});

/** The hash every launch intent names. */
export const LAUNCH_POLICY_HASH = executorPolicyHash(LAUNCH_EXECUTOR_POLICY);

export type ExecutorAsset = "USDC" | "WMON";

/** What the Executor reads before a trade. */
export interface ExecutorMarket {
  /** Free balances: USDC 6 decimals, WMON 18. */
  readonly usdc: bigint;
  readonly wmon: bigint;
  /** MON/USD as the oracle adapter reads it, scaled by 1e18. */
  readonly priceE18: bigint;
  /** The adapter's `tradable(WMON)` reason. */
  readonly oracleReason: OracleReason;
  readonly mode: "NORMAL" | "REDUCE_ONLY" | "PAUSED";
  /** The account's `breakerState().drawdownBps` (rounded down). */
  readonly drawdownBps: bigint;
  /** The Executor's ring buffer for the account. */
  readonly trades: readonly { readonly at: bigint; readonly valueUsdcE6: bigint }[];
  readonly now: bigint;
  readonly paused: boolean;
  readonly buyable: boolean;
  readonly venueAllowed: boolean;
}

export interface ExecutorTrade {
  readonly tokenIn: ExecutorAsset;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly deadline: bigint;
}

const BPS = 10_000n;
const WMON_VALUE_SCALE = 10n ** 30n;

const valueOf = (token: ExecutorAsset, amount: bigint, px: bigint) =>
  token === "USDC" ? amount : (amount * px) / WMON_VALUE_SCALE;

/** The least `minAmountOut` the Executor accepts (Executor.oracleFloor). */
export function oracleFloor(
  tokenIn: ExecutorAsset,
  amountIn: bigint,
  px: bigint,
  slippageBps: number,
) {
  const implied =
    tokenIn === "WMON" ? valueOf("WMON", amountIn, px) : (amountIn * WMON_VALUE_SCALE) / px;
  return (implied * (BPS - BigInt(slippageBps))) / BPS;
}

/** NAV in USDC at the price: free USDC plus free WMON's value. */
export const executorNav = (usdc: bigint, wmon: bigint, px: bigint) =>
  usdc + valueOf("WMON", wmon, px);

/** The first rule the trade breaks before it is made, or null. */
export function executorPreCheck(
  t: ExecutorTrade,
  m: ExecutorMarket,
  p: ExecutorPolicy = LAUNCH_EXECUTOR_POLICY,
): RejectionCode | null {
  const buy = t.tokenIn === "USDC";
  if (m.paused) return "PAUSED";
  if (t.amountIn === 0n || t.minAmountOut === 0n) return "INTENT_INVALID";
  if (buy && !m.buyable) return "ASSET_NOT_ALLOWED";
  if (t.deadline < m.now) return "DEADLINE_EXPIRED";
  if (t.deadline > m.now + BigInt(p.deadlineSeconds)) return "DEADLINE_TOO_FAR";
  if (m.mode === "PAUSED") return "PAUSED";
  if (m.mode !== "NORMAL" && buy) return "REDUCE_ONLY_MODE";
  if (!m.venueAllowed) return "VENUE_NOT_ALLOWED";
  if (m.oracleReason !== "OK")
    return m.oracleReason === "POOL_DEVIATION" || m.oracleReason === "POOL_UNREADABLE"
      ? "ORACLE_POOL_DEVIATION"
      : "ORACLE_STALE";
  if (t.amountIn > (buy ? m.usdc : m.wmon)) return "INSUFFICIENT_BALANCE";
  const px = m.priceE18;
  const nav = executorNav(m.usdc, m.wmon, px);
  if (m.drawdownBps >= 2_000n) return "PAUSED";
  if (m.drawdownBps >= 1_000n && buy) return "REDUCE_ONLY_MODE";
  const valueIn = valueOf(t.tokenIn, t.amountIn, px);
  if (valueIn * BPS > nav * BigInt(p.maxTradeBps)) return "TRADE_SIZE_EXCEEDED";
  let count = 0;
  let turnover = 0n;
  for (const tr of m.trades) {
    if (tr.at !== 0n && tr.at + BigInt(p.windowSeconds) > m.now && tr.at <= m.now) {
      count += 1;
      turnover += tr.valueUsdcE6;
    }
  }
  if (count >= p.maxTradesPerWindow) return "DAILY_TRADE_LIMIT";
  if ((turnover + valueIn) * BPS > nav * BigInt(p.maxTurnoverBps)) return "TURNOVER_CAP";
  if (t.minAmountOut < oracleFloor(t.tokenIn, t.amountIn, px, p.maxSlippageBps))
    return "SLIPPAGE_TOO_HIGH";
  if (buy) {
    const wmonAfter = valueOf("WMON", m.wmon, px) + valueIn;
    const usdcAfter = m.usdc > valueIn ? m.usdc - valueIn : 0n;
    if (wmonAfter * BPS > nav * BigInt(p.maxAssetBps)) return "CONCENTRATION_CAP";
    if (usdcAfter * BPS < nav * BigInt(p.minUsdcBps)) return "USDC_FLOOR";
  }
  return null;
}

/** The post-trade checks on the actual fill (Executor._checkAfter). */
export function executorPostCheck(
  t: ExecutorTrade,
  m: ExecutorMarket,
  amountOut: bigint,
  feeBps: number,
  p: ExecutorPolicy = LAUNCH_EXECUTOR_POLICY,
): { readonly reason: RejectionCode | null; readonly navAfter: bigint } {
  const buy = t.tokenIn === "USDC";
  const px = m.priceE18;
  const usdc = buy ? m.usdc - t.amountIn : m.usdc + amountOut;
  const wmon = buy ? m.wmon + amountOut : m.wmon - t.amountIn;
  const wmonValue = valueOf("WMON", wmon, px);
  const navAfter = usdc + wmonValue;
  const navBefore = executorNav(m.usdc, m.wmon, px);
  const valueIn = valueOf(t.tokenIn, t.amountIn, px);
  const allowed = (valueIn * BigInt(p.maxSlippageBps + feeBps)) / BPS;
  if (navAfter + allowed < navBefore) return { reason: "SLIPPAGE_TOO_HIGH", navAfter };
  if (buy) {
    if (wmonValue * BPS > navAfter * BigInt(p.maxAssetBps))
      return { reason: "CONCENTRATION_CAP", navAfter };
    if (usdc * BPS < navAfter * BigInt(p.minUsdcBps)) return { reason: "USDC_FLOOR", navAfter };
  }
  return { reason: null, navAfter };
}

/** The whole verdict for a trade the venue fills with `amountOut`. */
export function executorVerdict(
  t: ExecutorTrade,
  m: ExecutorMarket,
  amountOut: bigint,
  feeBps: number,
  p: ExecutorPolicy = LAUNCH_EXECUTOR_POLICY,
): { readonly reason: RejectionCode | null; readonly navAfter: bigint } {
  const pre = executorPreCheck(t, m, p);
  if (pre) return { reason: pre, navAfter: 0n };
  return executorPostCheck(t, m, amountOut, feeBps, p);
}
