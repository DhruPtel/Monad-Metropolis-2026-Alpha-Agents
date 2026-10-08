import { REJECTION_CODES } from "@alpha-agents/domain";
import * as breaker from "./breaker.ts";
import * as executor from "./executor.ts";
import { LAUNCH_LIMITS } from "./limits.ts";
import {
  type FeedAnswer,
  ORACLE_REASONS,
  type OracleReason,
  poolDeviation,
  readFeed,
  readPool,
  usdcPegReason,
} from "./oracle.ts";

/**
 * The parity fixture (P2-U3): oracle and breaker cases with the answers this
 * package gives. `parity.test.ts` fails if the committed JSON differs from
 * what this file builds now, and the forge test `test/oracle/Parity.t.sol`
 * fails if the contracts answer any case differently. So a change to either
 * side that the other does not share fails a test. Regenerate the file with
 * `pnpm policy:parity` after an intended change to both.
 */

export const PARITY_FIXTURE_PATH = "packages/policy/fixtures/oracle-breaker-parity.json";

/** The time the cases start from: the pinned fork block's (2026-10-01). */
const T0 = 1_790_876_425n;
const reasonIndex = (r: OracleReason) => ORACLE_REASONS.indexOf(r);
const s = (v: bigint) => v.toString();

/** A small deterministic generator (mulberry32), so the fixture never changes by itself. */
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

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

interface FeedCaseInput {
  readonly name: string;
  readonly feed: "MON_USD" | "USDC_USD";
  readonly answer: FeedAnswer | null;
  readonly now: bigint;
}

function feedCase(c: FeedCaseInput) {
  const r = readFeed(c.answer, c.feed, c.now);
  const a = c.answer ?? {
    decimals: 8,
    roundId: 1n,
    answer: 0n,
    updatedAt: 0n,
    answeredInRound: 1n,
  };
  return {
    name: c.name,
    feed: c.feed,
    reverts: c.answer === null,
    decimals: a.decimals,
    roundId: s(a.roundId),
    answer: s(a.answer),
    updatedAt: s(a.updatedAt),
    answeredInRound: s(a.answeredInRound),
    time: s(c.now),
    reason: reasonIndex(r.reason),
    priceE18: s(r.priceE18),
    updatedAtOut: s(r.updatedAt),
  };
}

const round = (answer: bigint, updatedAt: bigint, roundId = 7n, answeredInRound = roundId) => ({
  decimals: 8,
  roundId,
  answer,
  updatedAt,
  answeredInRound,
});

