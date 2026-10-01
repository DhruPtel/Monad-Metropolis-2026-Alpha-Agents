import {
  ASSET_DECIMALS,
  ASSET_IDS,
  type AccountMode,
  type AmountRaw,
  type AssetId,
  BASE_ASSET,
  BPS_DENOMINATOR,
  type PriceE18,
  REJECTION_MESSAGES,
  type RebalanceIntent,
  type RejectionCode,
  type SwapIntent,
  USDC_PRICE_E18,
  type UnixSeconds,
  type UsdcE6,
  atLeastBps,
  ratioBps,
  valueUsdcE6,
  withinBps,
} from "@alpha-agents/domain";
import { LAUNCH_LIMITS, type PolicyLimits } from "./limits.ts";
import type { AccountState, PastTrade, Rejection } from "./state.ts";

/**
 * Offchain pre-checks of a proposed intent against an account snapshot. Pure:
 * no I/O, no clock (the caller passes `now`), bigint arithmetic only. Every
 * failing rule is reported, so the result can say every reason the agent did not
 * trade. The Executor re-checks everything onchain and is the final authority.
 */
export type PolicyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejections: readonly Rejection[] };

export interface CheckOptions {
  readonly limits?: PolicyLimits;
}

const BPS = BigInt(BPS_DENOMINATOR);

function reject(code: RejectionCode, detail: string): Rejection {
  return { code, message: REJECTION_MESSAGES[code], detail };
}

const isBase = (asset: AssetId) => asset === BASE_ASSET;

function priceOf(state: AccountState, asset: AssetId): PriceE18 {
  if (isBase(asset)) return USDC_PRICE_E18;
  const reading = state.oracle[asset];
  if (!reading) throw new Error(`no oracle reading for ${asset}; check oracles first`);
  return reading.priceE18;
}

function valueOf(state: AccountState, asset: AssetId, amount: AmountRaw): UsdcE6 {
  return valueUsdcE6(amount, ASSET_DECIMALS[asset], priceOf(state, asset));
}

/** Account NAV in USDC base units, from oracle prices. Call only after the oracle checks pass. */
export function navUsdcE6(state: AccountState): UsdcE6 {
  let nav = 0n;
  for (const asset of ASSET_IDS) nav += valueOf(state, asset, state.holdings[asset]);
  return nav as UsdcE6;
}

/** Oracle freshness and pool deviation for one non-USDC asset. A missing reading fails closed. */
export function checkOracle(
  state: AccountState,
  asset: AssetId,
  now: UnixSeconds,
  limits: PolicyLimits = LAUNCH_LIMITS,
): Rejection[] {
  if (isBase(asset)) return [];
  const reading = state.oracle[asset];
  if (!reading) return [reject("ORACLE_STALE", `no oracle reading for ${asset}`)];
  const age = now - reading.updatedAt;
  if (reading.priceE18 <= 0n)
    return [reject("ORACLE_STALE", `${asset} oracle price is not positive`)];
  if (age < 0 || age >= limits.oracleMaxAgeSeconds) {
    return [
      reject(
        "ORACLE_STALE",
        `${asset} oracle age ${age}s, must be under ${limits.oracleMaxAgeSeconds}s`,
      ),
    ];
  }
  const diff =
    reading.poolPriceE18 > reading.priceE18
      ? reading.poolPriceE18 - reading.priceE18
      : reading.priceE18 - reading.poolPriceE18;
  if (!withinBps(diff, reading.priceE18, limits.oracleMaxDeviationBps)) {
    return [
      reject(
        "ORACLE_POOL_DEVIATION",
        `${asset} pool deviates ${ratioBps(diff, reading.priceE18)} bps from the oracle, limit ${limits.oracleMaxDeviationBps}`,
      ),
    ];
  }
  return [];
}

/** Trades inside the rolling window ending at `now`: `now - window < at <= now`. */
export function tradesInWindow(
  trades: readonly PastTrade[],
  now: UnixSeconds,
  limits: PolicyLimits = LAUNCH_LIMITS,
): PastTrade[] {
  return trades.filter((t) => t.at > now - limits.windowSeconds && t.at <= now);
}

export interface WindowUsage {
  readonly tradesUsed: number;
  readonly tradesLeft: number;
  /** When the next trade slot frees up, or null if one is free now. */
  readonly nextSlotFreesAt: UnixSeconds | null;
  readonly turnoverUsedUsdcE6: UsdcE6;
}

