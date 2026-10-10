import {
  type ExecutorPolicyV3,
  type RejectionCode,
  executorPolicyHashV3,
} from "@alpha-agents/domain";
import { valueE6 } from "./custody.ts";

/**
 * Executor v3's verdict, offchain (F-U4). It mirrors ExecutorV3.swap in
 * chains/monad/src/fund/ExecutorV3.sol: the same checks in the same order over
 * the whole portfolio, the same integer arithmetic, and the first failing rule
 * as the reason, so the chain tools can say exactly what the contract will
 * answer for a trade between any two registered tokens through a route of up
 * to three pools. A shared fixture (executor-v3-parity.ts) holds the two
 * together.
 *
 * What the Executor reads is given to the mirror already resolved, the way the
 * chain tools read it: the registry's record of each token, the account's
 * holdings with the prices the account's own views use, each side's price (a
 * feed's, or an attestation's state), and each hop of the route with its
 * pool's fee and whether the oracle accepts its spot. Session, epoch, replay
 * and account-identity checks need the Executor's own state and are not
 * mirrored; the intent's schema, chain and policy hash are the caller's to
 * get right. Amounts are base units; prices are the USDC value of one whole
 * token scaled by 1e18; values are USDC base units; times are UNIX seconds.
 */

/** Executor v3's launch policy: the v2 limits, 1% against an attested price, the class A caps (D-337, D-352). */
export const LAUNCH_POLICY: ExecutorPolicyV3 = Object.freeze({
  maxTradeBps: 1_000,
  maxAssetBps: 4_000,
  minUsdcBps: 1_000,
  maxSlippageBps: 50,
  maxSlippageClassABps: 100,
  maxClassAPositionBps: 1_500,
  maxClassATotalBps: 5_000,
  maxTurnoverBps: 10_000,
  maxTradesPerWindow: 20,
  windowSeconds: 86_400,
  deadlineSeconds: 120,
});

/** The hash every launch intent names. */
export const LAUNCH_POLICY_HASH = executorPolicyHashV3(LAUNCH_POLICY);

/** ExecutorV3's constants, checked against the contract by the parity test. */
export const CONSTANTS = Object.freeze({
  schemaVersion: 2,
  maxHops: 3,
  ringSize: 20,
  maxSessionSeconds: 30 * 86_400,
  /** The account's own class A caps, which a policy may tighten but never loosen. */
  accountClassAPositionBps: 1_500,
  accountClassATotalBps: 5_000,
  /** The breaker thresholds the Executor reads as a due mode (D-233). */
  breakerReduceOnlyBps: 1_000,
  breakerPauseBps: 2_000,
});

export type LaneV3 = "NONE" | "CORE" | "SCREENED";
export type TokenStatusV3 = "NONE" | "BUYABLE" | "SELL_ONLY" | "FROZEN";
export type PriceClassV3 = "NONE" | "F" | "A";
export type AccountModeV3 = "NORMAL" | "REDUCE_ONLY" | "PAUSED" | "HANDOVER";

/** A token as the TokenRegistry records it (IFund.TokenRecord). */
export interface TokenRuleV3 {
  readonly lane: LaneV3;
  readonly status: TokenStatusV3;
  readonly priceClass: PriceClassV3;
  readonly decimals: number;
  /** The registry's own cap on this token, in basis points of the account's value. */
  readonly maxPositionBps: number;
}

/** A class F side's feed: usable, or not (for any reason: the Executor names ORACLE_STALE). */
export type FeedStateV3 = "OK" | "UNUSABLE";
/** A class A side's attestation, as the registry's verifier judges it. */
export type AttestationStateV3 = "NONE" | "VALID" | "INVALID";
/**
 * A hop's pool against the oracle: OK; POOL_OFF when the pool's spot is too far
 * from the price, unreadable or unsupported (ORACLE_POOL_DEVIATION); FEED_OFF
 * when a feed the comparison needs is unusable (ORACLE_STALE).
 */
export type HopPriceStateV3 = "OK" | "POOL_OFF" | "FEED_OFF";

/** One side of the trade, priced: a feed's state and price, or an attestation's. */
export interface SidePriceV3 {
  readonly priceE18: bigint;
  readonly feed?: FeedStateV3;
  readonly attestation?: AttestationStateV3;
}

