import * as breaker from "./breaker.ts";
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
      name: "USDC 3,899 s old",
      feed: "USDC_USD",
      answer: round(100_000_000n, T0 - 3_899n),
      now: T0,
    },
    {
      name: "USDC exactly 3,900 s old",
      feed: "USDC_USD",
      answer: round(100_000_000n, T0 - 3_900n),
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
    const updatedAt = r.next() < 0.05 ? 0n : T0 - r.big(0n, 5_000n) + (r.next() < 0.1 ? 100n : 0n);
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
    pegCase("at the peg but stale", 100_000_000n, 3_900n),
    pegCase("depegged and stale: stale first", 90_000_000n, 3_900n),
    pegCase("zero", 0n, 60n),
  ];
  const r = rng(3);
  for (let i = 0; i < 20; i++) {
    cases.push(pegCase(`random peg ${i}`, r.big(97_000_000n, 103_000_000n), r.big(0n, 4_200n)));
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
