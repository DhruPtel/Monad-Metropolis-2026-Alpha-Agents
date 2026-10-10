import { REJECTION_CODES } from "@alpha-agents/domain";
import { peakOf } from "./breaker.ts";
import * as custody from "./custody.ts";
import {
  CUSTODY_REFERENCE_PRICES,
  CUSTODY_TOKEN_SPECS,
  type CustodyToken,
  valueE6,
} from "./custody.ts";
import * as ex from "./executor-v3.ts";

/**
 * The Executor v3 parity fixture (F-U4): executor-v3-parity.json. Each case
 * describes an account built the same way on both sides (deposits at a peak
 * MON price, class A positions bought through the honest venue at fair fills,
 * a poke), then the market the trade meets (a MON move, feed ages, the pool's
 * spot, the account's mode, the registries' statuses, the Executor's ring) and
 * one intent with its fill. The model here derives the account's state with
 * the custody core's mirror (custody.ts), hands the Executor's mirror what it
 * would read, and writes down its verdict; chains/monad/test/fund/
 * ExecutorV3Parity.t.sol replays every case on the real contracts and requires
 * the same answer. Tokens, prices and pools are ExecutorV3Base's.
 */

export const EXECUTOR_V3_FIXTURE_PATH = "packages/policy/fixtures/executor-v3-parity.json";

const DAY = 86_400n;
const ONE_E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const E8 = 10n ** 8n;
const BPS = 10_000n;
/** ExecutorV3Base's per-account cap. */
const PERSONAL_CAP = 1_000_000n * E6;

/** The forge base's clock after its setUp: FundBase's T0, 18 days of adapter timelocks, 9 of the verifier's. */
export const EXECUTOR_V3_T0 = 1_790_876_425n + 27n * DAY;

type Tok = "USDC" | "WMON" | "A" | "B" | "C" | "D" | "E" | "F";
/** X is a token off the registry. */
type Side = Tok | "X";
const CLASS_A: readonly Tok[] = ["C", "D", "E", "F"];
const SCREENED: readonly Tok[] = ["D", "E", "F"];
const USDC = "USDC";
const WMON = "WMON";

type AttestKind = "NONE" | "VALID" | "INVALID";
type RouteKind = "natural" | "wrongEnd" | "tooLong" | "empty";
type AStatus = "BUYABLE" | "SELL_ONLY" | "FROZEN";
const ATTEST_CODES: Record<AttestKind, number> = { NONE: 0, VALID: 1, INVALID: 2 };
const ROUTE_CODES: Record<RouteKind, number> = { natural: 0, wrongEnd: 1, tooLong: 2, empty: 3 };
const STATUS_CODES: Record<AStatus, number> = { BUYABLE: 1, SELL_ONLY: 2, FROZEN: 3 };
const MODE_CODES: Record<custody.ModeV3, number> = { NORMAL: 0, REDUCE_ONLY: 1, PAUSED: 2 };

interface SetupBuy {
  readonly token: Tok;
  readonly usdcIn: bigint;
}

export interface CaseInputV3 {
  readonly name: string;
  /** Deposits at the peak price: USDC, WMON, A and B in base units. */
  readonly usdc: bigint;
  readonly wmon: bigint;
  readonly a: bigint;
  readonly b: bigint;
  /** Class A positions bought from USDC through the honest venue, in order. */
  readonly setupBuys: readonly SetupBuy[];
  /** MON/USD at the poke and now, as 8-decimal feed answers. */
  readonly peakMon: bigint;
  readonly mon: bigint;
  readonly monFeedAge: bigint;
  readonly aFeedAge: bigint;
  /** The USDC/WMON pool's spot relative to the oracle, in basis points. */
  readonly poolBps: bigint;
  readonly mode: custody.ModeV3;
  readonly paused: boolean;
  readonly adapterAllowed: boolean;
  /** The account's opt-in when the trade is checked (setup buys of screened tokens opt in first). */
  readonly optedIn: boolean;
  readonly attestorSet: boolean;
  readonly aStatus: AStatus;
  /** WMON's registry cap after a lowering, 4,500 for none. */
  readonly wmonCap: number;
  readonly tradeAges: readonly bigint[];
  readonly tradeValues: readonly bigint[];
  readonly tokenIn: Side;
  readonly tokenOut: Side;
  readonly amountIn: bigint;
  /** minAmountOut relative to the Executor's floor, in base units. */
  readonly minOutDelta: bigint;
  readonly deadlineOffset: bigint;
  readonly attestIn: AttestKind;
  readonly attestOut: AttestKind;
  /** The attested price relative to the reference, in basis points. */
  readonly attestInBps: bigint;
  readonly attestOutBps: bigint;
  readonly routeKind: RouteKind;
  /** The venue's fill relative to the implied output, in basis points, never under the minimum... */
  readonly fillBps: bigint;
  /** ...unless this is set: then it pays one unit under the minimum. */
  readonly fillUnderMin: boolean;
}