function feedCases() {
  const MON = 3_436_820n;
  const maxOk = ((1n << 128n) - 1n) / 10n ** 10n;
  const cases: FeedCaseInput[] = [
    { name: "MON fresh", feed: "MON_USD", answer: round(MON, T0 - 4n), now: T0 },
    { name: "MON 299 s old", feed: "MON_USD", answer: round(MON, T0 - 299n), now: T0 },
    { name: "MON exactly 300 s old", feed: "MON_USD", answer: round(MON, T0 - 300n), now: T0 },
    { name: "MON 301 s old", feed: "MON_USD", answer: round(MON, T0 - 301n), now: T0 },
    { name: "MON updated this second", feed: "MON_USD", answer: round(MON, T0), now: T0 },
    { name: "MON from the future", feed: "MON_USD", answer: round(MON, T0 + 1n), now: T0 },
    { name: "MON zero", feed: "MON_USD", answer: round(0n, T0), now: T0 },
    { name: "MON negative", feed: "MON_USD", answer: round(-1n, T0), now: T0 },
    { name: "MON smallest", feed: "MON_USD", answer: round(1n, T0), now: T0 },
    { name: "MON largest that fits", feed: "MON_USD", answer: round(maxOk, T0), now: T0 },
    { name: "MON one above", feed: "MON_USD", answer: round(maxOk + 1n, T0), now: T0 },
    { name: "MON updatedAt zero", feed: "MON_USD", answer: round(MON, 0n), now: T0 },
    {
      name: "MON answer from an earlier round",
      feed: "MON_USD",
      answer: round(MON, T0, 9n, 8n),
      now: T0,
    },
    {
      name: "MON answered in a later round",
      feed: "MON_USD",
      answer: round(MON, T0, 9n, 10n),
      now: T0,
    },
    {
      name: "MON decimals changed",
      feed: "MON_USD",
      answer: { ...round(MON, T0), decimals: 18 },
      now: T0,
    },
    { name: "MON reverts", feed: "MON_USD", answer: null, now: T0 },
    {
      name: "MON zero and stale: the sign is checked first",
      feed: "MON_USD",
      answer: round(0n, T0 - 999n),
      now: T0,
    },
    {
      name: "MON incomplete and from the future: completeness first",
      feed: "MON_USD",
      answer: round(MON, T0 + 50n, 9n, 8n),
      now: T0,
    },
    { name: "USDC fresh", feed: "USDC_USD", answer: round(99_999_000n, T0 - 1_948n), now: T0 },
    {
      name: "USDC 7,199 s old",
      feed: "USDC_USD",
      answer: round(100_000_000n, T0 - 7_199n),
      now: T0,
    },
    {
      name: "USDC exactly 7,200 s old",
      feed: "USDC_USD",
      answer: round(100_000_000n, T0 - 7_200n),
      now: T0,
    },
    { name: "USDC reverts", feed: "USDC_USD", answer: null, now: T0 },
  ];
  const r = rng(1);
  for (let i = 0; i < 40; i++) {
    const feed = r.pick(["MON_USD", "USDC_USD"] as const);
    const roundId = r.big(1n, (1n << 80n) - 1n);
    const answer =
      r.next() < 0.1 ? -r.big(0n, 10n ** 10n) : r.big(0n, r.next() < 0.1 ? 1n << 120n : 10n ** 10n);
    const updatedAt = r.next() < 0.05 ? 0n : T0 - r.big(0n, 8_000n) + (r.next() < 0.1 ? 100n : 0n);
    const later = roundId + r.big(0n, 3n);
    const answeredInRound = r.next() < 0.1 ? roundId - 1n : later < 1n << 80n ? later : roundId;
    const decimals = r.next() < 0.1 ? r.int(0, 18) : 8;
    cases.push({
      name: `random feed ${i}`,
      feed,
      answer: r.next() < 0.05 ? null : { decimals, roundId, answer, updatedAt, answeredInRound },
      now: T0,
    });
  }
  return cases.map(feedCase);
}

// ---------------------------------------------------------------------------
// The pool and the 2% rule
// ---------------------------------------------------------------------------

function sqrtFor(priceE18: bigint): bigint {
  // floor(sqrt(price × 2^192 / 1e30)), as the forge tests compute it.
  const x = (priceE18 << 192n) / 10n ** 30n;
  if (x < 2n) return x;
  let y = x;
  let z = (x + 1n) / 2n;
  while (z < y) {
    y = z;
    z = (x / z + z) / 2n;
  }
  return y;
}

function poolCase(name: string, oracleAnswer: bigint, sqrtPriceX96: bigint | null) {
  const oracle = readFeed(round(oracleAnswer, T0), "MON_USD", T0);
  const pool = readPool(sqrtPriceX96);
  const d = poolDeviation(oracle, pool);
  return {
    name,
    oracleAnswer: s(oracleAnswer),
    poolReverts: sqrtPriceX96 === null,
    sqrtPriceX96: s(sqrtPriceX96 ?? 0n),
    poolReason: reasonIndex(pool.reason),
    poolPriceE18: s(pool.priceE18),
    deviationReason: reasonIndex(d.reason),
    deviationBps: s(d.bps),
  };
}

function poolCases() {
  const MON = 3_436_820n;
  const o = MON * 10n ** 10n;
  const cases = [
    poolCase("the pinned block's pool", MON, 14_689_533_063_741_189_719_999n),
    poolCase("pool equal to the oracle", MON, sqrtFor(o)),
    poolCase("pool 1.99% over", MON, sqrtFor((o * 10_199n) / 10_000n)),
    poolCase("pool 2.01% over", MON, sqrtFor((o * 10_201n) / 10_000n)),
    poolCase("pool 1.99% under", MON, sqrtFor((o * 9_801n) / 10_000n)),
    poolCase("pool 2.01% under", MON, sqrtFor((o * 9_799n) / 10_000n)),
    poolCase("pool 3% over", MON, sqrtFor((o * 103n) / 100n)),
    poolCase("pool zero", MON, 0n),
    poolCase("pool reverts", MON, null),
    poolCase("pool at the largest sqrt price", MON, (1n << 160n) - 1n),
    poolCase("pool rounds to zero", MON, 1n),
    poolCase("oracle unusable: reported before the pool", 0n, null),
  ];
  const r = rng(2);
  for (let i = 0; i < 40; i++) {
    const answer = r.big(1n, 10n ** 12n);
    const oPrice = answer * 10n ** 10n;
    const sqrt =
      r.next() < 0.5
        ? sqrtFor((oPrice * r.big(9_500n, 10_500n)) / 10_000n)
        : r.big(1n, (1n << 160n) - 1n);
    cases.push(poolCase(`random pool ${i}`, answer, sqrt));
  }
  return cases;
}

