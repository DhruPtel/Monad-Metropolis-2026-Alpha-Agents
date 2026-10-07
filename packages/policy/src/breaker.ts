import { breakerMode } from "./checks.ts";
import { LAUNCH_LIMITS, type PolicyLimits } from "./limits.ts";

/**
 * A PersonalAccount's circuit breaker, offchain (FINAL_PLAN 4.7.8, P2-U3,
 * D-233). It mirrors CustodyCore and PersonalAccount exactly: internal units
 * minted and burned at the value per unit, eight daily peak buckets, and
 * tighten-only modes. The sentinel and the chain tools use it to say what the
 * account will do; the parity fixture holds it to the contract.
 *
 * Amounts are base units: USDC 6 decimals, WMON 18, units 18. Prices are the
 * USDC value of one whole WMON scaled by 1e18. Times are UNIX seconds.
 */

export type BreakerMode = "NORMAL" | "REDUCE_ONLY" | "PAUSED";

export interface PeakBucket {
  readonly day: bigint;
  readonly value: bigint;
}

export interface AccountBreakerState {
  /** Free balances (balance minus any claimable credit). */
  readonly usdc: bigint;
  readonly wmon: bigint;
  readonly units: bigint;
  readonly mode: BreakerMode;
  /** Eight daily buckets, indexed by `day % 8`. */
  readonly buckets: readonly PeakBucket[];
  /** The last WMON price a priced action used: what a withdrawal values at. */
  readonly lastWmonPriceE18: bigint;
}

export const PEAK_DAYS = 8;
const DAY = 86_400n;
const UNITS_PER_USDC_E6 = 10n ** 12n;
const PER_UNIT_SCALE = 10n ** 30n;
const WMON_VALUE_SCALE = 10n ** 30n;
const MAX_BUCKET = (1n << 224n) - 1n;
const NO_BUCKETS: readonly PeakBucket[] = Object.freeze(
  Array.from({ length: PEAK_DAYS }, () => ({ day: 0n, value: 0n })),
);

export const emptyAccount = (): AccountBreakerState => ({
  usdc: 0n,
  wmon: 0n,
  units: 0n,
  mode: "NORMAL",
  buckets: NO_BUCKETS,
  lastWmonPriceE18: 0n,
});

const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);

/** The USDC value of a WMON amount at a price, rounded down. */
export const wmonValueE6 = (amount: bigint, priceE18: bigint) =>
  (amount * priceE18) / WMON_VALUE_SCALE;

/** NAV at a WMON price: USDC one for one, WMON at the price. */
export const navAt = (s: Pick<AccountBreakerState, "usdc" | "wmon">, priceE18: bigint) =>
  s.usdc + wmonValueE6(s.wmon, priceE18);

/** The value per unit scaled by 1e18 (1e18 is 1 USDC per unit); zero with no units. */
export const perUnitE18 = (navE6: bigint, units: bigint) =>
  units === 0n ? 0n : (navE6 * PER_UNIT_SCALE) / units;

/** The highest bucket from today and the 7 days before. */
export function peakOf(buckets: readonly PeakBucket[], now: bigint): bigint {
  const today = now / DAY;
  let peak = 0n;
  for (const b of buckets) {
    if (b.value > peak && b.day <= today && b.day + BigInt(PEAK_DAYS) > today) peak = b.value;
  }
  return peak;
}

const tighter = (current: BreakerMode, due: BreakerMode): BreakerMode => {
  if (due === "PAUSED" && current !== "PAUSED") return "PAUSED";
  if (due === "REDUCE_ONLY" && current === "NORMAL") return "REDUCE_ONLY";
  return current;
};

export interface Observation {
  readonly state: AccountBreakerState;
  readonly perUnit: bigint;
  readonly peak: bigint;
}

/** Records a value per unit for today and applies the breaker (CustodyCore._observe). */
export function observe(
  state: AccountBreakerState,
  navE6: bigint,
  now: bigint,
  limits: PolicyLimits = LAUNCH_LIMITS,
): Observation {
  const perUnit = perUnitE18(navE6, state.units);
  if (perUnit === 0n) return { state, perUnit, peak: peakOf(state.buckets, now) };
  const today = now / DAY;
  const slot = Number(today % BigInt(PEAK_DAYS));
  const v = perUnit > MAX_BUCKET ? MAX_BUCKET : perUnit;
  const buckets = state.buckets.map((b, i) => {
    if (i !== slot) return b;
    if (b.day !== today) return { day: today, value: v };
    return v > b.value ? { day: today, value: v } : b;
  });
  const peak = peakOf(buckets, now);
  const mode = tighter(state.mode, breakerMode(peak, perUnit, limits));
  return { state: { ...state, buckets, mode }, perUnit, peak };
}

