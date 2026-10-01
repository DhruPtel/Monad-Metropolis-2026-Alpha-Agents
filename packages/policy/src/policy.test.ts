import {
  type AmountRaw,
  type ClientRequestId,
  type ConfigEpoch,
  type OwnerEpoch,
  type PriceE18,
  REJECTION_CODES,
  type RebalanceIntent,
  type SwapIntent,
} from "@alpha-agents/domain";
import { describe, expect, it } from "vitest";
import {
  type AccountState,
  BREACH_FIXTURES,
  FIXTURE_NOW as NOW,
  LAUNCH_LIMITS,
  type PolicyResult,
  WMON_PRICE_E18,
  breakerMode,
  checkDeadline,
  checkRebalance,
  checkSwap,
  drawdownBps,
  fixtureState,
  fixtureSwap,
  usdc,
  windowUsage,
  wmonWorth,
} from "./index.ts";

const raw = (v: bigint) => v as AmountRaw;
const codes = (r: PolicyResult<unknown>) => (r.ok ? [] : r.rejections.map((x) => x.code));
const buyWmon = (valueE6: bigint) => fixtureSwap({ sellAmountRaw: raw(valueE6) });
const sellWmon = (valueE6: bigint) =>
  fixtureSwap({ sell: "WMON", buy: "USDC", sellAmountRaw: wmonWorth(valueE6) });
const holdings = (usdcWhole: bigint, wmonWhole: bigint) => ({
  holdings: { USDC: raw(usdc(usdcWhole)), WMON: wmonWorth(usdc(wmonWhole)) },
});
const trades = (count: number, value: bigint, at = NOW - 3_600) =>
  Array.from({ length: count }, () => ({ at, valueUsdcE6: value as never }));

describe("launch limits", () => {
  it("match the plan", () => {
    expect(LAUNCH_LIMITS).toMatchObject({
      maxTradeBps: 1_000,
      maxAssetBps: 4_000,
      minUsdcBps: 1_000,
      maxSlippageBps: 50,
      maxTradesPerWindow: 20,
      maxTurnoverBps: 10_000,
      windowSeconds: 86_400,
      deadlineSeconds: 120,
      oracleMaxAgeSeconds: 300,
      oracleMaxDeviationBps: 200,
      breakerReduceOnlyBps: 1_000,
      breakerPauseBps: 2_000,
    });
  });
});