/** One held token as the account values it: free balance, cost basis, and the price its views use. */
export interface HoldingV3 {
  readonly token: string;
  readonly free: bigint;
  /** The USDC paid for what is held; for USDC itself its free balance. */
  readonly costBasis: bigint;
  /** The price the account's views use now: a class F feed, or a class A token's last attested price while under a day old (else 0). */
  readonly priceE18: bigint;
  /** False when a class F feed is unusable, which makes every account view revert. */
  readonly priceUsable: boolean;
}

/** One hop of the route, resolved against the ProtocolRegistryV3. */
export interface RouteHopV3 {
  readonly tokenA: string;
  readonly tokenB: string;
  /** The pool's fee in hundredths of a basis point (500 is 0.05%). */
  readonly fee: number;
  /** Whether the registry lets this account's route use the pool now (status, lane, code). */
  readonly usable: boolean;
  readonly price: HopPriceStateV3;
}

export interface ExecutorMarketV3 {
  readonly now: bigint;
  readonly paused: boolean;
  readonly mode: AccountModeV3;
  /** The intent's adapter is registered, active and unchanged. */
  readonly adapterAllowed: boolean;
  /** The factory names an oracle (always, after deployment). */
  readonly oracleSet?: boolean;
  readonly usdc: string;
  readonly wmon: string;
  readonly tokens: Readonly<Record<string, TokenRuleV3>>;
  readonly holdings: readonly HoldingV3[];
  readonly optedIn: boolean;
  readonly attestorSet: boolean;
  /** The trade's two sides, keyed by token. */
  readonly sides: Readonly<Record<string, SidePriceV3>>;
  readonly route: readonly RouteHopV3[];
  /** The account's `breakerState().drawdownBps`, meaningful only when its prices are usable. */
  readonly drawdownBps: bigint;
  readonly trades: readonly { readonly at: bigint; readonly valueUsdcE6: bigint }[];
}

export interface ExecutorIntentV3 {
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly deadline: bigint;
}

export interface VerdictV3 {
  readonly reason: RejectionCode | null;
  /** The account's NAV after the trade at the trade's prices, when it goes through. */
  readonly navAfter: bigint;
}

const BPS = 10_000n;
const ONE_E18 = 10n ** 18n;
const FEE_PER_BPS = 100n;
const NO_RULE: TokenRuleV3 = Object.freeze({
  lane: "NONE",
  status: "NONE",
  priceClass: "NONE",
  decimals: 18,
  maxPositionBps: 0,
});

/** The output the two prices imply for `amountIn`, rounded down at each step (ExecutorV3.impliedOut). */
export function impliedOut(
  amountIn: bigint,
  pxIn: bigint,
  decIn: number,
  pxOut: bigint,
  decOut: number,
): bigint {
  if (pxOut === 0n) return 0n;
  const valueE18 = (amountIn * pxIn) / 10n ** BigInt(decIn);
  return (valueE18 * 10n ** BigInt(decOut)) / pxOut;
}

/** The least `minAmountOut` the Executor accepts: the implied output less the slippage (ExecutorV3.floorFor). */
export function floor(
  amountIn: bigint,
  pxIn: bigint,
  decIn: number,
  pxOut: bigint,
  decOut: number,
  slippageBps: number,
): bigint {
  return (impliedOut(amountIn, pxIn, decIn, pxOut, decOut) * (BPS - BigInt(slippageBps))) / BPS;
}

/** The route's pool fees in basis points, each hop rounded up (ExecutorV3._checkRoute). */
export function routeFeeBps(route: readonly Pick<RouteHopV3, "fee">[]): bigint {
  let fee = 0n;
  for (const h of route) fee += (BigInt(h.fee) + FEE_PER_BPS - 1n) / FEE_PER_BPS;
  return fee;
}

export interface AccountValuesV3 {
  readonly nav: bigint;
  /** The value the caps use: class A at the lower of its basis and its value. */
  readonly capped: bigint;
  readonly totalBasis: bigint;
  readonly classABasis: bigint;
}

/**
 * The account's `navUsdc`, `capValues` and the breaker's NAV from its holdings
 * (CustodyCoreV3._valuation). Null when a class F price is unusable, which
 * makes the views revert and the Executor answer ORACLE_STALE.
 */