// ---------------------------------------------------------------------------
// The depeg guard
// ---------------------------------------------------------------------------

function pegCase(name: string, answer: bigint, age: bigint) {
  const reading = readFeed(round(answer, T0 - age), "USDC_USD", T0);
  return {
    name,
    answer: s(answer),
    updatedAt: s(T0 - age),
    time: s(T0),
    reason: reasonIndex(usdcPegReason(reading)),
  };
}

function pegCases() {
  const cases = [
    pegCase("at the peg", 100_000_000n, 60n),
    pegCase("exactly 1% under", 99_000_000n, 60n),
    pegCase("just over 1% under", 98_999_999n, 60n),
    pegCase("exactly 1% over", 101_000_000n, 60n),
    pegCase("just over 1% over", 101_000_001n, 60n),
    pegCase("at the peg but stale", 100_000_000n, 7_200n),
    pegCase("depegged and stale: stale first", 90_000_000n, 7_200n),
    pegCase("zero", 0n, 60n),
  ];
  const r = rng(3);
  for (let i = 0; i < 20; i++) {
    cases.push(pegCase(`random peg ${i}`, r.big(97_000_000n, 103_000_000n), r.big(0n, 7_500n)));
  }
  return cases;
}

// ---------------------------------------------------------------------------
// The breaker, replayed step by step
// ---------------------------------------------------------------------------

type Op =
  | { op: "price"; answer: bigint; warp: bigint }
  | { op: "deposit"; token: "USDC" | "WMON"; amount: bigint }
  | { op: "withdraw"; token: "USDC" | "WMON"; amount: bigint }
  | { op: "withdrawAll" }
  | { op: "poke" }
  | { op: "unpause" }
  | { op: "monDown" }
  | { op: "monUp" };

const MODE_INDEX = { NORMAL: 0, REDUCE_ONLY: 1, PAUSED: 2 } as const;
const CAP = 100_000_000n;

/** Replays steps through the model, recording what the contract must show after each. */
function replay(name: string, ops: readonly Op[]) {
  let st = breaker.emptyAccount();
  let now = T0;
  let answer = 100_000_000n;
  let principal = 0n;
  const steps = ops.map((o) => {
    let nav = 0n;
    let perUnit = 0n;
    let pokePeak = 0n;
    const px = answer * 10n ** 10n;
    switch (o.op) {
      case "price":
        now += o.warp;
        answer = o.answer;
        break;
      case "deposit": {
        const value = o.token === "USDC" ? o.amount : breaker.wmonValueE6(o.amount, px);
        st = breaker.deposit(st, o.token, o.amount, px);
        principal += value;
        break;
      }
      case "withdraw":
        st = breaker.withdraw(st, o.token, o.amount);
        if (o.token === "USDC") principal -= o.amount < principal ? o.amount : principal;
        if (st.usdc === 0n && st.wmon === 0n) principal = 0n;
        break;
      case "withdrawAll":
        st = breaker.withdraw(breaker.withdraw(st, "USDC", st.usdc), "WMON", st.wmon);
        principal = 0n;
        break;
      case "poke": {
        const r = breaker.poke(st, px, now);
        st = r.state;
        nav = r.nav;
        perUnit = r.perUnit;
        pokePeak = r.peak;
        break;
      }
      case "unpause":
        st = breaker.unpause(st);
        break;
      case "monDown":
      case "monUp":
        break;
    }
    if (principal > CAP) throw new Error(`${name}: a step breaks the cap`);
    return {
      op: o.op,
      token: "token" in o ? o.token : "",
      amount: "amount" in o ? s(o.amount) : "0",
      answer: s(answer),
      warp: o.op === "price" ? s(o.warp) : "0",
      units: s(st.units),
      usdc: s(st.usdc),
      wmon: s(st.wmon),
      mode: MODE_INDEX[st.mode],
      peak: s(breaker.peakOf(st.buckets, now)),
      lastWmonPriceE18: s(st.lastWmonPriceE18),
      nav: s(nav),
      perUnit: s(perUnit),
      pokePeak: s(pokePeak),
    };
  });
  return { name, stepCount: steps.length, steps };
}

