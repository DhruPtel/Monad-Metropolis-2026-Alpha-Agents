import type { AgentStateV3, MarketStateV3, TokenInfoV3 } from "@alpha-agents/chain-tools";
import { type TargetPortfolioParams, amountForValue, executorV3 } from "@alpha-agents/policy";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { type TestInputsV2, checkPortfolioProposal, portfolioEnvelope } from "./test-stage.ts";

/**
 * The Test stage v2 (F-U6, D-344): every rule a target portfolio must pass,
 * each produced by a plan built to fail exactly that rule, on a market of
 * three class F tokens and one class A token with the account at 100 USDC.
 */
const USDC = "0x00000000000000000000000000000000000000c1" as Hex;
const WMON = "0x00000000000000000000000000000000000000c2" as Hex;
const WBTC = "0x00000000000000000000000000000000000000c3" as Hex;
const AUSD = "0x00000000000000000000000000000000000000c4" as Hex;
const TOKA = "0x00000000000000000000000000000000000000c5" as Hex;
const SCRN = "0x00000000000000000000000000000000000000c6" as Hex;
const E18 = 10n ** 18n;
const PX_WMON = 25n * 10n ** 15n;
const PX_WBTC = 100_000n * E18;
const NOW = 1_790_000_000n;

const token = (
  t: Hex,
  symbol: string,
  decimals: number,
  over: Partial<TokenInfoV3> = {},
): TokenInfoV3 => ({
  token: t,
  symbol,
  decimals,
  lane: "CORE",
  status: "BUYABLE",
  priceClass: "F",
  maxPositionBps: 4_500,
  ...over,
});

const market = (over: Partial<MarketStateV3> = {}): MarketStateV3 => ({
  chainId: 143143,
  block: 500n,
  timestamp: NOW,
  policy: { ...executorV3.LAUNCH_POLICY },
  policyHash: executorV3.LAUNCH_POLICY_HASH,
  paused: false,
  adapterAllowed: true,
  attestorSet: false,
  usdc: USDC,
  wmon: WMON,
  tokens: [
    token(USDC, "USDC", 6, { priceClass: "USDC" as never, maxPositionBps: 10_000 }),
    token(WMON, "WMON", 18),
    token(WBTC, "WBTC", 8, { maxPositionBps: 1_500 }),
    token(AUSD, "AUSD", 6),
    token(TOKA, "TOKA", 18, { priceClass: "A", maxPositionBps: 1_500 }),
    token(SCRN, "SCRN", 18, { lane: "SCREENED", maxPositionBps: 1_500 }),
  ],
  prices: {
    [USDC]: { priceE18: E18, updatedAt: NOW, reason: "OK" },
    [WMON]: { priceE18: PX_WMON, updatedAt: NOW, reason: "OK" },
    [WBTC]: { priceE18: PX_WBTC, updatedAt: NOW, reason: "OK" },
    [AUSD]: { priceE18: E18, updatedAt: NOW, reason: "OK" },
    [SCRN]: { priceE18: E18, updatedAt: NOW, reason: "OK" },
  },
  pools: [],
  ...over,
});

const agent = (over: Partial<AgentStateV3> = {}): AgentStateV3 => ({
  block: 500n,
  timestamp: NOW,
  owner: "0x00000000000000000000000000000000000a11ce",
  ownerEpoch: 1n,
  configEpoch: 0n,
  account: "0x00000000000000000000000000000000000ac003",
  v2Account: null,
  mode: "NORMAL",
  screenedOptIn: false,
  holdings: [
    {
      token: USDC,
      decimals: 6,
      balance: 100_000_000n,
      free: 100_000_000n,
      costBasis: 100_000_000n,
      lastPriceE18: E18,
      lastPricedAt: NOW,
    },
  ],
  values: { nav: 100_000_000n, capped: 100_000_000n, totalBasis: 100_000_000n, classABasis: 0n },
  breaker: { nav: 100_000_000n, perUnit: E18, peak: E18, drawdownBps: 0n },
  grant: null,
  trades: [],
  tradesLeft: 20,
  nextSlotFreesAt: 0n,
  turnoverUsed: 0n,
  ...over,
});

const position = (t: Hex, weight: number, band = 300) => ({
  token: t,
  targetWeightBps: weight,
  bandBps: band,
  thesisId: `t-${t.slice(-2)}`,
  exit: { killCriterion: "The thesis fails", recheckAt: "2026-11-01T00:00:00.000Z" },
});

const plan = (over: Partial<TargetPortfolioParams> = {}): TargetPortfolioParams => ({
  positions: [position(WMON, 3_000), position(WBTC, 1_000)],
  cashTargetBps: 6_000,
  minTradeUsdcE6: 500_000n,
  volatilityBrakeBps: 20_000,
  costHurdleBps: 40,
  maxLegBps: 1_000,
  ...over,
});