export function accountValues(
  holdings: readonly HoldingV3[],
  tokens: Readonly<Record<string, TokenRuleV3>>,
  usdc: string,
): AccountValuesV3 | null {
  let nav = 0n;
  let capped = 0n;
  let totalBasis = 0n;
  let classABasis = 0n;
  for (const h of holdings) {
    const rule = tokens[h.token] ?? NO_RULE;
    const classA = h.token !== usdc && rule.priceClass === "A";
    if (!classA && h.token !== usdc && !h.priceUsable) return null;
    const value = h.token === usdc ? h.free : valueE6(h.free, h.priceE18, rule.decimals);
    const basis = h.token === usdc ? h.free : h.costBasis;
    nav += value;
    totalBasis += basis;
    if (classA) {
      capped += value < basis ? value : basis;
      classABasis += basis;
    } else capped += value;
  }
  return { nav, capped, totalBasis, classABasis };
}

/** Trades and turnover in the rolling window `(now - window, now]`, and when the oldest leaves it. */
export function rollingWindow(
  m: Pick<ExecutorMarketV3, "trades" | "now">,
  p: Pick<ExecutorPolicyV3, "windowSeconds">,
): { readonly count: number; readonly turnover: bigint; readonly oldestLeavesAt: bigint | null } {
  let count = 0;
  let turnover = 0n;
  let oldest: bigint | null = null;
  for (const tr of m.trades) {
    if (tr.at !== 0n && tr.at + BigInt(p.windowSeconds) > m.now && tr.at <= m.now) {
      count += 1;
      turnover += tr.valueUsdcE6;
      if (oldest === null || tr.at < oldest) oldest = tr.at;
    }
  }
  return {
    count,
    turnover,
    oldestLeavesAt: oldest === null ? null : oldest + BigInt(p.windowSeconds),
  };
}

const holdingOf = (m: ExecutorMarketV3, token: string) => m.holdings.find((h) => h.token === token);
const freeOf = (m: ExecutorMarketV3, token: string) => holdingOf(m, token)?.free ?? 0n;
const basisOf = (m: ExecutorMarketV3, token: string) => {
  const h = holdingOf(m, token);
  if (!h) return 0n;
  return token === m.usdc ? h.free : h.costBasis;
};
const ruleOf = (m: ExecutorMarketV3, token: string) => m.tokens[token] ?? NO_RULE;
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** What the pre-trade checks measured, carried to the post-trade checks (ExecutorV3.Measure). */
interface Measure {
  readonly pxIn: bigint;
  readonly pxOut: bigint;
  readonly decIn: number;
  readonly decOut: number;
  readonly classAIn: boolean;
  readonly classAOut: boolean;
  readonly valueIn: bigint;
  readonly feeBps: bigint;
  readonly slippageBps: number;
  readonly capOutBps: bigint;
  readonly values: AccountValuesV3;
}

type Step = { readonly reason: RejectionCode } | { readonly measure: Measure };

/** ExecutorV3._sidePrice: USDC exactly 1, a class F feed, or a class A attestation. */
function sidePrice(
  m: ExecutorMarketV3,
  token: string,
): { readonly px: bigint; readonly classA: boolean } | { readonly reason: RejectionCode } {
  if (token === m.usdc) return { px: ONE_E18, classA: false };
  const rule = ruleOf(m, token);
  const side = m.sides[token];
  if (rule.priceClass === "F") {
    if (!side || side.feed !== "OK") return { reason: "ORACLE_STALE" };
    return { px: side.priceE18, classA: false };
  }
  if (!m.attestorSet) return { reason: "ATTESTOR_UNAVAILABLE" };
  const state = side?.attestation ?? "NONE";
  if (state === "NONE") return { reason: "ATTESTATION_REQUIRED" };
  if (state === "INVALID") return { reason: "ATTESTATION_INVALID" };
  return { px: side?.priceE18 ?? 0n, classA: true };
}

