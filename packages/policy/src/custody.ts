import { PEAK_DAYS, type PeakBucket, peakOf } from "./breaker.ts";
import { breakerMode } from "./checks.ts";

/**
 * The custody core v3's rules, offchain (F-U3, FINAL_PLAN 0.4, D-337, D-343):
 * the held list, valuation across many tokens with class A at its attested
 * price (and at zero a day after the last one), the cost-basis ledger and the
 * class A caps that need no price, the core's value backstops, and the
 * flow-adjusted breaker over the whole portfolio. Each function mirrors one
 * part of chains/monad/src/fund/CustodyCoreV3.sol and PersonalAccountV3.sol
 * in the same order and with the same integer arithmetic, so the chain tools
 * and the runner can say in advance what the account will answer. The fund
 * parity fixture replays the same sequences through both
 * (chains/monad/test/fund/CustodyV3Parity.t.sol), and a test fails if they
 * ever disagree.
 *
 * Amounts are base units; prices are the USDC value of one whole token
 * scaled by 1e18; values are USDC base units (6 decimals); times are UNIX seconds.
 */

/** The core's constants (CustodyCoreV3), checked against the contract by the parity test. */
export const CUSTODY_V3 = Object.freeze({
  maxTradeBps: 1_200,
  maxAssetBps: 4_500,
  maxClassAPositionBps: 1_500,
  maxClassATotalBps: 5_000,
  maxSlippageBps: 100,
  maxDepegBps: 100,
  maxHeldTokens: 16,
  attestedPriceTtlSeconds: 86_400,
  maxDecimals: 36,
  breakerReduceOnlyBps: 1_000,
  breakerPauseBps: 2_000,
  peakDays: PEAK_DAYS,
});

const BPS = 10_000n;
const ONE_E18 = 10n ** 18n;
const UNITS_PER_USDC_E6 = 10n ** 12n;
const PER_UNIT_SCALE = 10n ** 30n;
const MAX_BUCKET = (1n << 224n) - 1n;
const TTL = BigInt(CUSTODY_V3.attestedPriceTtlSeconds);
const DAY = 86_400n;

/** The tokens of the parity fixture, in the forge base's terms (CustodyV3Base). */
export const CUSTODY_TOKENS = ["USDC", "WMON", "A", "B", "C", "D", "E", "F"] as const;
export type CustodyToken = (typeof CUSTODY_TOKENS)[number];
export type PriceClassV3 = "USDC" | "F" | "A";

export interface CustodyTokenSpec {
  readonly decimals: number;
  readonly priceClass: PriceClassV3;
  /** A screened-lane token: buyable only after the owner's opt-in (D-351). */
  readonly screened: boolean;
}

export const CUSTODY_TOKEN_SPECS: Readonly<Record<CustodyToken, CustodyTokenSpec>> = Object.freeze({
  USDC: { decimals: 6, priceClass: "USDC", screened: false },
  WMON: { decimals: 18, priceClass: "F", screened: false },
  A: { decimals: 18, priceClass: "F", screened: false },
  B: { decimals: 8, priceClass: "F", screened: false },
  C: { decimals: 18, priceClass: "A", screened: false },
  D: { decimals: 6, priceClass: "A", screened: true },
  E: { decimals: 18, priceClass: "A", screened: true },
  F: { decimals: 18, priceClass: "A", screened: true },
});

/** The USDC value (6 decimals) of an amount at a price, rounded down (CustodyCoreV3._valueOf). */
export function valueE6(amount: bigint, priceE18: bigint, decimals: number): bigint {
  if (amount === 0n || priceE18 === 0n) return 0n;
  return (amount * priceE18) / 10n ** BigInt(decimals + 12);
}

export interface PositionV3 {
  readonly amount: bigint;
  /** USDC paid for what is held; unused for USDC itself. */
  readonly costBasis: bigint;
  readonly lastPriceE18: bigint;
  readonly lastPricedAt: bigint;
}

export type ModeV3 = "NORMAL" | "REDUCE_ONLY" | "PAUSED";
export const MODES_V3: readonly ModeV3[] = ["NORMAL", "REDUCE_ONLY", "PAUSED"];

export interface CustodyState {
  /** The held list, USDC first, in the contract's order. */
  readonly held: readonly CustodyToken[];
  readonly positions: Readonly<Record<CustodyToken, PositionV3>>;
  readonly units: bigint;
  readonly principal: bigint;
  readonly mode: ModeV3;
  readonly buckets: readonly PeakBucket[];
  readonly optIn: boolean;
}

const EMPTY_POSITION: PositionV3 = Object.freeze({
  amount: 0n,
  costBasis: 0n,
  lastPriceE18: 0n,
  lastPricedAt: 0n,
});
const NO_BUCKETS: readonly PeakBucket[] = Object.freeze(
  Array.from({ length: PEAK_DAYS }, () => ({ day: 0n, value: 0n })),
);