const price = (answer: bigint, warp = 0n): Op => ({ op: "price", answer, warp });
const dep = (token: "USDC" | "WMON", amount: bigint): Op => ({ op: "deposit", token, amount });
const wd = (token: "USDC" | "WMON", amount: bigint): Op => ({ op: "withdraw", token, amount });
const POKE: Op = { op: "poke" };
const DAY = 86_400n;

/** Random but valid sequences: within the cap, no deposit while PAUSED, prices fresh. */
function randomSequence(seed: number, length: number): Op[] {
  const r = rng(seed);
  const ops: Op[] = [];
  let st = breaker.emptyAccount();
  let now = T0;
  let answer = 100_000_000n;
  let principal = 0n;
  let monDown = false;
  for (let i = 0; i < length; i++) {
    const px = answer * 10n ** 10n;
    const roll = r.next();
    let o: Op;
    if (roll < 0.22) {
      answer = (answer * r.big(7_500n, 12_500n)) / 10_000n;
      if (answer === 0n) answer = 1n;
      o = price(answer, r.pick([0n, 3_600n, 12n * 3_600n, DAY, 2n * DAY]));
      now += o.op === "price" ? o.warp : 0n;
      monDown = false;
    } else if (roll < 0.47) {
      const token = r.pick(["USDC", "WMON"] as const);
      const room = CAP - principal;
      const needsMon = token === "WMON" || st.wmon > 0n;
      // A deposit into units with no value behind them reverts (AccountValueZero).
      const worthless = st.units > 0n && breaker.navAt(st, px) === 0n;
      if (room === 0n || st.mode === "PAUSED" || (needsMon && monDown) || worthless) {
        o = POKE;
      } else {
        const value = r.big(1n, room);
        const amount = token === "USDC" ? value : (value * 10n ** 30n) / px;
        if (amount === 0n) o = POKE;
        else {
          o = dep(token, amount);
          principal += token === "USDC" ? amount : breaker.wmonValueE6(amount, px);
        }
      }
    } else if (roll < 0.67) {
      const token = r.pick(["USDC", "WMON"] as const);
      const held = token === "USDC" ? st.usdc : st.wmon;
      if (held === 0n) o = POKE;
      else {
        const amount = r.big(1n, held);
        o = wd(token, amount);
        if (token === "USDC") principal -= amount < principal ? amount : principal;
      }
    } else if (roll < 0.72) {
      o = { op: "withdrawAll" };
    } else if (roll < 0.77 && st.mode !== "NORMAL") {
      o = { op: "unpause" };
    } else if (roll < 0.8) {
      o = { op: monDown ? "monUp" : "monDown" };
      monDown = !monDown;
    } else {
      o = POKE;
    }
    // A poke while MON/USD is down reverts when WMON is held; take MON/USD back up first.
    if (o.op === "poke" && monDown && st.wmon > 0n) {
      o = { op: "monUp" };
      monDown = false;
    }
    // Advance the local model so the next choice sees the right balances and mode.
    const step = replayOne(st, o, answer, now);
    st = step;
    if (o.op === "withdrawAll" || (st.usdc === 0n && st.wmon === 0n)) principal = 0n;
    ops.push(o);
  }
  if (monDown) ops.push({ op: "monUp" });
  ops.push(POKE);
  return ops;
}

function replayOne(st: breaker.AccountBreakerState, o: Op, answer: bigint, now: bigint) {
  const px = answer * 10n ** 10n;
  switch (o.op) {
    case "deposit":
      return breaker.deposit(st, o.token, o.amount, px);
    case "withdraw":
      return breaker.withdraw(st, o.token, o.amount);
    case "withdrawAll":
      return breaker.withdraw(breaker.withdraw(st, "USDC", st.usdc), "WMON", st.wmon);
    case "poke":
      return breaker.poke(st, px, now).state;
    case "unpause":
      return breaker.unpause(st);
    default:
      return st;
  }
}