/** ExecutorV3._checkRoute and _checkHopPrice: the route's shape and every hop's pool and price. */
function checkRoute(
  i: ExecutorIntentV3,
  m: ExecutorMarketV3,
  classAIn: boolean,
  classAOut: boolean,
): { readonly reason: RejectionCode } | { readonly feeBps: bigint } {
  const path: string[] = [i.tokenIn];
  let feeBps = 0n;
  const base = (t: string) => t === m.usdc || t === m.wmon;
  for (let k = 0; k < m.route.length; k++) {
    const hop = m.route[k] as RouteHopV3;
    if (!hop.usable) return { reason: "VENUE_NOT_ALLOWED" };
    const at = path[k] as string;
    if (at !== hop.tokenA && at !== hop.tokenB) return { reason: "ROUTE_INVALID" };
    const next = at === hop.tokenA ? hop.tokenB : hop.tokenA;
    if (path.includes(next)) return { reason: "ROUTE_INVALID" };
    path.push(next);
    if (k + 1 < m.route.length) {
      if (!base(next) && ruleOf(m, next).priceClass !== "F") return { reason: "ROUTE_INVALID" };
    } else if (next !== i.tokenOut) return { reason: "ROUTE_INVALID" };
    feeBps += (BigInt(hop.fee) + FEE_PER_BPS - 1n) / FEE_PER_BPS;
    // The token the pool prices: the side that is not a base asset, else WMON.
    const priced = base(hop.tokenA) ? (base(hop.tokenB) ? m.wmon : hop.tokenB) : hop.tokenA;
    const attested = (priced === i.tokenIn && classAIn) || (priced === i.tokenOut && classAOut);
    if (hop.price !== "OK") {
      if (attested || hop.price === "POOL_OFF") return { reason: "ORACLE_POOL_DEVIATION" };
      return { reason: "ORACLE_STALE" };
    }
  }
  return { feeBps };
}

/** The checks before the trade is made, in the contract's order, with what they measured. */
function measure(i: ExecutorIntentV3, m: ExecutorMarketV3, p: ExecutorPolicyV3): Step {
  const intoUsdc = i.tokenOut === m.usdc;
  // _checkIntent
  if (m.paused) return { reason: "PAUSED" };
  if (i.amountIn === 0n || i.minAmountOut === 0n || i.tokenIn === i.tokenOut)
    return { reason: "INTENT_INVALID" };
  if (m.route.length === 0 || m.route.length > CONSTANTS.maxHops)
    return { reason: "ROUTE_INVALID" };
  const rin = ruleOf(m, i.tokenIn);
  if (rin.lane === "NONE") return { reason: "ASSET_NOT_ALLOWED" };
  if (rin.status === "FROZEN") return { reason: "TOKEN_FROZEN" };
  const rout = ruleOf(m, i.tokenOut);
  if (rout.lane === "NONE") return { reason: "ASSET_NOT_ALLOWED" };
  if (!intoUsdc) {
    if (rout.status === "FROZEN") return { reason: "TOKEN_FROZEN" };
    if (rout.status === "SELL_ONLY") return { reason: "TOKEN_SELL_ONLY" };
    if (rout.lane === "SCREENED" && !(rout.status === "BUYABLE" && m.optedIn))
      return { reason: "NOT_OPTED_IN" };
  }
  // _checkSession is the Executor's own state; _checkDeadline
  if (i.deadline < m.now) return { reason: "DEADLINE_EXPIRED" };
  if (i.deadline > m.now + BigInt(p.deadlineSeconds)) return { reason: "DEADLINE_TOO_FAR" };
  // _checkMarket
  if (m.mode === "PAUSED") return { reason: "PAUSED" };
  if (m.mode === "HANDOVER") return { reason: "VAULT_IN_HANDOVER" };
  if (m.mode !== "NORMAL" && !intoUsdc) return { reason: "REDUCE_ONLY_MODE" };
  if (!m.adapterAllowed) return { reason: "VENUE_NOT_ALLOWED" };
  if (m.oracleSet === false) return { reason: "ORACLE_STALE" };
  const sideIn = sidePrice(m, i.tokenIn);
  if ("reason" in sideIn) return sideIn;
  const sideOut = sidePrice(m, i.tokenOut);
  if ("reason" in sideOut) return sideOut;
  const route = checkRoute(i, m, sideIn.classA, sideOut.classA);
  if ("reason" in route) return route;
  if (i.amountIn > freeOf(m, i.tokenIn)) return { reason: "INSUFFICIENT_BALANCE" };
  const values = accountValues(m.holdings, m.tokens, m.usdc);
  if (values === null) return { reason: "ORACLE_STALE" };
  if (m.drawdownBps >= BigInt(CONSTANTS.breakerPauseBps)) return { reason: "PAUSED" };
  if (m.drawdownBps >= BigInt(CONSTANTS.breakerReduceOnlyBps) && !intoUsdc)
    return { reason: "REDUCE_ONLY_MODE" };
  const decIn = i.tokenIn === m.usdc ? 6 : rin.decimals;
  const decOut = intoUsdc ? 6 : rout.decimals;
  const valueIn = valueE6(i.amountIn, sideIn.px, decIn);
  if (valueIn * BPS > values.capped * BigInt(p.maxTradeBps))
    return { reason: "TRADE_SIZE_EXCEEDED" };
  const w = rollingWindow(m, p);
  if (w.count >= p.maxTradesPerWindow) return { reason: "DAILY_TRADE_LIMIT" };
  if ((w.turnover + valueIn) * BPS > values.capped * BigInt(p.maxTurnoverBps))
    return { reason: "TURNOVER_CAP" };
  const slippageBps = sideIn.classA || sideOut.classA ? p.maxSlippageClassABps : p.maxSlippageBps;
  if (i.minAmountOut < floor(i.amountIn, sideIn.px, decIn, sideOut.px, decOut, slippageBps))
    return { reason: "SLIPPAGE_TOO_HIGH" };
  let capOutBps = 0n;
  if (!intoUsdc) {
    // _projectCaps
    if (sideOut.classA) {
      const moved =
        i.tokenIn === m.usdc
          ? i.amountIn
          : (basisOf(m, i.tokenIn) * i.amountIn) / freeOf(m, i.tokenIn);
      const positionAfter = basisOf(m, i.tokenOut) + moved;
      const classAAfter = values.classABasis + (sideIn.classA ? 0n : moved);
      capOutBps = min(BigInt(p.maxClassAPositionBps), BigInt(rout.maxPositionBps));
      if (positionAfter * BPS > values.totalBasis * capOutBps)
        return { reason: "CLASS_A_POSITION_CAP" };
      if (classAAfter * BPS > values.totalBasis * BigInt(p.maxClassATotalBps))
        return { reason: "CLASS_A_TOTAL_CAP" };
    } else {
      const heldAfter = valueE6(freeOf(m, i.tokenOut), sideOut.px, decOut) + valueIn;
      capOutBps = min(BigInt(p.maxAssetBps), BigInt(rout.maxPositionBps));
      if (heldAfter * BPS > values.capped * capOutBps) return { reason: "CONCENTRATION_CAP" };
    }
    const usdcFree = freeOf(m, m.usdc);
    const usdcAfter =
      i.tokenIn === m.usdc ? (usdcFree > i.amountIn ? usdcFree - i.amountIn : 0n) : usdcFree;
    if (usdcAfter * BPS < values.nav * BigInt(p.minUsdcBps)) return { reason: "USDC_FLOOR" };
  }
  return {
    measure: {
      pxIn: sideIn.px,
      pxOut: sideOut.px,
      decIn,
      decOut,
      classAIn: sideIn.classA,
      classAOut: sideOut.classA,
      valueIn,
      feeBps: routeFeeBps(m.route),
      slippageBps,
      capOutBps,
      values,
    },
  };
}