export function emptyCustody(): CustodyState {
  const positions = {} as Record<CustodyToken, PositionV3>;
  for (const t of CUSTODY_TOKENS) positions[t] = EMPTY_POSITION;
  return {
    held: ["USDC"],
    positions,
    units: 0n,
    principal: 0n,
    mode: "NORMAL",
    buckets: NO_BUCKETS,
    optIn: false,
  };
}

/**
 * What the oracle answers in one call: every class F token's feed price, and
 * the attestations passed for class A tokens (none for a view or a plain poke).
 */
export interface PriceContext {
  readonly now: bigint;
  readonly feeds: Readonly<Partial<Record<CustodyToken, bigint>>>;
  readonly attested: Readonly<Partial<Record<CustodyToken, bigint>>>;
}

export interface ValuationV3 {
  readonly prices: Readonly<Record<CustodyToken, bigint>>;
  /** Priced in this call by a feed or an attestation (cached afterwards). */
  readonly fresh: Readonly<Record<CustodyToken, boolean>>;
  readonly nav: bigint;
  /** Class A at the lower of its basis and its value (D-337). */
  readonly capped: bigint;
  readonly totalBasis: bigint;
  readonly classABasis: bigint;
}

function basisOf(state: CustodyState, t: CustodyToken): bigint {
  return t === "USDC" ? state.positions[t].amount : state.positions[t].costBasis;
}

/**
 * CustodyCoreV3._valuation and _totals: every held token at its price. A class
 * F token with no usable feed fails closed (throws); a class A token takes the
 * attestation given, else its last price while under a day old, else zero.
 */
export function valuation(state: CustodyState, ctx: PriceContext): ValuationV3 {
  const prices = {} as Record<CustodyToken, bigint>;
  const fresh = {} as Record<CustodyToken, boolean>;
  for (const t of CUSTODY_TOKENS) {
    prices[t] = 0n;
    fresh[t] = false;
  }
  let nav = 0n;
  let capped = 0n;
  let totalBasis = 0n;
  let classABasis = 0n;
  for (const t of state.held) {
    const spec = CUSTODY_TOKEN_SPECS[t];
    const pos = state.positions[t];
    if (spec.priceClass === "USDC") {
      prices[t] = ONE_E18;
      fresh[t] = true;
    } else if (spec.priceClass === "F") {
      const px = ctx.feeds[t];
      if (px === undefined) throw new Error(`PriceUnavailable(${t})`);
      prices[t] = px;
      fresh[t] = true;
    } else {
      const att = ctx.attested[t];
      if (att !== undefined) {
        prices[t] = att;
        fresh[t] = true;
      } else if (pos.lastPricedAt + TTL > ctx.now) {
        prices[t] = pos.lastPriceE18;
      }
    }
    const value = valueE6(pos.amount, prices[t], spec.decimals);
    const basis = basisOf(state, t);
    nav += value;
    totalBasis += basis;
    if (spec.priceClass === "A") {
      capped += value < basis ? value : basis;
      classABasis += basis;
    } else {
      capped += value;
    }
  }
  return { prices, fresh, nav, capped, totalBasis, classABasis };
}

/** CustodyCoreV3._cachePrices: the prices this call read, written to the positions. */
function cachePrices(state: CustodyState, v: ValuationV3, now: bigint): CustodyState {
  const positions = { ...state.positions };
  for (const t of state.held) {
    if (t === "USDC" || !v.fresh[t]) continue;
    positions[t] = { ...positions[t], lastPriceE18: v.prices[t], lastPricedAt: now };
  }
  return { ...state, positions };
}

export const perUnitE18 = (navE6: bigint, units: bigint): bigint =>
  units === 0n ? 0n : (navE6 * PER_UNIT_SCALE) / units;

const tighter = (current: ModeV3, due: ModeV3): ModeV3 => {
  if (due === "PAUSED" && current !== "PAUSED") return "PAUSED";
  if (due === "REDUCE_ONLY" && current === "NORMAL") return "REDUCE_ONLY";
  return current;
};

export interface ObservationV3 {
  readonly state: CustodyState;
  readonly perUnit: bigint;
  readonly peak: bigint;
}

/** CustodyCoreV3._observe: records a value per unit for today and applies the breaker. */
export function observe(state: CustodyState, navE6: bigint, now: bigint): ObservationV3 {
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
  const mode = tighter(state.mode, breakerMode(peak, perUnit));
  return { state: { ...state, buckets, mode }, perUnit, peak };
}

/** CustodyCoreV3._breakerMode: what refuses new risk before a trade, unpoked. */
export function breakerModeNow(state: CustodyState, navE6: bigint, now: bigint): ModeV3 {
  const perUnit = perUnitE18(navE6, state.units);
  if (perUnit === 0n) return "NORMAL";
  const peak = peakOf(state.buckets, now);
  return breakerMode(perUnit > peak ? perUnit : peak, perUnit);
}

