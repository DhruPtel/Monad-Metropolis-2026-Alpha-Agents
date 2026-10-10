/**
 * The fund agent's v3 rules, offchain (F-U2, FINAL_PLAN 0.4, D-343): each
 * function mirrors one part of chains/monad/src/fund in the same order and
 * with the same integer arithmetic, so the chain tools and the runner can say
 * in advance what the contracts will answer. The fund parity fixture runs
 * both over the same cases (chains/monad/test/fund/FundParity.t.sol), and a
 * test fails if they ever disagree.
 */

/** Why a price was refused, or OK. The order is the Solidity enum `PriceReason`'s. */
export const PRICE_REASONS = [
  "OK",
  "UNKNOWN_ASSET",
  "ATTESTATION_REQUIRED",
  "FEED_REVERTED",
  "DECIMALS_MISMATCH",
  "ANSWER_NOT_POSITIVE",
  "ANSWER_OUT_OF_RANGE",
  "ROUND_INCOMPLETE",
  "FUTURE_TIMESTAMP",
  "STALE",
  "POOL_UNREADABLE",
  "POOL_DEVIATION",
  "POOL_UNSUPPORTED",
] as const;
export type PriceReason = (typeof PRICE_REASONS)[number];

export const LANES = ["NONE", "CORE", "SCREENED"] as const;
export type Lane = (typeof LANES)[number];
export const TOKEN_STATUSES = ["NONE", "BUYABLE", "SELL_ONLY", "FROZEN"] as const;
export type TokenStatus = (typeof TOKEN_STATUSES)[number];
export const POOL_STATUSES = ["NONE", "ACTIVE", "EXIT_ONLY", "PAUSED"] as const;
export type PoolStatus = (typeof POOL_STATUSES)[number];

/** One feed leg as recorded in the TokenRegistry. */
export interface LegSpec {
  readonly decimals: number;
  readonly maxAge: bigint;
}

/** What `decimals()` and `latestRoundData()` answered; null when either call failed. */
export interface LegAnswer {
  readonly decimals: number;
  readonly roundId: bigint;
  readonly answer: bigint;
  readonly updatedAt: bigint;
  readonly answeredInRound: bigint;
}

export interface LegReading {
  readonly valueE18: bigint;
  readonly updatedAt: bigint;
  readonly reason: PriceReason;
}

const MAX_PRICE_E18 = (1n << 128n) - 1n;
const ONE_E18 = 10n ** 18n;
const reading = (valueE18: bigint, updatedAt: bigint, reason: PriceReason): LegReading => ({
  valueE18,
  updatedAt,
  reason,
});

/** One feed leg (OracleAdapterV3.readLeg): the launch checks, against the leg's own bound. */
export function readLegV3(answer: LegAnswer | null, leg: LegSpec, now: bigint): LegReading {
  if (answer === null) return reading(0n, 0n, "FEED_REVERTED");
  if (answer.decimals !== leg.decimals) return reading(0n, 0n, "DECIMALS_MISMATCH");
  const { updatedAt } = answer;
  if (answer.answer <= 0n) return reading(0n, updatedAt, "ANSWER_NOT_POSITIVE");
  const scale = 10n ** BigInt(18 - leg.decimals);
  if (answer.answer > MAX_PRICE_E18 / scale) return reading(0n, updatedAt, "ANSWER_OUT_OF_RANGE");
  if (updatedAt === 0n || answer.answeredInRound < answer.roundId)
    return reading(0n, updatedAt, "ROUND_INCOMPLETE");
  if (updatedAt > now) return reading(0n, updatedAt, "FUTURE_TIMESTAMP");
  if (now - updatedAt >= leg.maxAge) return reading(0n, updatedAt, "STALE");
  return reading(answer.answer * scale, updatedAt, "OK");
}

/**
 * A class F token's price (OracleAdapterV3.price): the USD leg, then for a
 * composite the rate leg, multiplied and floored; the older update time.
 */