/** The first rule the trade breaks before it is made, or null. */
export function preCheck(
  i: ExecutorIntentV3,
  m: ExecutorMarketV3,
  p: ExecutorPolicyV3 = LAUNCH_POLICY,
): RejectionCode | null {
  const s = measure(i, m, p);
  return "reason" in s ? s.reason : null;
}

/**
 * The account after the fill, at the prices the trade used: the sides' basis
 * moved pro rata (CustodyCoreV3._moveBasis), the sold token gone from the list
 * once empty, and every view recomputed over the new balances with the trade's
 * class A sides now at their attested price.
 */
function afterTrade(
  i: ExecutorIntentV3,
  m: ExecutorMarketV3,
  x: Measure,
  amountOut: bigint,
): { readonly holdings: readonly HoldingV3[]; readonly values: AccountValuesV3 } {
  const freeIn = freeOf(m, i.tokenIn);
  const moved = i.tokenIn === m.usdc ? i.amountIn : (basisOf(m, i.tokenIn) * i.amountIn) / freeIn;
  const list: HoldingV3[] = m.holdings.map((h) => ({ ...h }));
  const ensure = (token: string, px: bigint) => {
    if (!list.some((h) => h.token === token)) {
      list.push({ token, free: 0n, costBasis: 0n, priceE18: px, priceUsable: true });
    }
  };
  ensure(i.tokenIn, x.pxIn);
  ensure(i.tokenOut, x.pxOut);
  const holdings = list.map((h) => {
    if (h.token === i.tokenIn) {
      return {
        ...h,
        free: h.free - i.amountIn,
        costBasis: i.tokenIn === m.usdc ? 0n : h.costBasis - moved,
        priceE18: x.pxIn,
      };
    }
    if (h.token === i.tokenOut) {
      return {
        ...h,
        free: h.free + amountOut,
        costBasis: i.tokenOut === m.usdc ? 0n : h.costBasis + moved,
        priceE18: x.pxOut,
      };
    }
    return h;
  });
  const kept = holdings.filter((h) => h.token === m.usdc || h.free !== 0n);
  const values = accountValues(kept, m.tokens, m.usdc) ?? {
    nav: 0n,
    capped: 0n,
    totalBasis: 0n,
    classABasis: 0n,
  };
  return { holdings: kept, values };
}