// ---------------------------------------------------------------------------
// The forge base, in the model's terms
// ---------------------------------------------------------------------------

const A_ANSWER = 6n * E8;

/**
 * Class F prices at a MON answer, as the oracle reads the base's feeds: WMON at
 * MON/USD, A at its feed, B through its rate leg, which the base re-sets so B
 * stays at 40 USDC (rounded as the oracle rounds). A stale leg leaves its token out.
 */
function feedsAt(
  mon: bigint,
  monStale: boolean,
  aStale: boolean,
): Partial<Record<CustodyToken, bigint>> {
  const out: Partial<Record<CustodyToken, bigint>> = { USDC: ONE_E18 };
  const px = mon * 10n ** 10n;
  if (!monStale) {
    out.WMON = px;
    const rate = (40n * ONE_E18 * ONE_E18) / px;
    out.B = (rate * px) / ONE_E18;
  }
  if (!aStale) out.A = A_ANSWER * 10n ** 10n;
  return out;
}

const DECIMALS: Record<Side, number> = {
  USDC: 6,
  WMON: 18,
  A: 18,
  B: 8,
  C: 18,
  D: 6,
  E: 18,
  F: 18,
  X: 18,
};

/** The registry as the base seeds it, with the case's A status and WMON cap. */
function tokenRules(c: CaseInputV3): Record<string, ex.TokenRuleV3> {
  const core = (
    priceClass: ex.PriceClassV3,
    decimals: number,
    status: ex.TokenStatusV3 = "BUYABLE",
    cap = 4_500,
  ) => ({ lane: "CORE", status, priceClass, decimals, maxPositionBps: cap }) as const;
  const screened = (decimals: number) =>
    ({
      lane: "SCREENED",
      status: "BUYABLE",
      priceClass: "A",
      decimals,
      maxPositionBps: 1_500,
    }) as const;
  return {
    USDC: core("F", 6),
    WMON: core("F", 18, "BUYABLE", c.wmonCap),
    A: core("F", 18, c.aStatus),
    B: core("F", 8),
    C: core("A", 18),
    D: screened(6),
    E: screened(18),
    F: screened(18),
  };
}

/** The hub a token's own pool connects it to (ExecutorV3Base.hub). */
const hub = (t: Side): Side => {
  if (t === USDC || t === WMON) return t;
  if (t === "A" || t === "C") return WMON;
  return USDC;
};

interface Pool {
  readonly a: Side;
  readonly b: Side;
  readonly fee: number;
  readonly screened: boolean;
}
const POOL_USDC_WMON: Pool = { a: USDC, b: WMON, fee: 3_000, screened: false };
/** The pool between a token and its hub (ExecutorV3Base.leg); an unknown token takes D's, as the base does. */
function leg(t: Side): Pool {
  switch (t) {
    case "A":
      return { a: "A", b: WMON, fee: 2_500, screened: false };
    case "C":
      return { a: WMON, b: "C", fee: 500, screened: false };
    case "B":
      return { a: "B", b: USDC, fee: 500, screened: false };
    case "E":
      return { a: USDC, b: "E", fee: 500, screened: true };
    case "F":
      return { a: USDC, b: "F", fee: 500, screened: true };
    default:
      return { a: USDC, b: "D", fee: 500, screened: true };
  }
}

/** The natural route between two tokens through the base's pools (ExecutorV3Base.routeFor). */
export function routeFor(tokenIn: Side, tokenOut: Side): Pool[] {
  const hops: Pool[] = [];
  let at = tokenIn;
  if (hub(tokenIn) !== tokenIn) {
    hops.push(leg(tokenIn));
    at = hub(tokenIn);
  }
  if (at !== hub(tokenOut)) hops.push(POOL_USDC_WMON);
  if (hub(tokenOut) !== tokenOut) hops.push(leg(tokenOut));
  return hops;
}

/** The token a wrong-ended route goes to instead: the first of WMON, A, B that is neither side. */
export function wrongEndOf(tokenIn: Side, tokenOut: Side): Side {
  return (["WMON", "A", "B"] as const).find((t) => t !== tokenIn && t !== tokenOut) as Side;
}

function routeOf(c: CaseInputV3): Pool[] {
  switch (c.routeKind) {
    case "natural":
      return routeFor(c.tokenIn, c.tokenOut);
    case "wrongEnd":
      return routeFor(c.tokenIn, wrongEndOf(c.tokenIn, c.tokenOut));
    case "tooLong":
      return [POOL_USDC_WMON, POOL_USDC_WMON, POOL_USDC_WMON, POOL_USDC_WMON];
    case "empty":
      return [];
  }
}

// ---------------------------------------------------------------------------
// One case: the account, the market, the verdict
// ---------------------------------------------------------------------------

const s = (v: bigint) => v.toString();