export type FailureV3 =
  | "NotBuyable"
  | "ReduceOnly"
  | "TradeTooLarge"
  | "OutputTooLow"
  | "SlippageTooHigh"
  | "ConcentrationTooHigh"
  | "ClassAPositionTooLarge"
  | "ClassATooLarge"
  | "AccountValueZero"
  | "DepositsPaused"
  | "PersonalCapExceeded"
  | "InsufficientFree";

export type OutcomeV3 = { readonly ok: true } | { readonly ok: false; readonly failure: FailureV3 };
const OK: OutcomeV3 = { ok: true };
const fail = (failure: FailureV3): OutcomeV3 => ({ ok: false, failure });

function addHeld(state: CustodyState, t: CustodyToken): CustodyState {
  if (state.held.includes(t)) return state;
  if (state.held.length >= CUSTODY_V3.maxHeldTokens) throw new Error("TooManyHeldTokens");
  return { ...state, held: [...state.held, t] };
}

/** CustodyCoreV3._removeHeld: swap with the last and pop; the record is cleared. */
function removeHeld(state: CustodyState, t: CustodyToken): CustodyState {
  const i = state.held.indexOf(t);
  if (i < 0) return state;
  const held = [...state.held];
  const last = held.length - 1;
  if (i !== last) held[i] = held[last] as CustodyToken;
  held.pop();
  return { ...state, held, positions: { ...state.positions, [t]: EMPTY_POSITION } };
}

function withPosition(
  state: CustodyState,
  t: CustodyToken,
  patch: Partial<PositionV3>,
): CustodyState {
  return { ...state, positions: { ...state.positions, [t]: { ...state.positions[t], ...patch } } };
}

/** The forge base's per-account cap, the default for the model's deposits. */
export const CUSTODY_FIXTURE_CAP = 1_000_000_000n;

/**
 * PersonalAccountV3.deposit of USDC or a core class F token: the portfolio
 * valued once, units minted at the value per unit before, the basis grown by
 * the value, the principal held to the factory's per-account cap. The
 * allowlist, the platform cap and the depeg guard are the caller's to keep.
 */
export function deposit(
  state: CustodyState,
  token: CustodyToken,
  amount: bigint,
  ctx: PriceContext,
  cap: bigint = CUSTODY_FIXTURE_CAP,
): { readonly state: CustodyState; readonly outcome: OutcomeV3 } {
  if (state.mode === "PAUSED") return { state, outcome: fail("DepositsPaused") };
  let s = addHeld(state, token);
  const v = valuation(s, ctx);
  const spec = CUSTODY_TOKEN_SPECS[token];
  const value = valueE6(amount, v.prices[token], spec.decimals);
  let minted: bigint;
  if (s.units === 0n) minted = value * UNITS_PER_USDC_E6;
  else {
    if (v.nav === 0n) return { state, outcome: fail("AccountValueZero") };
    minted = (value * s.units) / v.nav;
  }
  if (s.principal + value > cap) return { state, outcome: fail("PersonalCapExceeded") };
  s = cachePrices(s, v, ctx.now);
  s = { ...s, units: s.units + minted, principal: s.principal + value };
  const pos = s.positions[token];
  s = withPosition(s, token, {
    amount: pos.amount + amount,
    costBasis: token === "USDC" ? 0n : pos.costBasis + value,
  });
  return { state: s, outcome: OK };
}

/** NAV at the last prices every priced action used (CustodyCoreV3._navAtLastPrices). */
function navAtLastPrices(state: CustodyState): bigint {
  let nav = 0n;
  for (const t of state.held) {
    const pos = state.positions[t];
    const px = t === "USDC" ? ONE_E18 : pos.lastPriceE18;
    nav += valueE6(pos.amount, px, CUSTODY_TOKEN_SPECS[t].decimals);
  }
  return nav;
}

const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);

/**
 * CustodyCoreV3.withdraw and PersonalAccountV3's hooks: no oracle. Units burn
 * in proportion to the exact fall in NAV at the last prices, the principal
 * falls by USDC taken out (or to zero once empty), the basis takes its share,
 * and a token with nothing left leaves the list.
 */