/** Trades and turnover used in the rolling window, as `chain.get_limits` reports them. */
export function windowUsage(
  state: AccountState,
  now: UnixSeconds,
  limits: PolicyLimits = LAUNCH_LIMITS,
): WindowUsage {
  const inWindow = tradesInWindow(state.recentTrades, now, limits).sort((a, b) => a.at - b.at);
  const used = inWindow.length;
  const left = Math.max(0, limits.maxTradesPerWindow - used);
  const freeing =
    used >= limits.maxTradesPerWindow ? inWindow[used - limits.maxTradesPerWindow] : undefined;
  return {
    tradesUsed: used,
    tradesLeft: left,
    nextSlotFreesAt: freeing ? freeing.at + limits.windowSeconds : null,
    turnoverUsedUsdcE6: inWindow.reduce((sum, t) => sum + t.valueUsdcE6, 0n) as UsdcE6,
  };
}

/** Mode and epoch gates shared by swaps and rebalances. */
function gates(state: AccountState, increasesRisk: boolean): Rejection[] {
  const out: Rejection[] = [];
  const mode: AccountMode = state.mode;
  if (mode === "PAUSED") out.push(reject("PAUSED", "account mode PAUSED"));
  if (mode === "HANDOVER") {
    out.push(reject("VAULT_IN_HANDOVER", "the vault's new owner has not accepted management yet"));
  }
  if ((mode === "REDUCE_ONLY" || mode === "WIND_DOWN") && increasesRisk) {
    out.push(reject("REDUCE_ONLY_MODE", `account mode ${mode}; only output to USDC is allowed`));
  }
  const e = state.epochs;
  if (e && (e.current.owner !== e.session.owner || e.current.config !== e.session.config)) {
    out.push(
      reject(
        "EPOCH_MISMATCH",
        `session epochs owner ${e.session.owner} config ${e.session.config}, current owner ${e.current.owner} config ${e.current.config}`,
      ),
    );
  }
  return out;
}

function oracleGates(
  state: AccountState,
  assets: Iterable<AssetId>,
  now: UnixSeconds,
  limits: PolicyLimits,
) {
  const out: Rejection[] = [];
  for (const asset of new Set(assets)) out.push(...checkOracle(state, asset, now, limits));
  return out;
}

/** Every non-USDC asset whose price NAV needs: held ones plus the ones named. */
function pricedAssets(state: AccountState, named: readonly AssetId[]): AssetId[] {
  return ASSET_IDS.filter((a) => !isBase(a) && (state.holdings[a] > 0n || named.includes(a)));
}

export interface SwapCheck {
  readonly navUsdcE6: UsdcE6;
  readonly valueUsdcE6: UsdcE6;
  readonly tradesLeftAfter: number;
}

export interface SwapCheckOptions extends CheckOptions {
  /** A venue quote, if one exists yet; checked against the oracle-implied output. */
  readonly quote?: { readonly expectedOutRaw: AmountRaw };
}

/**
 * Pre-checks a swap: mode and epochs, asset allowlist, balance, slippage bound,
 * oracle freshness and deviation, 10% trade size, 20 trades and 100% turnover in
 * the rolling window, and the 40% concentration and 10% USDC floor after the
 * trade. A swap whose output is USDC is exempt from the concentration and floor
 * checks and is the only swap allowed in REDUCE_ONLY or WIND_DOWN.
 */