/** The post-trade checks on the actual fill (ExecutorV3.onSwap's arrival check and _checkAfter). */
export function postCheck(
  i: ExecutorIntentV3,
  m: ExecutorMarketV3,
  amountOut: bigint,
  p: ExecutorPolicyV3 = LAUNCH_POLICY,
): VerdictV3 {
  const s = measure(i, m, p);
  if ("reason" in s) return { reason: s.reason, navAfter: 0n };
  const x = s.measure;
  if (amountOut < i.minAmountOut) return { reason: "SLIPPAGE_TOO_HIGH", navAfter: 0n };
  const after = afterTrade(i, m, x, amountOut);
  const navAfter = after.values.nav;
  const valueOut = valueE6(amountOut, x.pxOut, x.decOut);
  const allowed = (x.valueIn * (BigInt(x.slippageBps) + x.feeBps)) / BPS;
  if (valueOut + allowed < x.valueIn) return { reason: "SLIPPAGE_TOO_HIGH", navAfter };
  if (i.tokenOut !== m.usdc) {
    const out = after.holdings.find((h) => h.token === i.tokenOut) as HoldingV3;
    if (x.classAOut) {
      if (out.costBasis * BPS > after.values.totalBasis * x.capOutBps)
        return { reason: "CLASS_A_POSITION_CAP", navAfter };
      if (after.values.classABasis * BPS > after.values.totalBasis * BigInt(p.maxClassATotalBps))
        return { reason: "CLASS_A_TOTAL_CAP", navAfter };
    } else {
      const held = valueE6(out.free, x.pxOut, x.decOut);
      if (held * BPS > after.values.capped * x.capOutBps)
        return { reason: "CONCENTRATION_CAP", navAfter };
    }
    const usdcAfter = after.holdings.find((h) => h.token === m.usdc)?.free ?? 0n;
    if (usdcAfter * BPS < navAfter * BigInt(p.minUsdcBps))
      return { reason: "USDC_FLOOR", navAfter };
  }
  return { reason: null, navAfter };
}

/** The whole verdict for a trade the route fills with `amountOut`. */
export function verdict(
  i: ExecutorIntentV3,
  m: ExecutorMarketV3,
  amountOut: bigint,
  p: ExecutorPolicyV3 = LAUNCH_POLICY,
): VerdictV3 {
  return postCheck(i, m, amountOut, p);
}

/**
 * Every rule the trade breaks before it is made, in the Executor's order
 * (F-U5's `tradable_now`). The first entry is always `preCheck`'s answer; the
 * rest are the rules that would still block the trade once the first is
 * cleared, so an agent learns all of them at once. A rule that cannot be
 * evaluated because an earlier input is missing (no price, no readable value)
 * is not guessed at.
 */