export interface CaseStateV3 {
  readonly intent: ex.ExecutorIntentV3;
  readonly market: ex.ExecutorMarketV3;
  readonly amountOut: bigint;
  readonly drawdownBps: bigint;
  readonly valuesUsable: boolean;
}

/** The custody model's state after the case's setup: deposits, class A buys and a poke, all at the peak. */
function setupState(c: CaseInputV3): custody.CustodyState {
  const peak = { now: EXECUTOR_V3_T0, feeds: feedsAt(c.peakMon, false, false), attested: {} };
  let state = custody.emptyCustody();
  const dep = (token: CustodyToken, amount: bigint) => {
    if (amount === 0n) return;
    const r = custody.deposit(state, token, amount, peak, PERSONAL_CAP);
    if (!r.outcome.ok) throw new Error(`${c.name}: setup deposit refused (${r.outcome.failure})`);
    state = r.state;
  };
  dep("USDC", c.usdc);
  dep("WMON", c.wmon);
  dep("A", c.a);
  dep("B", c.b);
  if (c.optedIn || c.setupBuys.some((b) => SCREENED.includes(b.token))) {
    state = custody.setOptIn(state, true);
  }
  for (const buy of c.setupBuys) {
    const r = custody.swap(
      state,
      {
        tokenIn: "USDC",
        tokenOut: buy.token,
        amountIn: buy.usdcIn,
        outputBps: BPS,
        reference: { ...CUSTODY_REFERENCE_PRICES, WMON: c.peakMon * 10n ** 10n },
      },
      { now: EXECUTOR_V3_T0, feeds: peak.feeds },
    );
    if (!r.outcome.ok) throw new Error(`${c.name}: setup buy refused (${r.outcome.failure})`);
    state = r.state;
  }
  return custody.poke(state, peak).state;
}

/** One case's intent and market, as the Executor's mirror takes them. */
export function caseState(c: CaseInputV3): CaseStateV3 {
  const now = EXECUTOR_V3_T0;
  const state = setupState(c);
  const monStale = c.monFeedAge >= 300n;
  const aStale = c.aFeedAge >= 3_900n;
  const feeds = feedsAt(c.mon, monStale, aStale);
  const tokens = tokenRules(c);

  // The account's views now: class A at the price its last priced action cached.
  let view: custody.ValuationV3 | null;
  try {
    view = custody.valuation(state, { now, feeds, attested: {} });
  } catch {
    view = null;
  }
  const holdings: ex.HoldingV3[] = state.held.map((t) => {
    const pos = state.positions[t];
    const spec = CUSTODY_TOKEN_SPECS[t];
    const classA = spec.priceClass === "A";
    const cached = pos.lastPricedAt + BigInt(custody.CUSTODY_V3.attestedPriceTtlSeconds) > now;
    const priceE18 =
      t === "USDC" ? ONE_E18 : classA ? (cached ? pos.lastPriceE18 : 0n) : (feeds[t] ?? 0n);
    return {
      token: t,
      free: pos.amount,
      costBasis: t === "USDC" ? pos.amount : pos.costBasis,
      priceE18,
      priceUsable: classA || t === "USDC" || feeds[t] !== undefined,
    };
  });
  let drawdownBps = 0n;
  if (view) {
    const perUnit = custody.perUnitE18(view.nav, state.units);
    let peak = peakOf(state.buckets, now);
    if (perUnit > peak) peak = perUnit;
    drawdownBps = peak === 0n ? 0n : ((peak - perUnit) * BPS) / peak;
  }

  // The sides.
  const side = (t: Side, kind: AttestKind, bps: bigint): ex.SidePriceV3 => {
    if (t === "X") return { priceE18: ONE_E18, feed: "OK" };
    if (t === USDC) return { priceE18: ONE_E18 };
    if (CLASS_A.includes(t as Tok)) {
      const ref = CUSTODY_REFERENCE_PRICES[t as CustodyToken];
      return { priceE18: (ref * bps) / BPS, attestation: kind };
    }
    const px = feeds[t as CustodyToken];
    return px === undefined ? { priceE18: 0n, feed: "UNUSABLE" } : { priceE18: px, feed: "OK" };
  };
  const sides = {
    [c.tokenIn]: side(c.tokenIn, c.attestIn, c.attestInBps),
    [c.tokenOut]: side(c.tokenOut, c.attestOut, c.attestOutBps),
  };
  const attestedOff = (t: Side) => {
    const bps = t === c.tokenIn ? c.attestInBps : c.attestOutBps;
    return bps > BPS + 200n || bps < BPS - 200n;
  };

  // The route, each hop's pool judged as the oracle would judge it now.
  const poolOff = c.poolBps > BPS + 200n || c.poolBps < BPS - 200n;
  const route: ex.RouteHopV3[] = routeOf(c).map((pool) => {
    let price: ex.HopPriceStateV3;
    const pair = `${pool.a}/${pool.b}`;
    if (pair === "USDC/WMON") price = monStale ? "FEED_OFF" : poolOff ? "POOL_OFF" : "OK";
    else if (pair === "A/WMON") price = monStale || aStale ? "FEED_OFF" : "OK";
    else if (pair === "B/USDC") price = monStale ? "FEED_OFF" : "OK";
    else if (pair === "WMON/C") price = monStale || attestedOff("C") ? "POOL_OFF" : "OK";
    else price = attestedOff(pool.b) ? "POOL_OFF" : "OK";
    return {
      tokenA: pool.a,
      tokenB: pool.b,
      fee: pool.fee,
      usable: !pool.screened || c.optedIn,
      price,
    };
  });

  // The intent and its fill.
  const pxIn = sides[c.tokenIn]?.priceE18 ?? 0n;
  const pxOut = sides[c.tokenOut]?.priceE18 ?? 0n;
  const decIn = DECIMALS[c.tokenIn];
  const decOut = DECIMALS[c.tokenOut];
  const classA = CLASS_A.includes(c.tokenIn as Tok) || CLASS_A.includes(c.tokenOut as Tok);
  const floor = ex.floor(c.amountIn, pxIn, decIn, pxOut, decOut, classA ? 100 : 50);
  const minAmountOut = floor + c.minOutDelta > 0n ? floor + c.minOutDelta : 1n;
  const fair = (ex.impliedOut(c.amountIn, pxIn, decIn, pxOut, decOut) * c.fillBps) / BPS;
  let amountOut = fair > minAmountOut ? fair : minAmountOut;
  if (c.fillUnderMin && minAmountOut > 1n) amountOut = minAmountOut - 1n;

  const intent: ex.ExecutorIntentV3 = {
    tokenIn: c.tokenIn,
    tokenOut: c.tokenOut,
    amountIn: c.amountIn,
    minAmountOut,
    deadline: now + c.deadlineOffset,
  };
  const market: ex.ExecutorMarketV3 = {
    now,
    paused: c.paused,
    mode: c.mode,
    adapterAllowed: c.adapterAllowed,
    usdc: USDC,
    wmon: WMON,
    tokens,
    holdings,
    optedIn: c.optedIn,
    attestorSet: c.attestorSet,
    sides,
    route,
    drawdownBps,
    trades: c.tradeAges.map((age, k) => ({ at: now - age, valueUsdcE6: c.tradeValues[k] ?? 0n })),
  };
  return { intent, market, amountOut, drawdownBps, valuesUsable: view !== null };
}