function breakerCases() {
  const cases = [
    replay("exactly 10% trips reduce-only", [
      dep("WMON", 50n * 10n ** 18n),
      POKE,
      price(90_000_002n),
      POKE,
      price(90_000_000n),
      POKE,
    ]),
    replay("exactly 20% pauses", [
      dep("WMON", 50n * 10n ** 18n),
      POKE,
      price(80_000_002n),
      POKE,
      price(80_000_000n),
      POKE,
    ]),
    replay("a deposit after a drop does not hide it", [
      dep("WMON", 50n * 10n ** 18n),
      POKE,
      price(85_000_000n),
      dep("USDC", 40_000_000n),
      POKE,
    ]),
    replay("flows never move the value per unit", [
      dep("USDC", 30_000_000n),
      dep("WMON", 20n * 10n ** 18n),
      POKE,
      wd("USDC", 25_000_000n),
      dep("USDC", 40_000_000n),
      wd("WMON", 19n * 10n ** 18n),
      dep("WMON", 3n * 10n ** 18n),
      wd("WMON", 1n),
      POKE,
    ]),
    replay("a withdrawal with MON/USD down uses the last price", [
      dep("USDC", 50_000_000n),
      dep("WMON", 50n * 10n ** 18n),
      POKE,
      { op: "monDown" },
      wd("USDC", 20_000_000n),
      wd("WMON", 7n * 10n ** 18n),
      { op: "monUp" },
      price(95_000_000n),
      POKE,
    ]),
    replay("a peak lasts 7 days and no more", [
      dep("WMON", 50n * 10n ** 18n),
      POKE,
      price(95_000_000n, 7n * DAY),
      POKE,
      price(89_000_000n, DAY),
      POKE,
    ]),
    replay("unpausing starts the peak afresh", [
      dep("WMON", 50n * 10n ** 18n),
      POKE,
      price(70_000_000n),
      POKE,
      { op: "unpause" },
      POKE,
      price(63_000_000n),
      POKE,
    ]),
    replay("emptying the account starts afresh", [
      dep("WMON", 50n * 10n ** 18n),
      POKE,
      price(70_000_000n),
      POKE,
      { op: "withdrawAll" },
      { op: "unpause" },
      dep("USDC", 10_000_000n),
      POKE,
    ]),
  ];
  for (let i = 0; i < 24; i++) {
    cases.push(replay(`random sequence ${i}`, randomSequence(100 + i, 30)));
  }
  return cases;
}

export function buildParityFixture() {
  const feeds = feedCases();
  const pools = poolCases();
  const pegs = pegCases();
  const breakers = breakerCases();
  return {
    note: "Generated by pnpm policy:parity from packages/policy/src/parity.ts; checked by parity.test.ts and chains/monad/test/oracle/Parity.t.sol. Do not edit by hand.",
    limits: {
      monUsdMaxAge: LAUNCH_LIMITS.oracleMaxAgeSeconds.MON_USD,
      usdcUsdMaxAge: LAUNCH_LIMITS.oracleMaxAgeSeconds.USDC_USD,
      maxDeviationBps: LAUNCH_LIMITS.oracleMaxDeviationBps,
      maxDepegBps: LAUNCH_LIMITS.usdcMaxDepegBps,
      breakerReduceOnlyBps: LAUNCH_LIMITS.breakerReduceOnlyBps,
      breakerPauseBps: LAUNCH_LIMITS.breakerPauseBps,
      peakDays: breaker.PEAK_DAYS,
      t0: s(T0),
    },
    feedCaseCount: feeds.length,
    feedCases: feeds,
    poolCaseCount: pools.length,
    poolCases: pools,
    pegCaseCount: pegs.length,
    pegCases: pegs,
    breakerCaseCount: breakers.length,
    breakerCases: breakers,
  };
}

export const parityJson = () => `${JSON.stringify(buildParityFixture(), null, 2)}\n`;

// ---------------------------------------------------------------------------
// The Executor (P2-U2): executor-parity.json
// ---------------------------------------------------------------------------

export const EXECUTOR_FIXTURE_PATH = "packages/policy/fixtures/executor-parity.json";

/** The venue fee the forge replay gives its mock venue, as the v4 pool's 0.05%. */
const VENUE_FEE_BPS = 5;
const MODE_CODES = { NORMAL: 0, REDUCE_ONLY: 1, PAUSED: 2 } as const;