export function withdraw(state: CustodyState, token: CustodyToken, amount: bigint): CustodyState {
  const held = state.held.includes(token);
  const before = state.positions[token].amount;
  if (amount > before) throw new Error("withdrawal above the balance");
  const after = before - amount;
  let s = withPosition(state, token, { amount: after });
  const freeOut = held ? amount : 0n;
  const empty = s.held.every((t) => s.positions[t].amount === 0n);
  // _burnUnits
  const u = s.units;
  if (u !== 0n) {
    let left = 0n;
    if (!empty) {
      if (freeOut === 0n) left = u;
      else {
        const spec = CUSTODY_TOKEN_SPECS[token];
        const px = token === "USDC" ? ONE_E18 : s.positions[token].lastPriceE18;
        const valueOut =
          valueE6(after + freeOut, px, spec.decimals) - valueE6(after, px, spec.decimals);
        if (valueOut === 0n) left = u;
        else left = u - ceilDiv(u * valueOut, navAtLastPrices(s) + valueOut);
      }
    }
    if (left !== u) s = { ...s, units: left };
    if (left === 0n) s = { ...s, buckets: NO_BUCKETS };
  }
  // _reducePrincipal
  const p = s.principal;
  if (p !== 0n) {
    let reduce = token === "USDC" ? (amount < p ? amount : p) : 0n;
    if (empty) reduce = p;
    if (reduce !== 0n) s = { ...s, principal: p - reduce };
  }
  // _reduceBasis
  if (token !== "USDC" && held && freeOut !== 0n && before !== 0n) {
    const basis = s.positions[token].costBasis;
    const cut = (basis * freeOut) / before;
    if (cut !== 0n) s = withPosition(s, token, { costBasis: basis - cut });
  }
  if (after === 0n && token !== "USDC" && held) s = removeHeld(s, token);
  return s;
}

/** The mock Executor's fair fill (MockExecutorV3.quote): the test venue's rule, not the contract's. */
export function mockFill(
  tokenIn: CustodyToken,
  tokenOut: CustodyToken,
  amountIn: bigint,
  priceIn: bigint,
  priceOut: bigint,
  outputBps: bigint,
): bigint {
  const decIn = BigInt(CUSTODY_TOKEN_SPECS[tokenIn].decimals);
  const decOut = BigInt(CUSTODY_TOKEN_SPECS[tokenOut].decimals);
  const fair = (amountIn * priceIn * 10n ** decOut) / (priceOut * 10n ** decIn);
  return (fair * outputBps) / BPS;
}

export interface SwapInput {
  readonly tokenIn: CustodyToken;
  readonly tokenOut: CustodyToken;
  readonly amountIn: bigint;
  /** The fill the venue pays, in bps of the fair amount (the mock Executor's knob). */
  readonly outputBps: bigint;
  /** The reference prices the Executor attests for class A sides, and the venue fills at. */
  readonly reference: Readonly<Record<CustodyToken, bigint>>;
}

/**
 * CustodyCoreV3.executeSwap with an honest-or-not venue: every check in the
 * contract's order, then the basis move, the caps and the breaker's record.
 */