function caseRecord(c: CaseInputV3) {
  const st = caseState(c);
  const v = ex.verdict(st.intent, st.market, st.amountOut);
  return {
    name: c.name,
    usdc: s(c.usdc),
    wmon: s(c.wmon),
    a: s(c.a),
    b: s(c.b),
    setupTokens: c.setupBuys.map((x) => x.token),
    setupAmounts: c.setupBuys.map((x) => s(x.usdcIn)),
    peakMon: s(c.peakMon),
    mon: s(c.mon),
    monFeedAge: s(c.monFeedAge),
    aFeedAge: s(c.aFeedAge),
    poolBps: s(c.poolBps),
    mode: MODE_CODES[c.mode],
    paused: c.paused,
    adapterAllowed: c.adapterAllowed,
    optedIn: c.optedIn,
    attestorSet: c.attestorSet,
    aStatus: STATUS_CODES[c.aStatus],
    wmonCap: c.wmonCap,
    tradeAges: c.tradeAges.map(s),
    tradeValues: c.tradeValues.map(s),
    tokenIn: c.tokenIn,
    tokenOut: c.tokenOut,
    amountIn: s(c.amountIn),
    minAmountOut: s(st.intent.minAmountOut),
    deadline: s(st.intent.deadline),
    attestIn: ATTEST_CODES[c.attestIn],
    attestOut: ATTEST_CODES[c.attestOut],
    attestInBps: s(c.attestInBps),
    attestOutBps: s(c.attestOutBps),
    routeKind: ROUTE_CODES[c.routeKind],
    amountOut: s(st.amountOut),
    // REJECTION_CODES index of the expected refusal, or 255 when the trade goes through.
    reason: v.reason === null ? 255 : REJECTION_CODES.indexOf(v.reason),
    navAfter: s(v.navAfter),
    drawdownBps: s(st.drawdownBps),
    valuesUsable: st.valuesUsable,
  };
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

const TWO = 2n * E8;
/** WMON for a USDC value at a MON answer. */
const wmonAt = (valueE6: bigint, answer: bigint) => (valueE6 * 10n ** 30n) / (answer * 10n ** 10n);

/** A valid baseline: 700 USDC and 150 WMON at $2 (NAV 1,000), a 10 USDC buy of WMON at the floor. */
const base = (over: Partial<CaseInputV3> & { name: string }): CaseInputV3 => ({
  usdc: 700n * E6,
  wmon: 150n * ONE_E18,
  a: 0n,
  b: 0n,
  setupBuys: [],
  peakMon: TWO,
  mon: TWO,
  monFeedAge: 10n,
  aFeedAge: 10n,
  poolBps: BPS,
  mode: "NORMAL",
  paused: false,
  adapterAllowed: true,
  optedIn: false,
  attestorSet: true,
  aStatus: "BUYABLE",
  wmonCap: 4_500,
  tradeAges: [],
  tradeValues: [],
  tokenIn: USDC,
  tokenOut: WMON,
  amountIn: 10n * E6,
  minOutDelta: 0n,
  deadlineOffset: 120n,
  attestIn: "VALID",
  attestOut: "VALID",
  attestInBps: BPS,
  attestOutBps: BPS,
  routeKind: "natural",
  fillBps: BPS,
  fillUnderMin: false,
  ...over,
});

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

/** Class A positions in chunks under the 10% trade cap. */
function chunks(token: Tok, basis: bigint, nav: bigint): SetupBuy[] {
  const out: SetupBuy[] = [];
  const max = (nav * 9n) / 100n;
  let left = basis;
  while (left > 0n) {
    const usdcIn = left > max ? max : left;
    out.push({ token, usdcIn });
    left -= usdcIn;
  }
  return out;
}

export function caseInputs(): CaseInputV3[] {
  const twenty = (age: bigint, value: bigint) => ({
    tradeAges: Array.from({ length: 20 }, () => age),
    tradeValues: Array.from({ length: 20 }, () => value),
  });
  const cases: CaseInputV3[] = [
    base({ name: "a valid buy of WMON" }),
    base({ name: "a valid sale of WMON", tokenIn: WMON, tokenOut: USDC, amountIn: 5n * ONE_E18 }),
    base({ name: "one hop: USDC to B", tokenOut: "B", amountIn: 100n * E6 }),
    base({ name: "two hops: USDC to A", tokenOut: "A", amountIn: 60n * E6 }),
    base({
      name: "three hops: A to B",
      a: 10n * ONE_E18,
      tokenIn: "A",
      tokenOut: "B",
      amountIn: 10n * ONE_E18,
    }),
    base({ name: "a class A buy of C", tokenOut: "C", amountIn: 100n * E6 }),
    base({
      name: "a screened buy of D with the opt-in",
      tokenOut: "D",
      amountIn: 50n * E6,
      optedIn: true,
    }),
    base({ name: "a screened buy of D without it", tokenOut: "D", amountIn: 50n * E6 }),
    base({
      name: "a sale of D after opting out closes its pool",
      tokenIn: "D",
      tokenOut: USDC,
      amountIn: 5n * E6,
      setupBuys: [{ token: "D", usdcIn: 50n * E6 }],
    }),
    base({ name: "exactly 10% of value", amountIn: 100n * E6 }),
    base({ name: "one unit over 10%", amountIn: 100n * E6 + 1n }),
    base({
      name: "a buy to exactly 40%",
      usdc: 650n * E6,
      wmon: 175n * ONE_E18,
      amountIn: 50n * E6,
    }),
    base({
      name: "a buy one unit over 40%",
      usdc: 650n * E6,
      wmon: 175n * ONE_E18,
      amountIn: 50n * E6 + 1n,
    }),
    base({
      name: "the registry's lower cap binds: exactly 35%",
      wmonCap: 3_500,
      amountIn: 50n * E6,
    }),
    base({
      name: "the registry's lower cap binds: one unit over",
      wmonCap: 3_500,
      amountIn: 50n * E6 + 1n,
    }),
    base({
      name: "a buy landing past the core's 45%",
      usdc: 640n * E6,
      wmon: 180n * ONE_E18,
      amountIn: 100n * E6,
    }),
    base({
      name: "USDC to exactly the floor",
      usdc: 150n * E6,
      wmon: 175n * ONE_E18,
      b: (125n * E8) / 10n,
      tokenOut: "A",
      amountIn: 50n * E6,
    }),
    base({
      name: "USDC one unit under the floor",
      usdc: 150n * E6,
      wmon: 175n * ONE_E18,
      b: (125n * E8) / 10n,
      tokenOut: "A",
      amountIn: 50n * E6 + 1n,
    }),
    base({
      name: "a sale into USDC is exempt from the floor and the cap",
      usdc: 50n * E6,
      wmon: 475n * ONE_E18,
      tokenIn: WMON,
      tokenOut: USDC,
      amountIn: 25n * ONE_E18,
    }),
    base({ name: "minimum exactly at the floor", amountIn: 100n * E6 }),
    base({ name: "minimum one unit under the floor", amountIn: 100n * E6, minOutDelta: -1n }),
    base({ name: "class A slippage is 1%: at the floor", tokenOut: "C", amountIn: 100n * E6 }),
    base({
      name: "class A slippage is 1%: one unit under",
      tokenOut: "C",
      amountIn: 100n * E6,
      minOutDelta: -1n,
    }),
    base({ name: "a fill exactly at the minimum", fillBps: 9_950n }),
    base({ name: "a fill one unit under the minimum", fillUnderMin: true }),
    base({ name: "a fill better than fair", fillBps: 10_040n }),
    base({
      name: "19 trades in the window",
      tradeAges: Array.from({ length: 19 }, () => 3_600n),
      tradeValues: Array.from({ length: 19 }, () => E6),
    }),
    base({ name: "20 trades in the window", ...twenty(3_600n, E6) }),
    base({ name: "20 trades exactly 24 hours old", ...twenty(86_400n, E6) }),
    base({
      name: "turnover to exactly 100%",
      tradeAges: [100n],
      tradeValues: [900n * E6],
      amountIn: 100n * E6,
    }),
    base({
      name: "turnover one unit over 100%",
      tradeAges: [100n],
      tradeValues: [900n * E6 + 1n],
      amountIn: 100n * E6,
    }),
    base({ name: "deadline exactly two minutes ahead", deadlineOffset: 120n }),
    base({ name: "deadline one second too far", deadlineOffset: 121n }),
    base({ name: "deadline now", deadlineOffset: 0n }),
    base({ name: "deadline one second ago", deadlineOffset: -1n }),
    base({ name: "MON feed 299 s old", monFeedAge: 299n }),
    base({ name: "MON feed exactly 300 s old", monFeedAge: 300n }),
    base({ name: "another held token's feed 3,899 s old", a: 10n * ONE_E18, aFeedAge: 3_899n }),
    base({
      name: "another held token's feed exactly 3,900 s old",
      a: 10n * ONE_E18,
      aFeedAge: 3_900n,
    }),
    base({
      name: "A's own feed stale when selling A",
      a: 10n * ONE_E18,
      aFeedAge: 3_900n,
      tokenIn: "A",
      tokenOut: USDC,
      amountIn: ONE_E18,
    }),
    base({ name: "pool 1.5% over the oracle", poolBps: 10_150n }),
    base({ name: "pool 2.5% over the oracle", poolBps: 10_250n }),
    base({ name: "pool 2.5% under the oracle", poolBps: 9_750n }),
    base({
      name: "reduce-only allows a sale",
      mode: "REDUCE_ONLY",
      tokenIn: WMON,
      tokenOut: USDC,
      amountIn: 5n * ONE_E18,
    }),
    base({ name: "reduce-only refuses a buy", mode: "REDUCE_ONLY" }),
    base({
      name: "reduce-only refuses a swap between tokens",
      mode: "REDUCE_ONLY",
      a: 10n * ONE_E18,
      tokenIn: "A",
      tokenOut: "B",
      amountIn: ONE_E18,
    }),
    base({
      name: "paused refuses a sale",
      mode: "PAUSED",
      tokenIn: WMON,
      tokenOut: USDC,
      amountIn: 5n * ONE_E18,
    }),
    base({ name: "the Executor paused", paused: true }),
    base({ name: "a paused adapter", adapterAllowed: false }),
    base({
      name: "a sell-only token refuses a buy",
      aStatus: "SELL_ONLY",
      tokenOut: "A",
      amountIn: 10n * E6,
    }),
    base({
      name: "a sell-only token still sells",
      aStatus: "SELL_ONLY",
      a: 10n * ONE_E18,
      tokenIn: "A",
      tokenOut: USDC,
      amountIn: ONE_E18,
    }),
    base({
      name: "a frozen token refuses a buy",
      aStatus: "FROZEN",
      tokenOut: "A",
      amountIn: 10n * E6,
    }),
    base({
      name: "a frozen token refuses a sale",
      aStatus: "FROZEN",
      a: 10n * ONE_E18,
      tokenIn: "A",
      tokenOut: USDC,
      amountIn: ONE_E18,
    }),
    base({
      name: "class A with no attestor",
      attestorSet: false,
      tokenOut: "C",
      amountIn: 10n * E6,
    }),
    base({
      name: "class A with no attestation",
      tokenOut: "C",
      amountIn: 10n * E6,
      attestOut: "NONE",
    }),
    base({
      name: "class A with an expired attestation",
      tokenOut: "C",
      amountIn: 10n * E6,
      attestOut: "INVALID",
    }),
    base({
      name: "class A attested 3% off the pool",
      tokenOut: "C",
      amountIn: 10n * E6,
      attestOutBps: 10_300n,
    }),
    base({
      name: "class A attested 1.5% off the pool",
      tokenOut: "C",
      amountIn: 10n * E6,
      attestOutBps: 10_150n,
    }),
    base({
      name: "a sale of C needs its attestation too",
      setupBuys: chunks("C", 100n * E6, 1_000n * E6),
      tokenIn: "C",
      tokenOut: USDC,
      amountIn: 25n * ONE_E18,
      attestIn: "NONE",
    }),
    base({
      name: "a sale of C with it",
      setupBuys: chunks("C", 100n * E6, 1_000n * E6),
      tokenIn: "C",
      tokenOut: USDC,
      amountIn: 25n * ONE_E18,
    }),
    base({
      name: "class A position to exactly 15%",
      setupBuys: chunks("C", 140n * E6, 1_000n * E6),
      tokenOut: "C",
      amountIn: 10n * E6,
    }),
    base({
      name: "class A position one unit over 15%",
      setupBuys: chunks("C", 140n * E6, 1_000n * E6),
      tokenOut: "C",
      amountIn: 10n * E6 + 1n,
    }),
    base({
      name: "class A total to exactly 50%",
      optedIn: true,
      setupBuys: [
        ...chunks("C", 140n * E6, 1_000n * E6),
        ...chunks("D", 140n * E6, 1_000n * E6),
        ...chunks("E", 140n * E6, 1_000n * E6),
      ],
      tokenOut: "F",
      amountIn: 80n * E6,
    }),
    base({
      name: "class A total one unit over 50%",
      optedIn: true,
      setupBuys: [
        ...chunks("C", 140n * E6, 1_000n * E6),
        ...chunks("D", 140n * E6, 1_000n * E6),
        ...chunks("E", 140n * E6, 1_000n * E6),
      ],
      tokenOut: "F",
      amountIn: 80n * E6 + 1n,
    }),
    base({
      name: "a swap between two class A tokens moves basis",
      optedIn: true,
      setupBuys: [...chunks("C", 100n * E6, 1_000n * E6), ...chunks("D", 100n * E6, 1_000n * E6)],
      tokenIn: "D",
      tokenOut: "C",
      amountIn: 5n * E6,
    }),
    base({ name: "an unpoked 10.5% drawdown refuses a buy", mon: 130_000_000n }),
    base({
      name: "an unpoked 10.5% drawdown allows a sale",
      mon: 130_000_000n,
      tokenIn: WMON,
      tokenOut: USDC,
      amountIn: 5n * ONE_E18,
    }),
    base({
      name: "an unpoked 21% drawdown refuses a sale",
      mon: 60_000_000n,
      tokenIn: WMON,
      tokenOut: USDC,
      amountIn: 5n * ONE_E18,
    }),
    base({
      name: "more than the balance",
      tokenIn: WMON,
      tokenOut: USDC,
      amountIn: 150n * ONE_E18 + 1n,
    }),
    base({ name: "a zero amount", amountIn: 0n }),
    base({ name: "the same token on both sides", tokenOut: USDC }),
    base({
      name: "a route ending elsewhere",
      tokenOut: "A",
      amountIn: 10n * E6,
      routeKind: "wrongEnd",
    }),
    base({ name: "a route of four hops", routeKind: "tooLong" }),
    base({ name: "an empty route", routeKind: "empty" }),
    base({ name: "a token off the registry bought", tokenOut: "X" }),
    base({
      name: "a token off the registry sold",
      tokenIn: "X",
      tokenOut: USDC,
      amountIn: ONE_E18,
    }),
  ];

  const r = rng(11);
  for (let i = 0; i < 160; i++) {
    const peakMon = r.big(50_000_000n, 500_000_000n);
    const usdc = r.big(100n, 900n) * E6;
    const wmonValue = r.next() < 0.1 ? 0n : r.big(1n, 300n) * E6;
    const aValue = r.next() < 0.5 ? 0n : r.big(1n, 200n) * E6;
    const bValue = r.next() < 0.5 ? 0n : r.big(1n, 200n) * E6;
    const wmon = wmonAt(wmonValue, peakMon);
    const a = (aValue * 10n ** 30n) / (6n * ONE_E18);
    const b = (bValue * 10n ** 20n) / (40n * ONE_E18);
    const nav = usdc + wmonValue + aValue + bValue;
    // Class A positions: each under 14%, all under 45% and leaving USDC at 15% or more.
    const setupBuys: SetupBuy[] = [];
    let classATotal = 0n;
    let usdcLeft = usdc;
    const room = () => {
      const byTotal = (nav * 45n) / 100n - classATotal;
      const byUsdc = usdcLeft - (nav * 15n) / 100n;
      return byTotal < byUsdc ? byTotal : byUsdc;
    };
    for (const token of CLASS_A) {
      if (r.next() > 0.3) continue;
      const cap = (nav * 14n) / 100n;
      const most = room() < cap ? room() : cap;
      if (most <= 0n) continue;
      const basis = r.big(1n, most);
      setupBuys.push(...chunks(token, basis, nav));
      classATotal += basis;
      usdcLeft -= basis;
    }
    const mon = (peakMon * r.big(7_500n, 10_500n)) / 10_000n;
    const held: Side[] = [
      USDC,
      ...(wmon > 0n ? [WMON as Side] : []),
      ...(a > 0n ? ["A" as Side] : []),
      ...(b > 0n ? ["B" as Side] : []),
      ...setupBuys.map((x) => x.token as Side),
    ];
    const tokenIn: Side = r.next() < 0.03 ? "X" : r.pick([...new Set(held)]);
    let tokenOut: Side =
      r.next() < 0.03 ? "X" : r.pick(["USDC", "WMON", "A", "B", "C", "D", "E", "F"] as const);
    if (tokenOut === tokenIn) tokenOut = tokenIn === USDC ? WMON : USDC;
    const inPx =
      tokenIn === USDC || tokenIn === "X"
        ? ONE_E18
        : CLASS_A.includes(tokenIn as Tok)
          ? CUSTODY_REFERENCE_PRICES[tokenIn as CustodyToken]
          : tokenIn === WMON
            ? mon * 10n ** 10n
            : tokenIn === "A"
              ? 6n * ONE_E18
              : 40n * ONE_E18;
    const valueIn = (nav * r.big(10n, 1_400n)) / 10_000n + 1n;
    const amountIn = (valueIn * 10n ** BigInt(DECIMALS[tokenIn] + 12)) / inPx + 1n;
    const n = r.next() < 0.3 ? r.int(0, 20) : r.int(0, 4);
    const attestKind = (): AttestKind =>
      r.next() < 0.85 ? "VALID" : r.next() < 0.5 ? "NONE" : "INVALID";
    const attestBps = () => (r.next() < 0.9 ? r.big(9_900n, 10_100n) : r.pick([9_700n, 10_300n]));
    const roll = r.next();
    cases.push({
      name: `random trade ${i}`,
      usdc,
      wmon,
      a,
      b,
      setupBuys,
      peakMon,
      mon,
      monFeedAge: r.next() < 0.1 ? r.big(250n, 400n) : r.big(0n, 200n),
      aFeedAge: r.next() < 0.05 ? r.big(3_800n, 4_000n) : r.big(0n, 3_000n),
      poolBps:
        r.next() < 0.15 ? r.pick([9_700n, 9_850n, 10_150n, 10_300n]) : r.big(9_900n, 10_100n),
      mode: r.next() < 0.1 ? r.pick(["REDUCE_ONLY", "PAUSED"] as const) : "NORMAL",
      paused: r.next() < 0.03,
      adapterAllowed: r.next() > 0.05,
      optedIn: r.next() < 0.5,
      attestorSet: setupBuys.length > 0 || r.next() > 0.05,
      aStatus: r.next() < 0.85 ? "BUYABLE" : r.next() < 0.66 ? "SELL_ONLY" : "FROZEN",
      wmonCap: r.next() < 0.9 ? 4_500 : r.int(2_000, 4_400),
      tradeAges: Array.from({ length: n }, () => r.big(1n, 100_000n)),
      tradeValues: Array.from({ length: n }, () => (nav * r.big(0n, 3_000n)) / 10_000n),
      tokenIn,
      tokenOut,
      amountIn,
      minOutDelta: r.next() < 0.2 ? -r.big(1n, 3n) : r.big(0n, 2n),
      deadlineOffset: r.next() < 0.1 ? r.big(-3n, 125n) : r.big(1n, 120n),
      attestIn: attestKind(),
      attestOut: attestKind(),
      attestInBps: attestBps(),
      attestOutBps: attestBps(),
      routeKind:
        roll < 0.92 ? "natural" : roll < 0.96 ? "wrongEnd" : roll < 0.98 ? "tooLong" : "empty",
      fillBps: r.big(10_000n, 10_040n),
      fillUnderMin: r.next() < 0.05,
    });
  }
  return cases;
}

/** Every case's intent and market, for checks that use them directly (F-U5's blockers). */
export function fixtureStates() {
  return caseInputs().map((c) => ({ name: c.name, ...caseState(c) }));
}

export function buildFixture() {
  const cases = caseInputs().map(caseRecord);
  return {
    note: "Generated by pnpm policy:parity from packages/policy/src/executor-v3-parity.ts; checked by executor-v3.test.ts and chains/monad/test/fund/ExecutorV3Parity.t.sol. Do not edit by hand.",
    t0: s(EXECUTOR_V3_T0),
    policyHash: ex.LAUNCH_POLICY_HASH,
    caseCount: cases.length,
    cases,
  };
}

export const fixtureJson = () => `${JSON.stringify(buildFixture(), null, 2)}\n`;

/** The USDC value of a holding, for tests that read the fixture's states. */
export const holdingValue = (h: ex.HoldingV3, decimals: number) =>
  valueE6(h.free, h.priceE18, decimals);
