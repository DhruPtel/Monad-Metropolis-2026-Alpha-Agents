import type { AgentStateV3, MarketStateV3, TokenInfoV3 } from "@alpha-agents/chain-tools";
import { type TargetPortfolioParams, amountForValue, executorV3 } from "@alpha-agents/policy";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  ProposalService,
  bandsParamsFromDecision,
  estimateMoveCost,
  portfolioParamsFromDecision,
  proposalPositions,
  sourceCounts,
} from "./proposals.ts";
import type { TestInputsV2 } from "./test-stage.ts";

/**
 * The proposal's pure parts (F-U9): the positions as the owner reads them,
 * the sources counted by class, the estimated cost to move, and the Zoom
 * out's decision params in the policy's shapes.
 */
const USDC = "0x00000000000000000000000000000000000000c1" as Hex;
const WMON = "0x00000000000000000000000000000000000000c2" as Hex;
const WBTC = "0x00000000000000000000000000000000000000c3" as Hex;
const E18 = 10n ** 18n;
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
const market = (): MarketStateV3 => ({
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
    token(WBTC, "WBTC", 8),
  ],
  prices: {
    [USDC]: { priceE18: E18, updatedAt: NOW, reason: "OK" },
    [WMON]: { priceE18: 25n * 10n ** 15n, updatedAt: NOW, reason: "OK" },
    [WBTC]: { priceE18: 100_000n * E18, updatedAt: NOW, reason: "OK" },
  },
  pools: [],
});
const agent = (holdings: AgentStateV3["holdings"]): AgentStateV3 => ({
  block: 500n,
  timestamp: NOW,
  owner: "0x00000000000000000000000000000000000a11ce",
  ownerEpoch: 1n,
  configEpoch: 0n,
  account: "0x00000000000000000000000000000000000ac003",
  isVault: false,
  vault: null,
  personalAccount: null,
  v2Account: null,
  mode: "NORMAL",
  screenedOptIn: false,
  holdings,
  values: { nav: 100_000_000n, capped: 100_000_000n, totalBasis: 100_000_000n, classABasis: 0n },
  breaker: { nav: 100_000_000n, perUnit: E18, peak: E18, drawdownBps: 0n },
  grant: null,
  trades: [],
  tradesLeft: 20,
  nextSlotFreesAt: 0n,
  turnoverUsed: 0n,
});
const cash = (usdcE6: bigint) => ({
  token: USDC,
  decimals: 6,
  balance: usdcE6,
  free: usdcE6,
  costBasis: usdcE6,
  lastPriceE18: E18,
  lastPricedAt: NOW,
});
/** Quotes at the oracle less 10 bps. */
const inputs = (holdings: AgentStateV3["holdings"]): TestInputsV2 => {
  const m = market();
  return {
    aggressiveness: "BALANCED",
    market: m,
    agent: agent(holdings),
    screenFresh: async () => true,
    quoteBuy: async (t, usdcE6) => {
      const info = m.tokens.find((x) => x.token === t);
      const px = m.prices[t]?.priceE18;
      if (!info || !px) return null;
      return (amountForValue(usdcE6, px, info.decimals) * 9_990n) / 10_000n;
    },
    lastAgentChangeAt: null,
    now: new Date(Number(NOW) * 1_000),
  };
};
const position = (t: Hex, weight: number, thesisId: string) => ({
  token: t,
  targetWeightBps: weight,
  bandBps: 300,
  thesisId,
  exit: { killCriterion: "The thesis fails.", recheckAt: "2026-11-01", trimAboveBps: 3_000 },
});
const plan = (): TargetPortfolioParams => ({
  positions: [position(WMON, 2_000, "WMON_ADD"), position(WBTC, 2_000, "WBTC_ADD")],
  cashTargetBps: 6_000,
  minTradeUsdcE6: 500_000n,
  volatilityBrakeBps: 20_000,
  costHurdleBps: 40,
  maxLegBps: 1_000,
});