/** Quotes at the oracle less 10 bps, unless the test says otherwise. */
function inputs(over: Partial<TestInputsV2> = {}): TestInputsV2 {
  const m = over.market ?? market();
  return {
    aggressiveness: "BALANCED",
    market: m,
    agent: agent(),
    screenFresh: async () => true,
    quoteBuy: async (t, usdcE6) => {
      const info = m.tokens.find((x) => x.token === t);
      const px = m.prices[t]?.priceE18;
      if (!info || !px) return null;
      return (amountForValue(usdcE6, px, info.decimals) * 9_990n) / 10_000n;
    },
    lastAgentChangeAt: null,
    now: new Date(Number(NOW) * 1000),
    ...over,
  };
}

const codes = async (p: TargetPortfolioParams, i: TestInputsV2 = inputs()) =>
  (await checkPortfolioProposal(p, i)).map((f) => f.code);

describe("the Test stage over a target portfolio (F-U6, D-344)", () => {
  it("passes a plan inside every rule", async () => {
    expect(await codes(plan())).toEqual([]);
  });

  it("refuses the template's own bounds and shape", async () => {
    expect(await codes(plan({ cashTargetBps: 5_000 }))).toContain("OUT_OF_BOUNDS");
    expect(await codes(plan({ maxLegBps: 1_300 }))).toEqual(
      expect.arrayContaining(["OUT_OF_BOUNDS", "HARD_LIMIT"]),
    );
  });

  it("knows the registry: unregistered, sell-only, screened without the opt-in", async () => {
    const dead = "0x000000000000000000000000000000000000dead" as Hex;
    expect(
      await codes(plan({ positions: [position(dead, 3_000), position(WBTC, 1_000)] })),
    ).toContain("TOKEN_NOT_REGISTERED");
    const sellOnly = market({
      tokens: market().tokens.map((t) =>
        t.token === WMON ? { ...t, status: "SELL_ONLY" as const } : t,
      ),
    });
    expect(await codes(plan(), inputs({ market: sellOnly }))).toContain("TOKEN_NOT_BUYABLE");
    expect(
      await codes(plan({ positions: [position(SCRN, 1_000), position(WMON, 3_000)] })),
    ).toContain("NOT_OPTED_IN");
    expect(
      await codes(
        plan({ positions: [position(SCRN, 1_000), position(WMON, 3_000)] }),
        inputs({ agent: agent({ screenedOptIn: true }) }),
      ),
    ).not.toContain("NOT_OPTED_IN");
  });

  it("wants a fresh passing screen for every position", async () => {
    const f = await checkPortfolioProposal(
      plan(),
      inputs({ screenFresh: async (t) => t !== WBTC }),
    );
    expect(f.map((x) => [x.code, x.field])).toEqual([["SCREEN_STALE", "positions.1.token"]]);
    // When the platform cannot say, the Test does not refuse; the runner holds at buy time.
    expect(await codes(plan(), inputs({ screenFresh: async () => null }))).toEqual([]);
  });

  it("enforces the aggressiveness envelope (A-60): positions, class A, caps, stablecoins", async () => {
    const many = plan({
      positions: [
        position(WMON, 1_000),
        position(WBTC, 500),
        position(AUSD, 500),
        ...Array.from({ length: 6 }, (_, i) =>
          position(`0x${String(i + 7).padStart(40, "0")}` as Hex, 100),
        ),
      ],
      cashTargetBps: 7_400,
    });
    expect(await codes(many)).toContain("ENVELOPE_POSITIONS");
    // Conservative: class F only, 20% per position, 30% stable.
    const conservative = inputs({ aggressiveness: "CONSERVATIVE" });
    expect(
      await codes(
        plan({ positions: [position(WMON, 2_500), position(WBTC, 1_000)], cashTargetBps: 6_500 }),
        conservative,
      ),
    ).toContain("ENVELOPE_POSITION");
    expect(
      await codes(
        plan({ positions: [position(TOKA, 1_000), position(WMON, 2_000)], cashTargetBps: 7_000 }),
        conservative,
      ),
    ).toContain("ENVELOPE_CLASS_A");
    expect(
      await codes(
        plan({
          positions: [position(WMON, 2_000), position(WBTC, 1_000), position(AUSD, 1_000)],
          cashTargetBps: 6_000,
        }),
        conservative,
      ),
    ).toEqual([]);
    expect(
      await codes(
        plan({ positions: [position(WMON, 2_000), position(WBTC, 1_000)], cashTargetBps: 2_000 }),
        conservative,
      ),
    ).toContain("ENVELOPE_STABLE");
    // Balanced: class A at most 8% per position and 25% in total.
    expect(
      await codes(
        plan({ positions: [position(TOKA, 900), position(WMON, 3_000)], cashTargetBps: 6_100 }),
      ),
    ).toContain("ENVELOPE_CLASS_A");
    const aggressive = inputs({ aggressiveness: "AGGRESSIVE" });
    const fourA = plan({
      positions: [
        position(TOKA, 1_400),
        position(`0x${"7".padStart(40, "0")}` as Hex, 1_400),
        position(`0x${"8".padStart(40, "0")}` as Hex, 1_400),
        position(`0x${"9".padStart(40, "0")}` as Hex, 1_400),
      ],
      cashTargetBps: 4_400,
    });
    const m = market({
      tokens: [
        ...market().tokens,
        ...["7", "8", "9"].map((n) =>
          token(`0x${n.padStart(40, "0")}` as Hex, `A${n}`, 18, {
            priceClass: "A",
            maxPositionBps: 1_500,
          }),
        ),
      ],
    });
    expect(await codes(fourA, { ...aggressive, market: m })).toContain("ENVELOPE_CLASS_A_TOTAL");
    // The registry's own cap on WBTC (15%) binds under every level.
    expect(
      await codes(plan({ positions: [position(WMON, 2_000), position(WBTC, 2_000)] })),
    ).toContain("ENVELOPE_POSITION");
  });

  it("holds the hard limits: the USDC floor, the per-trade cap and the slippage limit", async () => {
    expect(
      await codes(
        plan({
          positions: [position(WMON, 4_500), position(WBTC, 1_000), position(AUSD, 4_000)],
          cashTargetBps: 500,
        }),
      ),
    ).toContain("HARD_LIMIT");
    expect(await codes(plan({ costHurdleBps: 150 }))).toContain("HARD_LIMIT");
  });

  it("checks depth at the slippage limit and the implied turnover against the 24-hour cap", async () => {
    const shallow = inputs({
      quoteBuy: async (t, usdcE6) =>
        t === WBTC
          ? (amountForValue(usdcE6, PX_WBTC, 8) * 9_800n) / 10_000n
          : amountForValue(usdcE6, PX_WMON, 18),
    });
    const f = await checkPortfolioProposal(plan(), shallow);
    expect(f.map((x) => [x.code, x.field])).toEqual([["DEPTH", "positions.WBTC"]]);
    expect(await codes(plan(), inputs({ quoteBuy: async () => null }))).toEqual(["DEPTH", "DEPTH"]);
    // 40 USDC of buys against a 24-hour cap of 25% of 100 USDC.
    const m = market({ policy: { ...executorV3.LAUNCH_POLICY, maxTurnoverBps: 2_500 } });
    expect(await codes(plan(), inputs({ market: m }))).toContain("TURNOVER");
    // Values unreadable: depth and turnover are not checked, and the plan says so.
    const stale = market({
      prices: {
        ...market().prices,
        [WMON]: { priceE18: PX_WMON, updatedAt: NOW - 10_000n, reason: "STALE" as never },
      },
    });
    const holding = agent({
      holdings: [
        ...agent().holdings,
        {
          token: WMON,
          decimals: 18,
          balance: E18,
          free: E18,
          costBasis: 25_000n,
          lastPriceE18: PX_WMON,
          lastPricedAt: NOW,
        },
      ],
    });
    expect(await codes(plan(), inputs({ market: stale, agent: holding }))).toContain(
      "VALUES_UNUSABLE",
    );
  });

  it("keeps the 24-hour cooldown after an accepted agent change", async () => {
    const at = new Date(Number(NOW) * 1000 - 3_600_000);
    expect(await codes(plan(), inputs({ lastAgentChangeAt: at }))).toContain("COOLDOWN");
  });

  it("tells the Zoom out what it may draft: the envelope, the tokens it may name, and the cooldown", () => {
    const e = portfolioEnvelope(null, inputs());
    expect(e.template).toBe("target_portfolio@1");
    expect(e.envelope.maxPositions).toBe(8);
    expect(e.limits.maxTradeBps).toBe(executorV3.LAUNCH_POLICY.maxTradeBps);
    const byToken = Object.fromEntries(e.tokens.map((t) => [t.symbol, t]));
    expect(byToken.WMON).toMatchObject({
      buyable: true,
      capBps: Math.min(4_500, executorV3.LAUNCH_POLICY.maxAssetBps),
    });
    expect(byToken.WBTC).toMatchObject({ buyable: true, capBps: 1_500 });
    expect(byToken.TOKA).toMatchObject({ buyable: true, class: "A" });
    expect(byToken.SCRN).toMatchObject({ buyable: false, lane: "SCREENED" });
    expect(byToken.USDC).toBeUndefined();
    expect(e.mayProposeNow).toBe(true);
    const conservative = portfolioEnvelope(plan(), inputs({ aggressiveness: "CONSERVATIVE" }));
    expect(conservative.tokens.find((t) => t.symbol === "TOKA")?.buyable).toBe(false);
    expect(conservative.currentPositions).toBe(2);
  });
});