export function blockers(
  i: ExecutorIntentV3,
  m: ExecutorMarketV3,
  p: ExecutorPolicyV3 = LAUNCH_POLICY,
): RejectionCode[] {
  const out: RejectionCode[] = [];
  const add = (c: RejectionCode) => {
    if (!out.includes(c)) out.push(c);
  };
  const first = preCheck(i, m, p);
  if (first) add(first);
  const intoUsdc = i.tokenOut === m.usdc;
  if (m.paused) add("PAUSED");
  if (i.amountIn === 0n || i.minAmountOut === 0n || i.tokenIn === i.tokenOut) add("INTENT_INVALID");
  if (m.route.length === 0 || m.route.length > CONSTANTS.maxHops) add("ROUTE_INVALID");
  const rin = ruleOf(m, i.tokenIn);
  const rout = ruleOf(m, i.tokenOut);
  if (rin.lane === "NONE" || rout.lane === "NONE") add("ASSET_NOT_ALLOWED");
  if (rin.status === "FROZEN" || (!intoUsdc && rout.status === "FROZEN")) add("TOKEN_FROZEN");
  if (!intoUsdc && rout.status === "SELL_ONLY") add("TOKEN_SELL_ONLY");
  if (!intoUsdc && rout.lane === "SCREENED" && !(rout.status === "BUYABLE" && m.optedIn))
    add("NOT_OPTED_IN");
  if (i.deadline < m.now) add("DEADLINE_EXPIRED");
  if (i.deadline > m.now + BigInt(p.deadlineSeconds)) add("DEADLINE_TOO_FAR");
  if (m.mode === "PAUSED") add("PAUSED");
  if (m.mode === "HANDOVER") add("VAULT_IN_HANDOVER");
  if (m.mode === "REDUCE_ONLY" && !intoUsdc) add("REDUCE_ONLY_MODE");
  if (!m.adapterAllowed) add("VENUE_NOT_ALLOWED");
  if (m.oracleSet === false) add("ORACLE_STALE");
  const sideIn = sidePrice(m, i.tokenIn);
  const sideOut = sidePrice(m, i.tokenOut);
  if ("reason" in sideIn) add(sideIn.reason);
  if ("reason" in sideOut) add(sideOut.reason);
  if ("reason" in sideIn || "reason" in sideOut) return out;
  const route = checkRoute(i, m, sideIn.classA, sideOut.classA);
  if ("reason" in route) add(route.reason);
  if (i.amountIn > freeOf(m, i.tokenIn)) add("INSUFFICIENT_BALANCE");
  const values = accountValues(m.holdings, m.tokens, m.usdc);
  if (values === null) {
    add("ORACLE_STALE");
    return out;
  }
  if (m.drawdownBps >= BigInt(CONSTANTS.breakerPauseBps)) add("PAUSED");
  if (m.drawdownBps >= BigInt(CONSTANTS.breakerReduceOnlyBps) && !intoUsdc) add("REDUCE_ONLY_MODE");
  const decIn = i.tokenIn === m.usdc ? 6 : rin.decimals;
  const decOut = intoUsdc ? 6 : rout.decimals;
  const valueIn = valueE6(i.amountIn, sideIn.px, decIn);
  if (valueIn * BPS > values.capped * BigInt(p.maxTradeBps)) add("TRADE_SIZE_EXCEEDED");
  const w = rollingWindow(m, p);
  if (w.count >= p.maxTradesPerWindow) add("DAILY_TRADE_LIMIT");
  if ((w.turnover + valueIn) * BPS > values.capped * BigInt(p.maxTurnoverBps)) add("TURNOVER_CAP");
  const slippageBps = sideIn.classA || sideOut.classA ? p.maxSlippageClassABps : p.maxSlippageBps;
  if (i.minAmountOut < floor(i.amountIn, sideIn.px, decIn, sideOut.px, decOut, slippageBps))
    add("SLIPPAGE_TOO_HIGH");
  if (!intoUsdc) {
    const freeIn = freeOf(m, i.tokenIn);
    if (sideOut.classA) {
      const moved =
        i.tokenIn === m.usdc || freeIn === 0n
          ? i.amountIn
          : (basisOf(m, i.tokenIn) * i.amountIn) / freeIn;
      const positionAfter = basisOf(m, i.tokenOut) + moved;
      const classAAfter = values.classABasis + (sideIn.classA ? 0n : moved);
      const cap = min(BigInt(p.maxClassAPositionBps), BigInt(rout.maxPositionBps));
      if (positionAfter * BPS > values.totalBasis * cap) add("CLASS_A_POSITION_CAP");
      if (classAAfter * BPS > values.totalBasis * BigInt(p.maxClassATotalBps))
        add("CLASS_A_TOTAL_CAP");
    } else {
      const heldAfter = valueE6(freeOf(m, i.tokenOut), sideOut.px, decOut) + valueIn;
      const cap = min(BigInt(p.maxAssetBps), BigInt(rout.maxPositionBps));
      if (heldAfter * BPS > values.capped * cap) add("CONCENTRATION_CAP");
    }
    const usdcFree = freeOf(m, m.usdc);
    const usdcAfter =
      i.tokenIn === m.usdc ? (usdcFree > i.amountIn ? usdcFree - i.amountIn : 0n) : usdcFree;
    if (usdcAfter * BPS < values.nav * BigInt(p.minUsdcBps)) add("USDC_FLOOR");
  }
  return out;
}