export function checkSwap(
  intent: SwapIntent,
  state: AccountState,
  now: UnixSeconds,
  options: SwapCheckOptions = {},
): PolicyResult<SwapCheck> {
  const limits = options.limits ?? LAUNCH_LIMITS;
  const { sell, buy, sellAmountRaw } = intent;
  const reducesRisk = isBase(buy);
  const rejections = gates(state, !reducesRisk);

  if (!state.buyAllowlist.includes(buy)) {
    rejections.push(reject("ASSET_NOT_ALLOWED", `${buy} is not on the buy allowlist`));
  }
  if (state.holdings[sell] < sellAmountRaw) {
    rejections.push(
      reject("INSUFFICIENT_BALANCE", `sell ${sellAmountRaw} ${sell}, held ${state.holdings[sell]}`),
    );
  }
  const slippageBps = intent.maxSlippageBps ?? limits.maxSlippageBps;
  if (slippageBps > limits.maxSlippageBps) {
    rejections.push(
      reject("SLIPPAGE_TOO_HIGH", `requested ${slippageBps} bps, limit ${limits.maxSlippageBps}`),
    );
  }

  const oracleRejections = oracleGates(state, pricedAssets(state, [sell, buy]), now, limits);
  if (oracleRejections.length > 0) {
    // Without trusted prices nothing below can be valued; fail closed here.
    return { ok: false, rejections: [...rejections, ...oracleRejections] };
  }

  const nav = navUsdcE6(state);
  const value = valueOf(state, sell, sellAmountRaw);

  if (!withinBps(value, nav, limits.maxTradeBps)) {
    rejections.push(
      reject(
        "TRADE_SIZE_EXCEEDED",
        `trade ${ratioBps(value, nav)} bps of NAV (${value} of ${nav}), limit ${limits.maxTradeBps}`,
      ),
    );
  }

  const usage = windowUsage(state, now, limits);
  if (usage.tradesLeft === 0) {
    rejections.push(
      reject(
        "DAILY_TRADE_LIMIT",
        `${usage.tradesUsed} trades in the window, limit ${limits.maxTradesPerWindow}, next slot at ${usage.nextSlotFreesAt}`,
      ),
    );
  }
  const turnover = usage.turnoverUsedUsdcE6 + value;
  if (!withinBps(turnover, nav, limits.maxTurnoverBps)) {
    rejections.push(
      reject(
        "TURNOVER_CAP",
        `turnover would be ${ratioBps(turnover, nav)} bps of NAV, limit ${limits.maxTurnoverBps}`,
      ),
    );
  }

  if (!reducesRisk) {
    // Post-trade projection at oracle prices: NAV is unchanged, `value` moves from sell to buy.
    const buyAfter = valueOf(state, buy, state.holdings[buy]) + value;
    if (!withinBps(buyAfter, nav, limits.maxAssetBps)) {
      rejections.push(
        reject(
          "CONCENTRATION_CAP",
          `${buy} would be ${ratioBps(buyAfter, nav)} bps of NAV, limit ${limits.maxAssetBps}`,
        ),
      );
    }
    const usdcBefore = valueOf(state, BASE_ASSET, state.holdings[BASE_ASSET]);
    const usdcAfter = isBase(sell) ? usdcBefore - value : usdcBefore;
    if (!atLeastBps(usdcAfter, nav, limits.minUsdcBps)) {
      rejections.push(
        reject(
          "USDC_FLOOR",
          `USDC would be ${ratioBps(usdcAfter, nav)} bps of NAV, minimum ${limits.minUsdcBps}`,
        ),
      );
    }
  }

  if (options.quote) {
    // Oracle-implied output in buy units, then the floor `slippageBps` below it.
    const implied =
      (sellAmountRaw * priceOf(state, sell) * 10n ** BigInt(ASSET_DECIMALS[buy])) /
      (priceOf(state, buy) * 10n ** BigInt(ASSET_DECIMALS[sell]));
    const floor = (implied * (BPS - BigInt(Math.min(slippageBps, limits.maxSlippageBps)))) / BPS;
    if (options.quote.expectedOutRaw < floor) {
      rejections.push(
        reject(
          "SLIPPAGE_TOO_HIGH",
          `quote ${options.quote.expectedOutRaw} ${buy} is below the oracle floor ${floor}`,
        ),
      );
    }
  }

  if (rejections.length > 0) return { ok: false, rejections };
  return {
    ok: true,
    value: { navUsdcE6: nav, valueUsdcE6: value, tradesLeftAfter: usage.tradesLeft - 1 },
  };
}

export interface RebalanceLeg {
  readonly sell: AssetId;
  readonly buy: AssetId;
  readonly valueUsdcE6: UsdcE6;
}

export interface RebalanceCheck {
  readonly navUsdcE6: UsdcE6;
  /** Sells first, then buys; each leg is at most the per-trade cap and uses one trade slot. */
  readonly legs: readonly RebalanceLeg[];
}

/**
 * Pre-checks a rebalance and plans its legs (FINAL_PLAN 4.4.2): targets inside
 * the 40% and 10% limits, legs above the per-trade cap split into sequential
 * legs, and enough trade slots and turnover left for all of them. Deltas within
 * `toleranceBps` of NAV are left alone.
 */