export function compositePriceV3(usd: LegReading, rate: LegReading | null): LegReading {
  if (usd.reason !== "OK" || rate === null) return usd;
  if (rate.reason !== "OK") return reading(0n, rate.updatedAt, rate.reason);
  const p = (rate.valueE18 * usd.valueE18) / ONE_E18;
  if (p === 0n || p > MAX_PRICE_E18) return reading(0n, rate.updatedAt, "ANSWER_OUT_OF_RANGE");
  return reading(p, rate.updatedAt < usd.updatedAt ? rate.updatedAt : usd.updatedAt, "OK");
}

/** How a registry account answers (D-351): an EOA, a reverting account, or its two flags. */
export type AccountKind = "eoa" | "reverts" | { readonly optIn: boolean; readonly vault: boolean };

/** TokenRegistry.buyableFor: a buyable core token, or a buyable screened token for an opted-in personal account. */
export function buyableFor(lane: Lane, status: TokenStatus, account: AccountKind): boolean {
  if (status !== "BUYABLE") return false;
  if (lane === "CORE") return true;
  if (lane !== "SCREENED" || account === "eoa" || account === "reverts") return false;
  return !account.vault && account.optIn;
}

/** TokenRegistry.sellable: buyable or sell-only, never frozen. */
export function sellable(status: TokenStatus): boolean {
  return status === "BUYABLE" || status === "SELL_ONLY";
}

/** Whether an instant move is allowed: only to a strictly stricter status (D-340). */
export function canTighten(current: TokenStatus, next: TokenStatus): boolean {
  return current !== "NONE" && TOKEN_STATUSES.indexOf(next) > TOKEN_STATUSES.indexOf(current);
}

/** Whether a timelocked restore is a valid proposal: a strictly looser, real status. */
export function canRestore(current: TokenStatus, next: TokenStatus): boolean {
  return (
    current !== "NONE" &&
    next !== "NONE" &&
    TOKEN_STATUSES.indexOf(next) < TOKEN_STATUSES.indexOf(current)
  );
}

/** A pool as a route sees it. Native MON is `0x0`; WMON stands in for it. */
export interface RoutePool {
  readonly name: string;
  readonly token0: string;
  readonly token1: string;
  readonly lane: Lane;
  readonly status: PoolStatus;
}

export type RouteOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: "BadRoute" | "PoolUnusable" | "BrokenRoute";
      readonly hop: number;
    };

export const MAX_HOPS = 3;
const NATIVE = "0x0";

/**
 * RouteAdapter.swapRoute's route checks, in its order: the shape, then each
 * hop's pool (status and lane, ProtocolRegistryV3.usablePool), its continuity
 * and that it visits a new token, then the end.
 */
export function checkRoute(
  tokenIn: string,
  tokenOut: string,
  hops: readonly RoutePool[],
  allowScreened: boolean,
  wmon: string,
  usdc: string,
): RouteOutcome {
  if (hops.length === 0 || hops.length > MAX_HOPS || tokenIn === tokenOut)
    return { ok: false, error: "BadRoute", hop: 0 };
  const held = (t: string) => (t === NATIVE ? wmon : t);
  const toUsdc = tokenOut === usdc;
  const path = [tokenIn];
  for (let i = 0; i < hops.length; i++) {
    const p = hops[i] as RoutePool;
    const statusOk = p.status === "ACTIVE" || (p.status === "EXIT_ONLY" && toUsdc);
    const laneOk = p.lane === "CORE" || (p.lane === "SCREENED" && allowScreened);
    if (!statusOk || !laneOk) return { ok: false, error: "PoolUnusable", hop: i };
    const [a, b] = [held(p.token0), held(p.token1)];
    const cur = path[i] as string;
    const next = cur === a ? b : cur === b ? a : null;
    if (next === null || path.includes(next)) return { ok: false, error: "BrokenRoute", hop: i };
    path.push(next);
  }
  if (path[hops.length] !== tokenOut) return { ok: false, error: "BrokenRoute", hop: hops.length };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

export const FUND_FIXTURE_PATH = "packages/policy/fixtures/fund-parity.json";

/** The pinned block's time, as the other fixtures use. */
const T0 = 1_790_876_425n;
const s = (v: bigint) => v.toString();
const reasonIndex = (r: PriceReason) => PRICE_REASONS.indexOf(r);

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
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)] as T;
  return { int, pick };
}