interface ExecutorCaseInput {
  readonly name: string;
  readonly usdc: bigint;
  /** WMON deposited, at the peak price. */
  readonly wmon: bigint;
  readonly peakAnswer: bigint;
  readonly answer: bigint;
  readonly feedAge: bigint;
  /** Pool price relative to the oracle, in basis points (10,000 = equal). */
  readonly poolBps: bigint;
  readonly mode: "NORMAL" | "REDUCE_ONLY" | "PAUSED";
  readonly paused: boolean;
  readonly buyable: boolean;
  readonly venueAllowed: boolean;
  readonly tradeAges: readonly bigint[];
  readonly tradeValues: readonly bigint[];
  readonly tokenIn: "USDC" | "WMON";
  readonly amountIn: bigint;
  /** minAmountOut relative to the oracle floor, in base units. */
  readonly minOutDelta: bigint;
  readonly deadlineOffset: bigint;
  /** The venue's fill relative to the oracle-fair output, in basis points; never under minAmountOut. */
  readonly fillBps: bigint;
}

/** One case's trade and market, as the offchain checks take them. */
function executorCaseState(c: ExecutorCaseInput) {
  const pxPeak = c.peakAnswer * 10n ** 10n;
  const px = c.answer * 10n ** 10n;
  let acct = breaker.deposit(breaker.emptyAccount(), "USDC", c.usdc, pxPeak);
  if (c.wmon > 0n) acct = breaker.deposit(acct, "WMON", c.wmon, pxPeak);
  acct = breaker.poke(acct, pxPeak, T0).state;
  const nav = breaker.navAt(acct, px);
  const perUnit = breaker.perUnitE18(nav, acct.units);
  const recorded = breaker.peakOf(acct.buckets, T0);
  const peak = perUnit > recorded ? perUnit : recorded;
  const drawdownBps = peak === 0n ? 0n : ((peak - perUnit) * 10_000n) / peak;

  const reading = readFeed(round(c.answer, T0 - c.feedAge), "MON_USD", T0);
  const sqrt = sqrtFor((px * c.poolBps) / 10_000n);
  const oracleReason = poolDeviation(reading, readPool(sqrt)).reason;

  const floor = px === 0n ? 0n : executor.oracleFloor(c.tokenIn, c.amountIn, px, 50);
  const minAmountOut = floor + c.minOutDelta > 0n ? floor + c.minOutDelta : 1n;
  const fair =
    c.tokenIn === "USDC" ? (c.amountIn * 10n ** 30n) / px : (c.amountIn * px) / 10n ** 30n;
  const filled = (fair * c.fillBps) / 10_000n;
  const amountOut = filled > minAmountOut ? filled : minAmountOut;
  const trade = {
    tokenIn: c.tokenIn,
    amountIn: c.amountIn,
    minAmountOut,
    deadline: T0 + c.deadlineOffset,
  } as const;
  const market: executor.ExecutorMarket = {
    usdc: c.usdc,
    wmon: c.wmon,
    priceE18: px,
    oracleReason,
    mode: c.mode,
    drawdownBps,
    trades: c.tradeAges.map((age, k) => ({ at: T0 - age, valueUsdcE6: c.tradeValues[k] ?? 0n })),
    now: T0,
    paused: c.paused,
    buyable: c.buyable,
    venueAllowed: c.venueAllowed,
  };
  return { trade, market, amountOut, minAmountOut, sqrt, drawdownBps };
}

function executorCase(c: ExecutorCaseInput) {
  const { trade, market, amountOut, minAmountOut, sqrt, drawdownBps } = executorCaseState(c);
  const v = executor.executorVerdict(trade, market, amountOut, VENUE_FEE_BPS);
  return {
    name: c.name,
    usdc: s(c.usdc),
    wmon: s(c.wmon),
    peakAnswer: s(c.peakAnswer),
    answer: s(c.answer),
    feedAge: s(c.feedAge),
    sqrtPriceX96: s(sqrt),
    mode: MODE_CODES[c.mode],
    paused: c.paused,
    buyable: c.buyable,
    venueAllowed: c.venueAllowed,
    tradeAges: c.tradeAges.map(s),
    tradeValues: c.tradeValues.map(s),
    tokenIn: c.tokenIn,
    amountIn: s(c.amountIn),
    minAmountOut: s(minAmountOut),
    deadline: s(trade.deadline),
    amountOut: s(amountOut),
    // REJECTION_CODES index of the expected refusal, or 255 when the trade goes through.
    reason: v.reason === null ? 255 : REJECTION_CODES.indexOf(v.reason),
    navAfter: s(v.navAfter),
    drawdownBps: s(drawdownBps),
  };
}