/**
 * The mode the breaker calls for now, counting the current value as a peak if
 * it is higher (CustodyCore._breakerMode): what refuses new risk before a trade.
 */
export function breakerModeNow(
  state: AccountBreakerState,
  navE6: bigint,
  now: bigint,
  limits: PolicyLimits = LAUNCH_LIMITS,
): BreakerMode {
  const perUnit = perUnitE18(navE6, state.units);
  if (perUnit === 0n) return "NORMAL";
  const peak = peakOf(state.buckets, now);
  return breakerMode(perUnit > peak ? perUnit : peak, perUnit, limits);
}

const cache = (s: AccountBreakerState, priceE18: bigint): AccountBreakerState =>
  priceE18 === 0n ? s : { ...s, lastWmonPriceE18: priceE18 };

/**
 * A deposit (PersonalAccount.deposit): WMON is priced when deposited or held,
 * units are minted at the value per unit before it, rounding down. Throws
 * where the contract reverts for a units reason; caps, modes and the oracle
 * are the caller's to check.
 */
export function deposit(
  state: AccountBreakerState,
  token: "USDC" | "WMON",
  amount: bigint,
  wmonPriceE18: bigint,
): AccountBreakerState {
  const px = token === "WMON" || state.wmon > 0n ? wmonPriceE18 : 0n;
  const s = cache(state, px);
  const navBefore = navAt(s, px);
  const value = token === "USDC" ? amount : wmonValueE6(amount, px);
  let minted: bigint;
  if (s.units === 0n) minted = value * UNITS_PER_USDC_E6;
  else {
    if (navBefore === 0n) throw new Error("AccountValueZero");
    minted = (value * s.units) / navBefore;
  }
  return {
    ...s,
    units: s.units + minted,
    usdc: token === "USDC" ? s.usdc + amount : s.usdc,
    wmon: token === "WMON" ? s.wmon + amount : s.wmon,
  };
}

/**
 * A withdrawal (PersonalAccount._burnUnits): no oracle; what left is valued as
 * the exact fall in NAV at the last price, and units burn in proportion,
 * rounding up. An empty account, or one whose units all burn, starts afresh.
 */
export function withdraw(
  state: AccountBreakerState,
  token: "USDC" | "WMON",
  amount: bigint,
): AccountBreakerState {
  const held = token === "USDC" ? state.usdc : state.wmon;
  if (amount > held) throw new Error("withdrawal above the balance");
  const after: AccountBreakerState = {
    ...state,
    usdc: token === "USDC" ? state.usdc - amount : state.usdc,
    wmon: token === "WMON" ? state.wmon - amount : state.wmon,
  };
  const u = state.units;
  if (u === 0n) return after;
  const reset = { ...after, units: 0n, buckets: NO_BUCKETS };
  if (after.usdc === 0n && after.wmon === 0n) return reset;
  if (amount === 0n) return after;
  const px = state.lastWmonPriceE18;
  const value = (x: bigint) => (token === "USDC" ? x : wmonValueE6(x, px));
  const freeAfter = token === "USDC" ? after.usdc : after.wmon;
  const valueOut = value(freeAfter + amount) - value(freeAfter);
  if (valueOut === 0n) return after;
  const burn = ceilDiv(u * valueOut, navAt(after, px) + valueOut);
  const left = u - burn;
  return left === 0n ? reset : { ...after, units: left };
}

/** `poke()`: values the account (WMON only if held), records it, applies the breaker. */
export function poke(
  state: AccountBreakerState,
  wmonPriceE18: bigint,
  now: bigint,
  limits: PolicyLimits = LAUNCH_LIMITS,
): Observation & { readonly nav: bigint } {
  const px = state.wmon > 0n ? wmonPriceE18 : 0n;
  const s = cache(state, px);
  const nav = navAt(s, px);
  return { ...observe(s, nav, now, limits), nav };
}

/** The owner's unpause: NORMAL, and the peak starts again from the next observation. */
export const unpause = (state: AccountBreakerState): AccountBreakerState => ({
  ...state,
  mode: "NORMAL",
  buckets: NO_BUCKETS,
});