export function checkRebalance(
  intent: RebalanceIntent,
  state: AccountState,
  now: UnixSeconds,
  options: CheckOptions = {},
): PolicyResult<RebalanceCheck> {
  const limits = options.limits ?? LAUNCH_LIMITS;
  const target = (asset: AssetId) => intent.targets.find((t) => t.asset === asset)?.targetBps ?? 0;
  const rejections: Rejection[] = [];

  for (const asset of ASSET_IDS) {
    const bps = target(asset);
    if (isBase(asset) && bps < limits.minUsdcBps) {
      rejections.push(reject("USDC_FLOOR", `USDC target ${bps} bps, minimum ${limits.minUsdcBps}`));
    }
    if (!isBase(asset) && bps > limits.maxAssetBps) {
      rejections.push(
        reject("CONCENTRATION_CAP", `${asset} target ${bps} bps, limit ${limits.maxAssetBps}`),
      );
    }
  }

  const named = intent.targets.map((t) => t.asset);
  const oracleRejections = oracleGates(state, pricedAssets(state, named), now, limits);
  if (oracleRejections.length > 0) {
    return { ok: false, rejections: [...gates(state, false), ...rejections, ...oracleRejections] };
  }

  const nav = navUsdcE6(state);
  const tolerance = (nav * BigInt(intent.toleranceBps ?? 0)) / BPS;
  const maxTrade = (nav * BigInt(limits.maxTradeBps)) / BPS;
  const sells: RebalanceLeg[] = [];
  const buys: RebalanceLeg[] = [];
  let increasesRisk = false;

  for (const asset of ASSET_IDS) {
    if (isBase(asset)) continue;
    const current = valueOf(state, asset, state.holdings[asset]);
    const wanted = (nav * BigInt(target(asset))) / BPS;
    const delta = wanted - current;
    const size = delta < 0n ? -delta : delta;
    if (size === 0n || size <= tolerance) continue;
    if (delta > 0n) {
      increasesRisk = true;
      if (!state.buyAllowlist.includes(asset)) {
        rejections.push(reject("ASSET_NOT_ALLOWED", `${asset} is not on the buy allowlist`));
        continue;
      }
    }
    if (maxTrade === 0n) {
      rejections.push(reject("TRADE_SIZE_EXCEEDED", "account value is zero"));
      continue;
    }
    const legs = delta < 0n ? sells : buys;
    for (let remaining = size; remaining > 0n; remaining -= maxTrade) {
      const leg = (remaining < maxTrade ? remaining : maxTrade) as UsdcE6;
      legs.push(
        delta < 0n
          ? { sell: asset, buy: BASE_ASSET, valueUsdcE6: leg }
          : { sell: BASE_ASSET, buy: asset, valueUsdcE6: leg },
      );
    }
  }
  rejections.unshift(...gates(state, increasesRisk));

  const legs = [...sells, ...buys];
  const usage = windowUsage(state, now, limits);
  if (legs.length > usage.tradesLeft) {
    rejections.push(
      reject(
        "DAILY_TRADE_LIMIT",
        `rebalance needs ${legs.length} trades, ${usage.tradesLeft} left in the window`,
      ),
    );
  }
  const turnover = legs.reduce((sum, l) => sum + l.valueUsdcE6, usage.turnoverUsedUsdcE6 as bigint);
  if (!withinBps(turnover, nav, limits.maxTurnoverBps)) {
    rejections.push(
      reject(
        "TURNOVER_CAP",
        `turnover would be ${ratioBps(turnover, nav)} bps of NAV, limit ${limits.maxTurnoverBps}`,
      ),
    );
  }

  if (rejections.length > 0) return { ok: false, rejections };
  return { ok: true, value: { navUsdcE6: nav, legs } };
}

/** The Executor's deadline rule: `now <= deadline <= now + deadlineSeconds`. */
export function checkDeadline(
  deadline: UnixSeconds,
  now: UnixSeconds,
  limits: PolicyLimits = LAUNCH_LIMITS,
): Rejection | undefined {
  if (deadline < now)
    return reject("DEADLINE_EXPIRED", `deadline ${deadline} is before now ${now}`);
  if (deadline > now + limits.deadlineSeconds) {
    return reject(
      "DEADLINE_TOO_FAR",
      `deadline ${deadline} is more than ${limits.deadlineSeconds}s after now ${now}`,
    );
  }
  return undefined;
}

/** Drawdown from the peak in basis points, rounded down. Zero at or above the peak. */
export function drawdownBps(peak: bigint, current: bigint): bigint {
  if (peak <= 0n || current >= peak) return 0n;
  return ratioBps(peak - current, peak);
}

/**
 * The circuit breaker (FINAL_PLAN 4.7.8): at a 10% drop from the 7-day peak of
 * NAV per share the account becomes REDUCE_ONLY, at 20% PAUSED. Peak and current
 * must share one scale. Thresholds are inclusive: exactly 10% trips reduce-only.
 */
export function breakerMode(
  peak: bigint,
  current: bigint,
  limits: PolicyLimits = LAUNCH_LIMITS,
): "NORMAL" | "REDUCE_ONLY" | "PAUSED" {
  if (peak <= 0n || current >= peak) return "NORMAL";
  const drop = peak - current;
  if (atLeastBps(drop, peak, limits.breakerPauseBps)) return "PAUSED";
  if (atLeastBps(drop, peak, limits.breakerReduceOnlyBps)) return "REDUCE_ONLY";
  return "NORMAL";
}