const usdcE6 = (whole: bigint) => whole * 1_000_000n;
const ONE = 100_000_000n; // $1.00 with 8 decimals
const wmonAt = (valueE6: bigint, answer: bigint) => (valueE6 * 10n ** 30n) / (answer * 10n ** 10n);

/** A valid baseline: $70 USDC and $30 WMON at $1, fresh feed, pool at the oracle. */
const base = (over: Partial<ExecutorCaseInput> & { name: string }): ExecutorCaseInput => ({
  usdc: usdcE6(70n),
  wmon: wmonAt(usdcE6(30n), ONE),
  peakAnswer: ONE,
  answer: ONE,
  feedAge: 10n,
  poolBps: 10_000n,
  mode: "NORMAL",
  paused: false,
  buyable: true,
  venueAllowed: true,
  tradeAges: [],
  tradeValues: [],
  tokenIn: "WMON",
  amountIn: 10n ** 18n,
  minOutDelta: 0n,
  deadlineOffset: 120n,
  fillBps: 10_000n,
  ...over,
});

function executorCaseInputs(): ExecutorCaseInput[] {
  const twenty = (age: bigint, value: bigint) => ({
    tradeAges: Array.from({ length: 20 }, () => age),
    tradeValues: Array.from({ length: 20 }, () => value),
  });
  const cases: ExecutorCaseInput[] = [
    base({ name: "a valid sale" }),
    base({ name: "a valid buy", tokenIn: "USDC", amountIn: usdcE6(5n) }),
    base({ name: "exactly 10% of value", amountIn: 10n * 10n ** 18n }),
    base({ name: "one unit over 10%", amountIn: 10n * 10n ** 18n + 10n ** 12n }),
    base({ name: "a buy to exactly 40%", tokenIn: "USDC", amountIn: usdcE6(10n) }),
    base({
      name: "a buy one unit over 40%",
      tokenIn: "USDC",
      amountIn: usdcE6(5n) + 1n,
      usdc: usdcE6(65n),
      wmon: wmonAt(usdcE6(35n), ONE),
    }),
    base({
      name: "a buy landing past the core's 45%",
      tokenIn: "USDC",
      amountIn: usdcE6(10n),
      usdc: usdcE6(64n),
      wmon: wmonAt(usdcE6(36n), ONE),
    }),
    base({
      name: "a buy at exactly 40% filled better than fair",
      tokenIn: "USDC",
      amountIn: usdcE6(10n),
      fillBps: 10_010n,
    }),
    base({ name: "minimum exactly at the oracle floor", minOutDelta: 0n }),
    base({ name: "minimum one unit under the floor", minOutDelta: -1n }),
    base({ name: "deadline exactly two minutes ahead", deadlineOffset: 120n }),
    base({ name: "deadline one second too far", deadlineOffset: 121n }),
    base({ name: "deadline now", deadlineOffset: 0n }),
    base({ name: "deadline one second ago", deadlineOffset: -1n }),
    base({ name: "feed 299 s old", feedAge: 299n }),
    base({ name: "feed exactly 300 s old", feedAge: 300n }),
    base({ name: "pool 1.99% over", poolBps: 10_199n }),
    base({ name: "pool 2.01% over", poolBps: 10_201n }),
    base({ name: "pool 2.01% under", poolBps: 9_799n }),
    base({ name: "reduce-only allows a sale", mode: "REDUCE_ONLY" }),
    base({
      name: "reduce-only refuses a buy",
      mode: "REDUCE_ONLY",
      tokenIn: "USDC",
      amountIn: usdcE6(1n),
    }),
    base({ name: "paused refuses a sale", mode: "PAUSED" }),
    base({ name: "the Executor paused", paused: true }),
    base({
      name: "WMON off the buy list refuses a buy",
      buyable: false,
      tokenIn: "USDC",
      amountIn: usdcE6(1n),
    }),
    base({ name: "WMON off the buy list still sells", buyable: false }),
    base({ name: "a paused venue", venueAllowed: false }),
    base({ name: "more than the balance", amountIn: wmonAt(usdcE6(30n), ONE) + 1n }),
    base({
      name: "19 trades in the window",
      ...{
        tradeAges: Array.from({ length: 19 }, () => 3_600n),
        tradeValues: Array.from({ length: 19 }, () => 1n),
      },
    }),
    base({ name: "20 trades in the window", ...twenty(3_600n, 1n) }),
    base({ name: "20 trades exactly 24 hours old", ...twenty(86_400n, 1n) }),
    base({ name: "turnover to exactly 100%", tradeAges: [100n], tradeValues: [usdcE6(99n)] }),
    base({
      name: "turnover one unit over 100%",
      tradeAges: [100n],
      tradeValues: [usdcE6(99n) + 1n],
    }),
    base({
      name: "an unpoked 10% drawdown refuses a buy",
      usdc: usdcE6(1n),
      wmon: wmonAt(usdcE6(99n), ONE),
      answer: 89_898_990n,
      tokenIn: "USDC",
      amountIn: 1n * 10n ** 5n,
    }),
    base({
      name: "an unpoked 10% drawdown allows a sale",
      usdc: usdcE6(1n),
      wmon: wmonAt(usdcE6(99n), ONE),
      answer: 89_898_990n,
      amountIn: 10n ** 18n,
    }),
    base({
      name: "an unpoked 20% drawdown refuses a sale",
      usdc: usdcE6(1n),
      wmon: wmonAt(usdcE6(99n), ONE),
      answer: 79_000_000n,
      amountIn: 10n ** 18n,
    }),
  ];
  const r = rng(7);
  for (let i = 0; i < 160; i++) {
    const peakAnswer = r.big(2_000_000n, 300_000_000n);
    const answer = (peakAnswer * r.big(7_500n, 10_500n)) / 10_000n;
    const usdc = usdcE6(r.big(1n, 90n));
    const wmonValue = r.next() < 0.1 ? 0n : usdcE6(r.big(1n, 60n));
    const wmon = wmonAt(wmonValue, peakAnswer);
    const nav = usdc + (wmon * answer * 10n ** 10n) / 10n ** 30n;
    const tokenIn = r.next() < 0.5 ? ("USDC" as const) : ("WMON" as const);
    const valueIn = (nav * r.big(1n, 1_400n)) / 10_000n + 1n;
    const amountIn = tokenIn === "USDC" ? valueIn : wmonAt(valueIn, answer) + 1n;
    const n = r.next() < 0.3 ? r.int(0, 20) : r.int(0, 4);
    const tradeAges = Array.from({ length: n }, () => r.big(1n, 100_000n));
    const tradeValues = Array.from({ length: n }, () => (nav * r.big(0n, 3_000n)) / 10_000n);
    cases.push({
      name: `random trade ${i}`,
      usdc,
      wmon,
      peakAnswer,
      answer,
      feedAge: r.next() < 0.1 ? r.big(250n, 400n) : r.big(0n, 200n),
      poolBps: r.next() < 0.15 ? r.big(9_700n, 10_300n) : r.big(9_900n, 10_100n),
      mode: r.next() < 0.1 ? r.pick(["REDUCE_ONLY", "PAUSED"] as const) : "NORMAL",
      paused: r.next() < 0.03,
      buyable: r.next() > 0.05,
      venueAllowed: r.next() > 0.05,
      tradeAges,
      tradeValues,
      tokenIn,
      amountIn: amountIn > 0n ? amountIn : 1n,
      minOutDelta: r.next() < 0.2 ? -r.big(1n, 3n) : r.big(0n, 2n),
      deadlineOffset: r.next() < 0.1 ? r.big(-3n, 125n) : r.big(1n, 120n),
      fillBps: r.big(10_000n, 10_040n),
    });
  }
  return cases;
}

const executorCases = () => executorCaseInputs().map(executorCase);

/** Every fixture case's trade and market, for checks that use them directly (P2-U5's blockers). */
export function executorFixtureStates() {
  return executorCaseInputs().map((c) => ({ name: c.name, ...executorCaseState(c) }));
}

export function buildExecutorFixture() {
  const cases = executorCases();
  return {
    note: "Generated by pnpm policy:parity from packages/policy/src/parity.ts; checked by parity.test.ts and chains/monad/test/executor/ExecutorParity.t.sol. Do not edit by hand.",
    t0: s(T0),
    policyHash: executor.LAUNCH_POLICY_HASH,
    venueFeeBps: VENUE_FEE_BPS,
    caseCount: cases.length,
    cases,
  };
}

export const executorParityJson = () => `${JSON.stringify(buildExecutorFixture(), null, 2)}\n`;