interface LegCaseInput {
  readonly name: string;
  readonly leg: LegSpec;
  readonly answer: LegAnswer | null;
  readonly now: bigint;
}

function legCase(c: LegCaseInput) {
  const r = readLegV3(c.answer, c.leg, c.now);
  const a = c.answer ?? {
    decimals: c.leg.decimals,
    roundId: 1n,
    answer: 0n,
    updatedAt: 0n,
    answeredInRound: 1n,
  };
  return {
    name: c.name,
    legDecimals: c.leg.decimals,
    maxAge: s(c.leg.maxAge),
    reverts: c.answer === null,
    decimals: a.decimals,
    roundId: s(a.roundId),
    answer: s(a.answer),
    updatedAt: s(a.updatedAt),
    answeredInRound: s(a.answeredInRound),
    time: s(c.now),
    reason: reasonIndex(r.reason),
    valueE18: s(r.valueE18),
    updatedAtOut: s(r.updatedAt),
  };
}

const round = (
  decimals: number,
  answer: bigint,
  updatedAt: bigint,
  roundId = 7n,
  answeredInRound = roundId,
) => ({
  decimals,
  roundId,
  answer,
  updatedAt,
  answeredInRound,
});

function legCases() {
  const MON: LegSpec = { decimals: 8, maxAge: 300n };
  const HOURLY: LegSpec = { decimals: 8, maxAge: 3_900n };
  const DAILY_RATE: LegSpec = { decimals: 18, maxAge: 90_000n };
  const p = 2_422_263n;
  const cases: LegCaseInput[] = [
    { name: "MON/USD fresh", leg: MON, answer: round(8, p, T0 - 10n), now: T0 },
    { name: "MON/USD 299 s old", leg: MON, answer: round(8, p, T0 - 299n), now: T0 },
    { name: "MON/USD exactly 300 s old", leg: MON, answer: round(8, p, T0 - 300n), now: T0 },
    {
      name: "USDC/USD 3,899 s old",
      leg: HOURLY,
      answer: round(8, 99_985_957n, T0 - 3_899n),
      now: T0,
    },
    {
      name: "USDC/USD exactly 3,900 s old",
      leg: HOURLY,
      answer: round(8, 99_985_957n, T0 - 3_900n),
      now: T0,
    },
    {
      name: "a rate 89,999 s old",
      leg: DAILY_RATE,
      answer: round(18, 1_116_108_835_704_729_169n, T0 - 89_999n),
      now: T0,
    },
    {
      name: "a rate exactly 90,000 s old",
      leg: DAILY_RATE,
      answer: round(18, 1_116_108_835_704_729_169n, T0 - 90_000n),
      now: T0,
    },
    { name: "a feed that reverts", leg: HOURLY, answer: null, now: T0 },
    { name: "decimals changed", leg: HOURLY, answer: round(18, p, T0), now: T0 },
    { name: "zero answer", leg: HOURLY, answer: round(8, 0n, T0), now: T0 },
    { name: "negative answer", leg: HOURLY, answer: round(8, -5n, T0), now: T0 },
    {
      name: "largest 8-decimal answer that fits",
      leg: HOURLY,
      answer: round(8, MAX_PRICE_E18 / 10n ** 10n, T0),
      now: T0,
    },
    {
      name: "one above it",
      leg: HOURLY,
      answer: round(8, MAX_PRICE_E18 / 10n ** 10n + 1n, T0),
      now: T0,
    },
    { name: "updatedAt zero", leg: HOURLY, answer: round(8, p, 0n), now: T0 },
    { name: "an earlier round's answer", leg: HOURLY, answer: round(8, p, T0, 9n, 8n), now: T0 },
    { name: "from the future", leg: HOURLY, answer: round(8, p, T0 + 1n), now: T0 },
  ];
  const r = rng(143);
  for (let i = 0; i < 40; i++) {
    const leg = r.pick([MON, HOURLY, DAILY_RATE]);
    const age = BigInt(r.int(0, Number(leg.maxAge) + 100));
    const decimals = r.int(0, 9) === 0 ? r.pick([6, 8, 18]) : leg.decimals;
    const answer = BigInt(r.int(-1, 2_000_000_000)) * (leg.decimals === 18 ? 10n ** 9n : 1n);
    cases.push({ name: `random ${i}`, leg, answer: round(decimals, answer, T0 - age), now: T0 });
  }
  return cases.map(legCase);
}