export function swap(
  state: CustodyState,
  input: SwapInput,
  ctx: Omit<PriceContext, "attested">,
): { readonly state: CustodyState; readonly outcome: OutcomeV3 } {
  const { tokenIn, tokenOut, amountIn } = input;
  const inSpec = CUSTODY_TOKEN_SPECS[tokenIn];
  const outSpec = CUSTODY_TOKEN_SPECS[tokenOut];
  // _checkSwap
  if (!state.held.includes(tokenIn)) throw new Error("NotHeldAsset");
  if (tokenOut !== "USDC" && outSpec.screened && !state.optIn) {
    return { state, outcome: fail("NotBuyable") };
  }
  if (state.mode !== "NORMAL" && tokenOut !== "USDC") return { state, outcome: fail("ReduceOnly") };
  // _addHeld, then the valuation with the sides' attestations
  let s = addHeld(state, tokenOut);
  const attested: Partial<Record<CustodyToken, bigint>> = {};
  if (inSpec.priceClass === "A") attested[tokenIn] = input.reference[tokenIn];
  if (outSpec.priceClass === "A") attested[tokenOut] = input.reference[tokenOut];
  const v = valuation(s, { ...ctx, attested });
  s = cachePrices(s, v, ctx.now);
  // _before
  const priceIn = v.prices[tokenIn];
  const priceOut = v.prices[tokenOut];
  const freeIn = s.positions[tokenIn].amount;
  if (amountIn > freeIn) return { state, outcome: fail("InsufficientFree") };
  if (tokenOut !== "USDC" && breakerModeNow(s, v.nav, ctx.now) !== "NORMAL") {
    return { state, outcome: fail("ReduceOnly") };
  }
  const valueIn = valueE6(amountIn, priceIn, inSpec.decimals);
  if (valueIn * BPS > v.capped * BigInt(CUSTODY_V3.maxTradeBps)) {
    return { state, outcome: fail("TradeTooLarge") };
  }
  // The venue
  const received = mockFill(tokenIn, tokenOut, amountIn, priceIn, priceOut, input.outputBps);
  const spent = amountIn;
  // _after
  if (received === 0n) return { state, outcome: fail("OutputTooLow") };
  const valueSpent = valueE6(spent, priceIn, inSpec.decimals);
  const valueOut = valueE6(received, priceOut, outSpec.decimals);
  if (valueOut * BPS < valueSpent * (BPS - BigInt(CUSTODY_V3.maxSlippageBps))) {
    return { state, outcome: fail("SlippageTooHigh") };
  }
  // _moveBasis
  let moved: bigint;
  if (tokenIn === "USDC") moved = spent;
  else {
    const basis = s.positions[tokenIn].costBasis;
    moved = freeIn === 0n ? 0n : (basis * spent) / freeIn;
    if (moved !== 0n) s = withPosition(s, tokenIn, { costBasis: basis - moved });
  }
  if (tokenOut !== "USDC" && moved !== 0n) {
    s = withPosition(s, tokenOut, { costBasis: s.positions[tokenOut].costBasis + moved });
  }
  s = withPosition(s, tokenIn, { amount: freeIn - spent });
  s = withPosition(s, tokenOut, { amount: s.positions[tokenOut].amount + received });
  // _totals over the post-trade balances, at the same prices
  let nav = 0n;
  let capped = 0n;
  let totalBasis = 0n;
  let classABasis = 0n;
  for (const t of s.held) {
    const spec = CUSTODY_TOKEN_SPECS[t];
    const value = valueE6(s.positions[t].amount, v.prices[t], spec.decimals);
    const basis = basisOf(s, t);
    nav += value;
    totalBasis += basis;
    if (spec.priceClass === "A") {
      capped += value < basis ? value : basis;
      classABasis += basis;
    } else capped += value;
  }
  if (tokenOut !== "USDC") {
    if (outSpec.priceClass === "A") {
      const basis = s.positions[tokenOut].costBasis;
      if (basis * BPS > totalBasis * BigInt(CUSTODY_V3.maxClassAPositionBps)) {
        return { state, outcome: fail("ClassAPositionTooLarge") };
      }
      if (classABasis * BPS > totalBasis * BigInt(CUSTODY_V3.maxClassATotalBps)) {
        return { state, outcome: fail("ClassATooLarge") };
      }
    } else {
      const held = valueE6(s.positions[tokenOut].amount, priceOut, outSpec.decimals);
      if (held * BPS > capped * BigInt(CUSTODY_V3.maxAssetBps)) {
        return { state, outcome: fail("ConcentrationTooHigh") };
      }
    }
  }
  if (s.positions[tokenIn].amount === 0n && tokenIn !== "USDC") s = removeHeld(s, tokenIn);
  s = observe(s, nav, ctx.now).state;
  return { state: s, outcome: OK };
}

/** CustodyCoreV3.poke: values the account, caches the fresh prices, records the result. */
export function poke(
  state: CustodyState,
  ctx: PriceContext,
): ObservationV3 & { readonly nav: bigint } {
  const v = valuation(state, ctx);
  const s = cachePrices(state, v, ctx.now);
  return { ...observe(s, v.nav, ctx.now), nav: v.nav };
}

/** The owner's unpause: NORMAL, and the peak starts again from the next observation. */
export const unpause = (state: CustodyState): CustodyState => ({
  ...state,
  mode: "NORMAL",
  buckets: NO_BUCKETS,
});

export const setOptIn = (state: CustodyState, optIn: boolean): CustodyState => ({
  ...state,
  optIn,
});

// ---------------------------------------------------------------------------
// The fixture: sequences replayed on both sides
// ---------------------------------------------------------------------------

/** The forge base's reference prices (CustodyV3Base), USDC per whole token scaled by 1e18. */
export const CUSTODY_REFERENCE_PRICES: Readonly<Record<CustodyToken, bigint>> = Object.freeze({
  USDC: ONE_E18,
  WMON: 2n * ONE_E18,
  A: 6n * ONE_E18,
  B: 40n * ONE_E18,
  C: (ONE_E18 / 10n) * 4n,
  D: 2n * ONE_E18,
  E: ONE_E18 / 2n,
  F: 10n * ONE_E18,
});

/** The fixture's clock starts here: the forge base's time plus twenty days. */
export const CUSTODY_T0 = 1_790_876_425n + 20n * DAY;
const CAP = CUSTODY_FIXTURE_CAP;

type Op =
  | { op: "deposit"; token: CustodyToken; amount: bigint }
  | { op: "withdraw"; token: CustodyToken; amount: bigint }
  | { op: "swap"; token: CustodyToken; tokenOut: CustodyToken; amount: bigint; outputBps: bigint }
  | { op: "attest"; token: CustodyToken; priceE18: bigint }
  | { op: "price"; token: "A" | "MON"; answer: bigint }
  | { op: "warp"; warp: bigint }
  | { op: "poke"; token: CustodyToken | "" }
  | { op: "optIn"; flag: boolean }
  | { op: "unpause" };