describe("portfolio proposals (F-U9)", () => {
  it("counts a Dive's sources by class, the fundamentals included", () => {
    expect(
      sourceCounts({
        evidenceFor: [{ class: "onchain" }, { class: "market" }],
        evidenceAgainst: [{ class: "news" }],
        fundamentals: { usage: { class: "primary" }, tvl: null, control: { class: "onchain" } },
      }),
    ).toEqual({ onchain: 2, market: 1, primary: 1, news: 1, social: 0 });
    expect(sourceCounts(null)).toEqual({ onchain: 0, market: 0, primary: 0, news: 0, social: 0 });
  });

  it("reads each position from the draft, the plan in force, the calls, the Dive and the Challenge", () => {
    const positions = proposalPositions({
      params: plan(),
      current: [{ token: WMON.toUpperCase().replace("0X", "0x"), targetWeightBps: 1_000 }],
      rationale: {
        decision: "PROPOSE",
        reasonCode: null,
        portfolioView: "v",
        evidenceStrength: "mixed",
        whatWouldChangeIt: "w",
        themeCodes: ["WMON_ADD", "WBTC_ADD"],
        points: [],
        positions: [
          {
            token: WMON,
            symbol: "WMON",
            action: "ADD",
            themeCode: "WMON_ADD",
            reason: "Deeper pool.",
          },
        ],
      },
      themes: [
        {
          themeCode: "WMON_ADD",
          symbol: "WMON",
          thesis: { statement: "MON keeps its depth.", confidence: "medium" },
          evidenceFor: [{ class: "onchain" }],
          evidenceAgainst: [],
          fundamentals: {},
        },
        {
          themeCode: "WBTC_ADD",
          symbol: "WBTC",
          thesis: null,
          evidenceFor: [],
          evidenceAgainst: [{ class: "social" }],
          fundamentals: {},
        },
      ],
      challenges: [{ themeCode: "WMON_ADD", verdict: "WEAKENED" }],
      symbols: { [WBTC]: "WBTC" },
    });
    expect(positions).toEqual([
      {
        token: WMON,
        symbol: "WMON",
        targetWeightBps: 2_000,
        bandBps: 300,
        currentWeightBps: 1_000,
        action: "ADD",
        thesisCode: "WMON_ADD",
        thesis: "MON keeps its depth.",
        killCriterion: "The thesis fails.",
        recheckAt: "2026-11-01",
        trimAboveBps: 3_000,
        confidence: "medium",
        sources: { onchain: 1, market: 0, primary: 0, news: 0, social: 0 },
        verdict: "WEAKENED",
        reason: "Deeper pool.",
      },
      {
        token: WBTC,
        symbol: "WBTC",
        targetWeightBps: 2_000,
        bandBps: 300,
        currentWeightBps: null,
        action: "ADD",
        thesisCode: "WBTC_ADD",
        thesis: null,
        killCriterion: "The thesis fails.",
        recheckAt: "2026-11-01",
        trimAboveBps: 3_000,
        confidence: null,
        sources: { onchain: 0, market: 0, primary: 0, news: 0, social: 1 },
        verdict: null,
        reason: "",
      },
    ]);
  });

  it("estimates the cost to move: one leg per token that moves, buys at today's quote, sells at the hurdle", async () => {
    // All cash: two buys of 20 USDC each, quoted 10 bps under the oracle.
    const fromCash = await estimateMoveCost(plan(), inputs([cash(100_000_000n)]));
    expect(fromCash).toMatchObject({ legs: 2, turnoverUsdcE6: "40000000", costBps: 10 });
    expect(fromCash?.estimatedCostUsdcE6).toBe("40000");
    // Already there: nothing moves.
    const wmon = {
      token: WMON,
      decimals: 18,
      balance: 800n * E18,
      free: 800n * E18,
      costBasis: 20_000_000n,
      lastPriceE18: 25n * 10n ** 15n,
      lastPricedAt: NOW,
    };
    const wbtc = {
      token: WBTC,
      decimals: 8,
      balance: 20_000n,
      free: 20_000n,
      costBasis: 20_000_000n,
      lastPriceE18: 100_000n * E18,
      lastPricedAt: NOW,
    };
    const inBand = await estimateMoveCost(plan(), inputs([cash(60_000_000n), wmon, wbtc]));
    expect(inBand).toMatchObject({ legs: 0, turnoverUsdcE6: "0", estimatedCostUsdcE6: "0" });
    // Leaving a token: a sell counted at the plan's cost hurdle (40 bps of 20 USDC).
    const exit = await estimateMoveCost(
      { ...plan(), positions: [position(WMON, 2_000, "WMON_ADD")] },
      inputs([cash(60_000_000n), wmon, wbtc]),
    );
    expect(exit).toMatchObject({
      legs: 1,
      turnoverUsdcE6: "20000000",
      estimatedCostUsdcE6: "80000",
      costBps: 40,
    });
    expect(await estimateMoveCost(plan(), inputs([]))).toMatchObject({ legs: 0 });
  });

  it("reads the Zoom out's decision params into the policy's shapes, USDC amounts included", () => {
    const p = portfolioParamsFromDecision({
      positions: [
        {
          token: WMON,
          targetWeightBps: 2_000,
          bandBps: 300,
          thesisId: "T",
          exit: { killCriterion: "k", recheckAt: "2026-11-01" },
        },
      ],
      cashTargetBps: 8_000,
      minTradeUsdc: "1.5",
      volatilityBrakeBps: 20_000,
      costHurdleBps: 40,
      maxLegBps: 900,
    });
    expect(p.minTradeUsdcE6).toBe(1_500_000n);
    expect(p.positions[0]?.exit).toEqual({ killCriterion: "k", recheckAt: "2026-11-01" });
    expect(
      bandsParamsFromDecision({
        targetWmonBps: 2_500,
        bandHalfWidthBps: 500,
        minTradeUsdc: "2",
        volatilityBrakeBps: 20_000,
        costHurdleBps: 40,
        maxLegBps: 900,
      }),
    ).toEqual({
      targetWmonBps: 2_500,
      bandHalfWidthBps: 500,
      minTradeUsdcE6: 2_000_000n,
      volatilityBrakeBps: 20_000,
      costHurdleBps: 40,
      maxLegBps: 900,
    });
  });
});