describe("breach fixtures", () => {
  it.each(BREACH_FIXTURES.map((f) => [f.name, f] as const))("%s is rejected", (_, f) => {
    const result = checkSwap(f.intent, f.state, f.now, { limits: f.limits });
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual([f.expected]);
  });

  it("covers every limit the pre-checks enforce", () => {
    const covered = new Set(BREACH_FIXTURES.map((f) => f.expected));
    const offchain = REJECTION_CODES.filter(
      (c) =>
        ![
          "VENUE_NOT_ALLOWED",
          "SIMULATION_FAILED",
          "EXECUTOR_REVERTED",
          "EPOCH_MISMATCH",
          "DEADLINE_EXPIRED",
          "DEADLINE_TOO_FAR",
        ].includes(c),
    );
    for (const code of offchain) expect(covered, code).toContain(code);
  });

  it("every rejection carries a code, a message and a detail", () => {
    for (const f of BREACH_FIXTURES) {
      const r = checkSwap(f.intent, f.state, f.now, { limits: f.limits });
      if (r.ok) throw new Error(f.name);
      for (const x of r.rejections) {
        expect(REJECTION_CODES).toContain(x.code);
        expect(x.message.length).toBeGreaterThan(10);
        expect(x.detail.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("max 10% of account value per trade", () => {
  it.each([
    ["just under", usdc(10_000n) - 1n, true],
    ["at", usdc(10_000n), true],
    ["just over", usdc(10_000n) + 1n, false],
  ])("%s the limit", (_, value, ok) => {
    const r = checkSwap(sellWmon(value), fixtureState(), NOW);
    expect(codes(r)).toEqual(ok ? [] : ["TRADE_SIZE_EXCEEDED"]);
  });

  it("reports value and NAV on success", () => {
    const r = checkSwap(sellWmon(usdc(10_000n)), fixtureState(), NOW);
    expect(r.ok && r.value).toMatchObject({
      navUsdcE6: usdc(100_000n),
      valueUsdcE6: usdc(10_000n),
    });
  });
});

describe("max 40% in any non-USDC asset", () => {
  const state = fixtureState(holdings(65_000n, 35_000n));
  it.each([
    ["just under", usdc(5_000n) - 1n, true],
    ["at", usdc(5_000n), true],
    ["just over", usdc(5_000n) + 1n, false],
  ])("%s the limit", (_, value, ok) => {
    expect(codes(checkSwap(buyWmon(value), state, NOW))).toEqual(ok ? [] : ["CONCENTRATION_CAP"]);
  });
});

describe("at least 10% in USDC", () => {
  const limits = { ...LAUNCH_LIMITS, maxAssetBps: 10_000 };
  const state = fixtureState(holdings(12_000n, 88_000n));
  it.each([
    ["just above", usdc(2_000n) - 1n, true],
    ["at", usdc(2_000n), true],
    ["just below", usdc(2_000n) + 1n, false],
  ])("USDC %s the floor after the trade", (_, value, ok) => {
    expect(codes(checkSwap(buyWmon(value), state, NOW, { limits }))).toEqual(
      ok ? [] : ["USDC_FLOOR"],
    );
  });
});

describe("reduce-only exemption: output USDC", () => {
  it("skips the concentration and floor checks when the output is USDC", () => {
    // 60% WMON is already over the cap; selling some into USDC still passes.
    const state = fixtureState(holdings(40_000n, 60_000n));
    expect(codes(checkSwap(sellWmon(usdc(10_000n)), state, NOW))).toEqual([]);
  });

  it.each(["REDUCE_ONLY", "WIND_DOWN"] as const)("allows a sale into USDC in %s", (mode) => {
    expect(codes(checkSwap(sellWmon(usdc(1_000n)), fixtureState({ mode }), NOW))).toEqual([]);
  });

  it.each(["REDUCE_ONLY", "WIND_DOWN"] as const)("refuses a buy of WMON in %s", (mode) => {
    expect(codes(checkSwap(buyWmon(usdc(1_000n)), fixtureState({ mode }), NOW))).toEqual([
      "REDUCE_ONLY_MODE",
    ]);
  });

  it("refuses even a sale into USDC while PAUSED, and every trade in HANDOVER", () => {
    expect(codes(checkSwap(sellWmon(usdc(1_000n)), fixtureState({ mode: "PAUSED" }), NOW))).toEqual(
      ["PAUSED"],
    );
    expect(
      codes(checkSwap(sellWmon(usdc(1_000n)), fixtureState({ mode: "HANDOVER" }), NOW)),
    ).toEqual(["EPOCH_MISMATCH"]);
  });
});

describe("max 0.5% slippage", () => {
  it.each([
    [49, true],
    [50, true],
    [51, false],
  ])("requested %i bps", (bps, ok) => {
    const intent = fixtureSwap({ maxSlippageBps: bps as SwapIntent["maxSlippageBps"] });
    expect(codes(checkSwap(intent, fixtureState(), NOW))).toEqual(ok ? [] : ["SLIPPAGE_TOO_HIGH"]);
  });

  it("defaults to the limit when the intent names none", () => {
    expect(checkSwap(fixtureSwap(), fixtureState(), NOW).ok).toBe(true);
  });

  // 1,000 USDC buys 40,000 WMON at the oracle; 0.5% below is 39,800 WMON.
  const floor = 39_800n * 10n ** 18n;
  it.each([
    ["above the oracle floor", floor + 1n, true],
    ["at the oracle floor", floor, true],
    ["below the oracle floor", floor - 1n, false],
  ])("quote %s", (_, expectedOut, ok) => {
    const r = checkSwap(buyWmon(usdc(1_000n)), fixtureState(), NOW, {
      quote: { expectedOutRaw: raw(expectedOut) },
    });
    expect(codes(r)).toEqual(ok ? [] : ["SLIPPAGE_TOO_HIGH"]);
  });
});

describe("rolling 20 trades per 24 hours", () => {
  it.each([
    [18, true],
    [19, true],
    [20, false],
  ])("with %i trades already in the window", (n, ok) => {
    const r = checkSwap(buyWmon(usdc(1_000n)), fixtureState({ recentTrades: trades(n, 1n) }), NOW);
    expect(codes(r)).toEqual(ok ? [] : ["DAILY_TRADE_LIMIT"]);
  });

  it("does not count a trade exactly 24 hours old, and counts one a second younger", () => {
    const at = (age: number) =>
      fixtureState({
        recentTrades: [...trades(19, 1n), { at: NOW - age, valueUsdcE6: 1n as never }],
      });
    expect(checkSwap(buyWmon(usdc(1_000n)), at(86_400), NOW).ok).toBe(true);
    expect(codes(checkSwap(buyWmon(usdc(1_000n)), at(86_399), NOW))).toEqual(["DAILY_TRADE_LIMIT"]);
  });

  it("ignores trades stamped in the future", () => {
    const state = fixtureState({ recentTrades: trades(20, 1n, NOW + 10) });
    expect(windowUsage(state, NOW).tradesUsed).toBe(0);
  });

  it("reports when the next slot frees", () => {
    const state = fixtureState({
      recentTrades: [
        ...trades(19, 1n, NOW - 100),
        { at: NOW - 50_000, valueUsdcE6: 1n as never },
        { at: NOW - 90_000, valueUsdcE6: 1n as never }, // outside the window
      ],
    });
    expect(windowUsage(state, NOW)).toMatchObject({
      tradesUsed: 20,
      tradesLeft: 0,
      nextSlotFreesAt: NOW - 50_000 + 86_400,
    });
  });
});

describe("rolling 24-hour turnover cap of 100% of NAV", () => {
  const state = fixtureState({ recentTrades: trades(9, usdc(10_000n)) });
  it.each([
    ["just under", usdc(10_000n) - 1n, true],
    ["at", usdc(10_000n), true],
    ["just over", usdc(10_000n) + 1n, false],
  ])("%s the cap", (_, value, ok) => {
    const r = checkSwap(sellWmon(value), state, NOW, {
      limits: { ...LAUNCH_LIMITS, maxTradeBps: 10_000 },
    });
    expect(codes(r)).toEqual(ok ? [] : ["TURNOVER_CAP"]);
  });

  it("frees turnover once trades leave the window", () => {
    const old = fixtureState({ recentTrades: trades(9, usdc(10_000n), NOW - 86_400) });
    expect(windowUsage(old, NOW).turnoverUsedUsdcE6).toBe(0n);
  });
});

describe("2-minute deadlines", () => {
  it.each([
    [NOW - 1, "DEADLINE_EXPIRED"],
    [NOW, undefined],
    [NOW + 119, undefined],
    [NOW + 120, undefined],
    [NOW + 121, "DEADLINE_TOO_FAR"],
  ])("deadline %i", (deadline, code) => {
    expect(checkDeadline(deadline, NOW)?.code).toBe(code);
  });
});

describe("oracle under 5 minutes old and within 2% of the pool", () => {
  const oracle = (age: number, pool: bigint) =>
    fixtureState({
      oracle: {
        WMON: { priceE18: WMON_PRICE_E18, updatedAt: NOW - age, poolPriceE18: pool as PriceE18 },
      },
    });
  it.each([
    [299, true],
    [300, true],
    [301, false],
  ])("age %is", (age, ok) => {
    expect(codes(checkSwap(fixtureSwap(), oracle(age, WMON_PRICE_E18), NOW))).toEqual(
      ok ? [] : ["ORACLE_STALE"],
    );
  });

  it("treats a reading from the future, a zero price and a missing reading as stale", () => {
    expect(codes(checkSwap(fixtureSwap(), oracle(-1, WMON_PRICE_E18), NOW))).toEqual([
      "ORACLE_STALE",
    ]);
    const zero = fixtureState({
      oracle: { WMON: { priceE18: 0n as PriceE18, updatedAt: NOW, poolPriceE18: 0n as PriceE18 } },
    });
    expect(codes(checkSwap(fixtureSwap(), zero, NOW))).toEqual(["ORACLE_STALE"]);
    expect(codes(checkSwap(fixtureSwap(), fixtureState({ oracle: {} }), NOW))).toEqual([
      "ORACLE_STALE",
    ]);
  });

  it("needs a fresh price for a held asset even when only USDC is involved", () => {
    const usdcOnly = fixtureSwap({ sell: "WMON", buy: "USDC", sellAmountRaw: raw(1n) });
    expect(codes(checkSwap(usdcOnly, oracle(301, WMON_PRICE_E18), NOW))).toEqual(["ORACLE_STALE"]);
  });

  const at2pct = (WMON_PRICE_E18 * 102n) / 100n;
  const below2pct = (WMON_PRICE_E18 * 98n) / 100n;
  it.each([
    ["pool 2% above, exactly", at2pct, true],
    ["pool just over 2% above", at2pct + 1n, false],
    ["pool 2% below, exactly", below2pct, true],
    ["pool just over 2% below", below2pct - 1n, false],
    ["pool 1.99% above", at2pct - 1n, true],
  ])("%s", (_, pool, ok) => {
    expect(codes(checkSwap(fixtureSwap(), oracle(60, pool), NOW))).toEqual(
      ok ? [] : ["ORACLE_POOL_DEVIATION"],
    );
  });
});

describe("circuit breaker", () => {
  const peak = 1_000_000n;
  it.each([
    [peak, "NORMAL"],
    [peak + 1n, "NORMAL"],
    [900_001n, "NORMAL"],
    [900_000n, "REDUCE_ONLY"],
    [800_001n, "REDUCE_ONLY"],
    [800_000n, "PAUSED"],
    [0n, "PAUSED"],
  ] as const)("current %s against peak 1,000,000 is %s", (current, mode) => {
    expect(breakerMode(peak, current)).toBe(mode);
  });

  it("reports drawdown in basis points", () => {
    expect(drawdownBps(peak, 900_000n)).toBe(1_000n);
    expect(drawdownBps(peak, peak + 5n)).toBe(0n);
    expect(drawdownBps(0n, 5n)).toBe(0n);
  });
});

describe("other gates", () => {
  it("refuses a session from an older epoch", () => {
    const epochs = {
      current: { owner: 2n as OwnerEpoch, config: 5n as ConfigEpoch },
      session: { owner: 1n as OwnerEpoch, config: 5n as ConfigEpoch },
    };
    expect(codes(checkSwap(fixtureSwap(), fixtureState({ epochs }), NOW))).toEqual([
      "EPOCH_MISMATCH",
    ]);
    const same = { current: epochs.current, session: epochs.current };
    expect(checkSwap(fixtureSwap(), fixtureState({ epochs: same }), NOW).ok).toBe(true);
  });

  it("reports every failing rule, not only the first", () => {
    const state: AccountState = fixtureState({ mode: "REDUCE_ONLY", recentTrades: trades(20, 1n) });
    const r = checkSwap(buyWmon(usdc(10_000n) + 1n), state, NOW);
    expect(codes(r)).toEqual([
      "REDUCE_ONLY_MODE",
      "TRADE_SIZE_EXCEEDED",
      "DAILY_TRADE_LIMIT",
      "CONCENTRATION_CAP",
    ]);
  });
});

describe("rebalance", () => {
  const rebalance = (usdcBps: number, wmonBps: number, toleranceBps?: number): RebalanceIntent => ({
    kind: "rebalance",
    schemaVersion: 1,
    account: "vault",
    targets: [
      { asset: "USDC", targetBps: usdcBps as never },
      { asset: "WMON", targetBps: wmonBps as never },
    ],
    ...(toleranceBps === undefined ? {} : { toleranceBps: toleranceBps as never }),
    reason: "fixture",
    clientRequestId: "fixture-0002" as ClientRequestId,
  });

  it("plans one leg for a move of exactly the per-trade cap", () => {
    const r = checkRebalance(rebalance(6_000, 4_000), fixtureState(), NOW);
    expect(r.ok && r.value.legs).toEqual([
      { sell: "USDC", buy: "WMON", valueUsdcE6: usdc(10_000n) },
    ]);
  });

  it("splits a move above the cap into sequential legs, sells before buys", () => {
    const r = checkRebalance(
      rebalance(6_000, 4_000),
      fixtureState(holdings(85_000n, 15_000n)),
      NOW,
    );
    expect(r.ok && r.value.legs.map((l) => l.valueUsdcE6)).toEqual([
      usdc(10_000n),
      usdc(10_000n),
      usdc(5_000n),
    ]);
    const down = checkRebalance(rebalance(9_000, 1_000), fixtureState(), NOW);
    expect(down.ok && down.value.legs).toEqual([
      { sell: "WMON", buy: "USDC", valueUsdcE6: usdc(10_000n) },
      { sell: "WMON", buy: "USDC", valueUsdcE6: usdc(10_000n) },
    ]);
  });

  it("leaves a delta within tolerance alone", () => {
    const r = checkRebalance(rebalance(6_900, 3_100, 100), fixtureState(), NOW);
    expect(r.ok && r.value.legs).toEqual([]);
  });

  it.each([
    [5_900, 4_100, ["CONCENTRATION_CAP"]],
    [900, 9_100, ["USDC_FLOOR", "CONCENTRATION_CAP"]],
  ] as const)("refuses targets %i/%i", (u, w, expected) => {
    const r = checkRebalance(rebalance(u, w), fixtureState(), NOW);
    expect(codes(r).slice(0, expected.length)).toEqual(expected);
  });

  it("refuses when there are not enough trade slots for every leg", () => {
    const state = fixtureState({ ...holdings(85_000n, 15_000n), recentTrades: trades(18, 1n) });
    expect(codes(checkRebalance(rebalance(6_000, 4_000), state, NOW))).toEqual([
      "DAILY_TRADE_LIMIT",
    ]);
  });

  it("allows only reductions in REDUCE_ONLY", () => {
    const state = fixtureState({ mode: "REDUCE_ONLY" });
    expect(codes(checkRebalance(rebalance(6_000, 4_000), state, NOW))).toEqual([
      "REDUCE_ONLY_MODE",
    ]);
    expect(checkRebalance(rebalance(8_000, 2_000), state, NOW).ok).toBe(true);
  });

  it("refuses everything while PAUSED", () => {
    expect(
      codes(checkRebalance(rebalance(8_000, 2_000), fixtureState({ mode: "PAUSED" }), NOW)),
    ).toEqual(["PAUSED"]);
  });
});