interface Clock {
  now: bigint;
  /** 8-decimal feed answers, as the forge feeds hold them. */
  aAnswer: bigint;
  monAnswer: bigint;
  reference: Record<CustodyToken, bigint>;
}

/** Class F prices from the feed answers: WMON at MON/USD, A at its feed, B as 20 MON (its composite). */
function feeds(c: Clock): Partial<Record<CustodyToken, bigint>> {
  const mon = c.monAnswer * 10n ** 10n;
  return {
    USDC: ONE_E18,
    WMON: mon,
    A: c.aAnswer * 10n ** 10n,
    B: (20n * ONE_E18 * mon) / ONE_E18,
  };
}

const s = (v: bigint) => v.toString();

/** Applies one op to the model, returning the record the forge replay checks. */
function step(state: CustodyState, c: Clock, o: Op) {
  let next = state;
  let outcome: OutcomeV3 = OK;
  let perUnit = 0n;
  let pokePeak = 0n;
  switch (o.op) {
    case "deposit": {
      const r = deposit(state, o.token, o.amount, { now: c.now, feeds: feeds(c), attested: {} });
      next = r.state;
      outcome = r.outcome;
      break;
    }
    case "withdraw":
      next = withdraw(state, o.token, o.amount);
      break;
    case "swap": {
      const r = swap(
        state,
        {
          tokenIn: o.token,
          tokenOut: o.tokenOut,
          amountIn: o.amount,
          outputBps: o.outputBps,
          reference: { ...c.reference },
        },
        { now: c.now, feeds: feeds(c) },
      );
      next = r.state;
      outcome = r.outcome;
      break;
    }
    case "attest":
      c.reference[o.token] = o.priceE18;
      break;
    case "price":
      if (o.token === "A") c.aAnswer = o.answer;
      else c.monAnswer = o.answer;
      c.reference.A = c.aAnswer * 10n ** 10n;
      c.reference.WMON = c.monAnswer * 10n ** 10n;
      c.reference.B = (20n * ONE_E18 * c.reference.WMON) / ONE_E18;
      break;
    case "warp":
      c.now += o.warp;
      break;
    case "poke": {
      const attested: Partial<Record<CustodyToken, bigint>> = {};
      if (o.token !== "") attested[o.token] = c.reference[o.token];
      const r = poke(state, { now: c.now, feeds: feeds(c), attested });
      next = r.state;
      perUnit = r.perUnit;
      pokePeak = r.peak;
      break;
    }
    case "optIn":
      next = setOptIn(state, o.flag);
      break;
    case "unpause":
      next = unpause(state);
      break;
  }
  // What the views answer afterwards, with no attestation: class A at its cached price while fresh.
  const view = valuation(next, { now: c.now, feeds: feeds(c), attested: {} });
  return {
    record: {
      op: o.op,
      token: "token" in o ? o.token : "",
      tokenOut: o.op === "swap" ? o.tokenOut : "",
      amount: "amount" in o ? s(o.amount) : "0",
      outputBps: o.op === "swap" ? s(o.outputBps) : "0",
      priceE18: o.op === "attest" ? s(o.priceE18) : "0",
      answer: o.op === "price" ? s(o.answer) : "0",
      warp: o.op === "warp" ? s(o.warp) : "0",
      flag: o.op === "optIn" ? o.flag : false,
      ok: outcome.ok,
      failure: outcome.ok ? "" : outcome.failure,
      units: s(next.units),
      principal: s(next.principal),
      mode: MODES_V3.indexOf(next.mode),
      nav: s(view.nav),
      capped: s(view.capped),
      totalBasis: s(view.totalBasis),
      classABasis: s(view.classABasis),
      amounts: CUSTODY_TOKENS.map((t) => s(next.positions[t].amount)),
      bases: CUSTODY_TOKENS.map((t) => s(basisOf(next, t))),
      heldCount: next.held.length,
      perUnit: s(perUnit),
      pokePeak: s(pokePeak),
    },
    state: next,
  };
}

function newClock(): Clock {
  return {
    now: CUSTODY_T0,
    aAnswer: 6n * 10n ** 8n,
    monAnswer: 2n * 10n ** 8n,
    reference: { ...CUSTODY_REFERENCE_PRICES },
  };
}

function replay(name: string, ops: readonly Op[]) {
  let state = emptyCustody();
  const c = newClock();
  const steps = ops.map((o) => {
    const r = step(state, c, o);
    state = r.state;
    return r.record;
  });
  return { name, stepCount: steps.length, steps };
}