/**
 * F-U9 follow-up (D-291, A-77): the rule that decides whether a proposal
 * waits for the owner, on its own. The first plan after an arming began
 * always waits, whatever the goal says about plan changes; a plan set since
 * the arming began lets "apply and tell me" apply the next one at once.
 */
describe("the first plan after arming always needs approval (F-U9, D-291)", () => {
  const ref = { chainId: 143143, agentId: 7 };
  const at = (iso: string) => new Date(iso);
  const service = (o: {
    goal: "ask_first" | "apply" | null;
    arming: Date | null;
    plan: Date | null;
  }) =>
    new ProposalService({
      db: {} as never,
      cycles: {} as never,
      goals: {
        currentGoal: async () =>
          o.goal === null
            ? null
            : {
                config: {
                  planChanges: {
                    mode: o.goal === "ask_first" ? "ASK_FIRST" : "APPLY_AND_TELL",
                    workflowMode: o.goal === "ask_first" ? "require_approval" : "notify",
                  },
                },
              },
      } as never,
      plans: {
        active: async () => (o.plan ? { createdAt: o.plan } : null),
      } as never,
      trades: {
        openArming: async () => (o.arming ? { createdAt: o.arming } : null),
      } as never,
      narrator: null,
      inputs: async () => null,
      log: () => undefined,
    });

  it("waits when the goal says ask first, armed or not, plan or no plan", async () => {
    expect(await service({ goal: "ask_first", arming: null, plan: null }).approvalNeeded(ref)).toBe(
      "ask_first",
    );
    expect(
      await service({
        goal: "ask_first",
        arming: at("2026-10-10T10:00:00Z"),
        plan: at("2026-10-10T11:00:00Z"),
      }).approvalNeeded(ref),
    ).toBe("ask_first");
  });

  it("waits for the first plan after the arming began, even under apply and tell me", async () => {
    const arming = at("2026-10-10T10:00:00Z");
    expect(await service({ goal: "apply", arming, plan: null }).approvalNeeded(ref)).toBe(
      "first_plan_after_arming",
    );
    // A plan from before this arming does not count: the owner approves the first one under it.
    expect(
      await service({ goal: "apply", arming, plan: at("2026-10-09T09:00:00Z") }).approvalNeeded(
        ref,
      ),
    ).toBe("first_plan_after_arming");
  });

  it("applies at once under apply and tell me once a plan has been set since the arming began", async () => {
    expect(
      await service({
        goal: "apply",
        arming: at("2026-10-10T10:00:00Z"),
        plan: at("2026-10-10T12:00:00Z"),
      }).approvalNeeded(ref),
    ).toBeNull();
  });

  it("applies at once under apply and tell me while the agent is not armed, and waits with no goal", async () => {
    expect(
      await service({ goal: "apply", arming: null, plan: null }).approvalNeeded(ref),
    ).toBeNull();
    expect(await service({ goal: null, arming: null, plan: null }).approvalNeeded(ref)).toBe(
      "ask_first",
    );
  });
});