function priceCases() {
  const usd = (answer: bigint, age: bigint, maxAge = 300n) =>
    readLegV3(round(8, answer, T0 - age), { decimals: 8, maxAge }, T0);
  const rate = (answer: bigint, age: bigint) =>
    readLegV3(round(18, answer, T0 - age), { decimals: 18, maxAge: 90_000n }, T0);
  const cases = [
    {
      name: "direct",
      usdAnswer: 2_422_263n,
      usdAge: 10n,
      rateAnswer: 0n,
      rateAge: 0n,
      hasRate: false,
    },
    {
      name: "composite",
      usdAnswer: 2_422_263n,
      usdAge: 10n,
      rateAnswer: 1_633_334_254_878_552_670n,
      rateAge: 10_000n,
      hasRate: true,
    },
    {
      name: "composite with a stale USD leg",
      usdAnswer: 2_422_263n,
      usdAge: 300n,
      rateAnswer: 1_633_334_254_878_552_670n,
      rateAge: 10n,
      hasRate: true,
    },
    {
      name: "composite with a stale rate",
      usdAnswer: 2_422_263n,
      usdAge: 10n,
      rateAnswer: 1_100_000_000_000_000_000n,
      rateAge: 90_000n,
      hasRate: true,
    },
    {
      name: "composite with a zero rate",
      usdAnswer: 2_422_263n,
      usdAge: 10n,
      rateAnswer: 0n,
      rateAge: 10n,
      hasRate: true,
    },
    {
      name: "composite that floors to zero",
      usdAnswer: 1n,
      usdAge: 10n,
      rateAnswer: 1n,
      rateAge: 10n,
      hasRate: true,
    },
  ];
  return cases.map((c) => {
    const u = usd(c.usdAnswer, c.usdAge);
    const out = compositePriceV3(u, c.hasRate ? rate(c.rateAnswer, c.rateAge) : null);
    return {
      name: c.name,
      usdAnswer: s(c.usdAnswer),
      usdUpdatedAt: s(T0 - c.usdAge),
      hasRate: c.hasRate,
      rateAnswer: s(c.rateAnswer),
      rateUpdatedAt: s(T0 - c.rateAge),
      time: s(T0),
      reason: reasonIndex(out.reason),
      priceE18: s(out.valueE18),
      updatedAtOut: s(out.updatedAt),
    };
  });
}

/** Every lane, status and account kind; plus every instant move and every restore proposal. */
function tokenRuleCases() {
  const accounts: readonly [string, AccountKind][] = [
    ["eoa", "eoa"],
    ["reverts", "reverts"],
    ["opted in", { optIn: true, vault: false }],
    ["not opted in", { optIn: false, vault: false }],
    ["opted-in vault", { optIn: true, vault: true }],
  ];
  const statuses = ["BUYABLE", "SELL_ONLY", "FROZEN"] as const;
  const buy = [];
  for (const lane of ["CORE", "SCREENED"] as const)
    for (const status of statuses)
      for (const [name, a] of accounts)
        buy.push({
          lane: LANES.indexOf(lane),
          status: TOKEN_STATUSES.indexOf(status),
          account: name,
          buyable: buyableFor(lane, status, a),
          sellable: sellable(status),
        });
  const moves = [];
  for (const current of statuses)
    for (const next of statuses)
      moves.push({
        current: TOKEN_STATUSES.indexOf(current),
        next: TOKEN_STATUSES.indexOf(next),
        canTighten: canTighten(current, next),
        canRestore: canRestore(current, next),
      });
  return { buy, moves };
}

/**
 * Routes over the forge test's pools (FundBase): their names, tokens and
 * states. Tokens are named; the forge side maps names to its addresses.
 */