const dep = (token: CustodyToken, amount: bigint): Op => ({ op: "deposit", token, amount });
const wd = (token: CustodyToken, amount: bigint): Op => ({ op: "withdraw", token, amount });
const sw = (token: CustodyToken, tokenOut: CustodyToken, amount: bigint, outputBps = BPS): Op => ({
  op: "swap",
  token,
  tokenOut,
  amount,
  outputBps,
});
const att = (token: CustodyToken, priceE18: bigint): Op => ({ op: "attest", token, priceE18 });
const price = (token: "A" | "MON", answer: bigint): Op => ({ op: "price", token, answer });
const warp = (seconds: bigint): Op => ({ op: "warp", warp: seconds });
const POKE: Op = { op: "poke", token: "" };
const pokeWith = (token: CustodyToken): Op => ({ op: "poke", token });
const optIn = (flag: boolean): Op => ({ op: "optIn", flag });
const UNPAUSE: Op = { op: "unpause" };

const E6 = 10n ** 6n;
const E8 = 10n ** 8n;

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const big = (lo: bigint, hi: bigint) => {
    const span = hi - lo + 1n;
    let v = 0n;
    for (let i = 0; i < 4; i++) v = (v << 32n) | BigInt(int(0, 0xffffffff));
    return lo + (v % span);
  };
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)] as T;
  return { next, int, big, pick };
}

/**
 * Random but valid sequences: deposits of core class F tokens within the cap,
 * withdrawals and swaps within the balance, price moves, attestations (some
 * wild), waits that let class A prices age out, pokes and opt-in changes.
 * Every refusal the account can give to these is one the model predicts.
 */
function randomSequence(seed: number, length: number): Op[] {
  const r = rng(seed);
  const ops: Op[] = [];
  let state = emptyCustody();
  const c = newClock();
  const depositable: CustodyToken[] = ["USDC", "WMON", "A", "B"];
  const classA: CustodyToken[] = ["C", "D", "E", "F"];
  for (let i = 0; i < length; i++) {
    const roll = r.next();
    let o: Op;
    if (roll < 0.22) {
      const token = r.pick(depositable);
      const room = CAP - state.principal;
      if (room === 0n) o = POKE;
      else {
        const value = r.big(1n, room < 300n * E6 ? room : 300n * E6);
        const px = feeds(c)[token] as bigint;
        const amount = (value * 10n ** BigInt(CUSTODY_TOKEN_SPECS[token].decimals + 12)) / px;
        o = amount === 0n ? POKE : dep(token, amount);
      }
    } else if (roll < 0.4) {
      const held = state.held.filter((t) => state.positions[t].amount > 0n);
      if (held.length === 0) o = POKE;
      else {
        const token = r.pick(held);
        const bal = state.positions[token].amount;
        o = wd(token, r.next() < 0.2 ? bal : r.big(1n, bal));
      }
    } else if (roll < 0.68) {
      const held = state.held.filter((t) => state.positions[t].amount > 0n);
      if (held.length === 0) o = POKE;
      else {
        const tokenIn = r.pick(held);
        const others = CUSTODY_TOKENS.filter((t) => t !== tokenIn);
        const tokenOut = r.next() < 0.4 ? "USDC" : r.pick(others);
        const bal = state.positions[tokenIn].amount;
        // Mostly inside the 12% cap, sometimes anywhere in the balance.
        const amount = r.next() < 0.7 ? r.big(1n, bal / 8n + 1n) : r.big(1n, bal);
        const outputBps = r.pick([BPS, BPS, BPS, BPS, 9_950n, 9_899n]);
        o =
          tokenOut === tokenIn
            ? POKE
            : sw(tokenIn, tokenOut, amount > bal ? bal : amount, outputBps);
      }
    } else if (roll < 0.76) {
      const token = r.pick(classA);
      const ref = CUSTODY_REFERENCE_PRICES[token];
      const factor = r.next() < 0.15 ? r.pick([100n, 1n]) : r.big(50n, 200n);
      const divisor = r.next() < 0.15 ? r.pick([1n, 100n]) : 100n;
      o = att(token, (ref * factor) / divisor);
    } else if (roll < 0.82) {
      const which = r.pick(["A", "MON"] as const);
      const base = which === "A" ? c.aAnswer : c.monAnswer;
      let answer = (base * r.big(7_500n, 12_500n)) / 10_000n;
      if (answer === 0n) answer = 1n;
      o = price(which, answer);
    } else if (roll < 0.88) {
      o = warp(r.pick([60n, 3_600n, 12n * 3_600n, DAY - 1n, DAY, 2n * DAY]));
    } else if (roll < 0.92) {
      o = optIn(!state.optIn);
    } else if (roll < 0.95 && state.mode !== "NORMAL") {
      o = UNPAUSE;
    } else {
      o = r.next() < 0.4 ? pokeWith(r.pick(classA)) : POKE;
    }
    state = step(state, c, o).state;
    ops.push(o);
  }
  ops.push(POKE);
  return ops;
}

export function buildCustodyCases() {
  const cases = [
    replay(
      "deposits build the basis, a sale realizes it, a swap moves it, a withdrawal takes its share",
      [
        dep("USDC", 600n * E6),
        dep("A", 50n * ONE_E18),
        sw("USDC", "A", 60n * E6),
        sw("A", "B", 10n * ONE_E18),
        sw("B", "USDC", E8 / 2n),
        wd("A", 4n * ONE_E18),
        POKE,
      ],
    ),
    replay("the class A position cap: 15% of the basis passes, one unit over does not", [
      dep("USDC", 600n * E6),
      dep("A", 50n * ONE_E18),
      sw("USDC", "C", 100n * E6),
      sw("USDC", "C", 35n * E6),
      sw("USDC", "C", 1n),
    ]),
    replay("the class A total cap: 50% of the basis across four positions, one unit over refused", [
      dep("USDC", 600n * E6),
      dep("A", 50n * ONE_E18),
      optIn(true),
      sw("USDC", "C", 100n * E6),
      sw("USDC", "C", 35n * E6),
      sw("USDC", "D", 100n * E6),
      sw("USDC", "D", 35n * E6),
      sw("USDC", "E", 100n * E6),
      sw("USDC", "E", 35n * E6),
      sw("USDC", "F", 45n * E6),
      sw("USDC", "F", 1n),
      sw("F", "USDC", ONE_E18),
      sw("USDC", "F", 10n * E6),
    ]),
    replay(
      "a wrong attested price widens nothing: high, the basis caps the position; low, the capped value shrinks trades",
      [
        dep("USDC", 600n * E6),
        dep("A", 50n * ONE_E18),
        sw("USDC", "C", 100n * E6),
        att("C", 40n * ONE_E18),
        sw("USDC", "C", 35n * E6),
        sw("USDC", "C", 1n),
        att("C", ONE_E18 / 250n),
        pokeWith("C"),
        sw("A", "USDC", 15_333_333_333_333_333_334n),
        sw("A", "USDC", 15n * ONE_E18),
      ],
    ),
    replay(
      "a class A token counts at its attested price, then at zero a day later, and the breaker trips",
      [
        dep("USDC", 600n * E6),
        dep("A", 50n * ONE_E18),
        sw("USDC", "C", 100n * E6),
        sw("USDC", "C", 35n * E6),
        POKE,
        warp(DAY - 1n),
        POKE,
        warp(1n),
        POKE,
        pokeWith("C"),
        UNPAUSE,
        POKE,
      ],
    ),
    replay("flows across many tokens never move the value per unit", [
      dep("USDC", 30n * E6),
      dep("A", 20n * ONE_E18),
      dep("B", E8),
      POKE,
      wd("USDC", 25n * E6),
      dep("USDC", 40n * E6),
      wd("A", 19n * ONE_E18),
      dep("B", 3n * E8),
      wd("B", 2n * E8),
      dep("WMON", 3n * ONE_E18),
      POKE,
    ]),
    replay("the 12% trade and 45% value backstops at their thresholds", [
      dep("USDC", 600n * E6),
      dep("A", 50n * ONE_E18),
      sw("A", "USDC", 18_000_000_166_666_666_667n),
      sw("A", "USDC", 18n * ONE_E18),
      dep("A", 18n * ONE_E18),
      sw("USDC", "A", 105n * E6),
      sw("USDC", "A", 1_200_000n),
      sw("A", "USDC", 10n * ONE_E18),
    ]),
    replay("a screened token is unbuyable until the owner opts in, and opting out is instant", [
      dep("USDC", 600n * E6),
      sw("USDC", "D", 50n * E6),
      optIn(true),
      sw("USDC", "D", 50n * E6),
      optIn(false),
      sw("USDC", "D", E6),
      sw("D", "USDC", 5n * E6),
      wd("D", 20n * E6),
    ]),
    replay("selling a token entirely removes it and its basis; a slow fill is refused at 1%", [
      dep("USDC", 600n * E6),
      sw("USDC", "B", 40n * E6),
      sw("B", "USDC", E8, 9_899n),
      sw("B", "USDC", E8, 9_900n),
      sw("USDC", "A", 60n * E6, 9_950n),
      POKE,
    ]),
    replay("a drawdown nobody poked refuses new risk, and a sale records it", [
      dep("USDC", 600n * E6),
      dep("A", 50n * ONE_E18),
      POKE,
      price("A", 420_000_000n),
      sw("USDC", "A", E6),
      sw("A", "USDC", 5n * ONE_E18),
      price("A", 300_000_000n),
      POKE,
      UNPAUSE,
      POKE,
    ]),
  ];
  for (let i = 0; i < 30; i++) {
    cases.push(replay(`random ${i}`, randomSequence(7_000 + i, 14)));
  }
  return cases;
}