const POOLS: readonly RoutePool[] = [
  { name: "usdcWmon", token0: "USDC", token1: "WMON", lane: "CORE", status: "ACTIVE" },
  { name: "aWmon", token0: "A", token1: "WMON", lane: "CORE", status: "ACTIVE" },
  { name: "monC", token0: NATIVE, token1: "C", lane: "CORE", status: "ACTIVE" },
  { name: "bUsdc", token0: "B", token1: "USDC", lane: "CORE", status: "ACTIVE" },
];
const TOKENS = ["USDC", "WMON", "A", "B", "C"] as const;
const POOL_STATE_CHOICES = ["ACTIVE", "ACTIVE", "ACTIVE", "EXIT_ONLY", "PAUSED"] as const;

function routeCases() {
  const r = rng(10_143);
  const cases = [];
  const fixed: {
    tin: string;
    tout: string;
    hops: string[];
    states?: Record<string, PoolStatus>;
  }[] = [
    { tin: "WMON", tout: "USDC", hops: ["usdcWmon"] },
    { tin: "A", tout: "USDC", hops: ["aWmon", "usdcWmon"] },
    { tin: "A", tout: "B", hops: ["aWmon", "usdcWmon", "bUsdc"] },
    { tin: "C", tout: "USDC", hops: ["monC", "usdcWmon"] },
    { tin: "A", tout: "USDC", hops: ["usdcWmon"] },
    { tin: "A", tout: "USDC", hops: ["aWmon"] },
    { tin: "WMON", tout: "A", hops: ["usdcWmon", "usdcWmon", "aWmon"] },
    { tin: "USDC", tout: "USDC", hops: ["usdcWmon"] },
    { tin: "A", tout: "B", hops: ["aWmon", "usdcWmon", "bUsdc", "bUsdc"] },
    { tin: "USDC", tout: "WMON", hops: ["usdcWmon"], states: { usdcWmon: "EXIT_ONLY" } },
    { tin: "WMON", tout: "USDC", hops: ["usdcWmon"], states: { usdcWmon: "EXIT_ONLY" } },
    { tin: "A", tout: "USDC", hops: ["aWmon", "usdcWmon"], states: { aWmon: "PAUSED" } },
  ];
  for (let i = 0; i < 40; i++) {
    const n = r.int(1, 3);
    const hops = Array.from({ length: n }, () => r.pick(POOLS).name);
    const states: Record<string, PoolStatus> = {};
    for (const p of POOLS) states[p.name] = r.pick(POOL_STATE_CHOICES);
    fixed.push({ tin: r.pick(TOKENS), tout: r.pick(TOKENS), hops, states });
  }
  for (const f of fixed) {
    const hops = f.hops.map((name) => {
      const p = POOLS.find((x) => x.name === name) as RoutePool;
      return { ...p, status: f.states?.[name] ?? "ACTIVE" };
    });
    const out = checkRoute(f.tin, f.tout, hops, false, "WMON", "USDC");
    cases.push({
      tokenIn: f.tin,
      tokenOut: f.tout,
      hops: f.hops,
      // Each pool's status, in POOLS order.
      poolStatuses: POOLS.map((p) => POOL_STATUSES.indexOf(f.states?.[p.name] ?? "ACTIVE")),
      ok: out.ok,
      failure: out.ok ? "" : out.error,
      hop: out.ok ? 0 : out.hop,
    });
  }
  return cases;
}

export function buildFundFixture() {
  const legs = legCases();
  const prices = priceCases();
  const rules = tokenRuleCases();
  const routes = routeCases();
  return {
    comment:
      "F-U2: what packages/policy answers for each case; chains/monad/test/fund/FundParity.t.sol makes the contracts answer the same. Regenerate with pnpm policy:parity.",
    legCaseCount: legs.length,
    legCases: legs,
    priceCaseCount: prices.length,
    priceCases: prices,
    buyCaseCount: rules.buy.length,
    buyCases: rules.buy,
    moveCaseCount: rules.moves.length,
    moveCases: rules.moves,
    routeCaseCount: routes.length,
    routeCases: routes,
  };
}

export const fundParityJson = () => `${JSON.stringify(buildFundFixture(), null, 2)}\n`;
