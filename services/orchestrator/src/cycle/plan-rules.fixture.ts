import { readFileSync } from "node:fs";
import type { AgentStateV3, MarketStateV3, TokenInfoV3 } from "@alpha-agents/chain-tools";
import { type TargetPortfolioParams, amountForValue, executorV3 } from "@alpha-agents/policy";
import type { Hex } from "viem";
import type { TestInputsV2 } from "./test-stage.ts";

/**
 * The shared plan fixture (F-T2): the account and the market every side of
 * the rule set is checked against, and the cases with the codes each must
 * give. Loaded from plan-rules.fixture.json by the Test stage's, the
 * evaluator's and the rule set's own tests.
 */
interface FixtureToken {
  token: Hex;
  symbol: string;
  decimals: number;
  lane: "CORE" | "SCREENED";
  status: "BUYABLE" | "SELL_ONLY" | "FROZEN";
  priceClass: "USDC" | "F" | "A";
  maxPositionBps: number;
  priceE18: string;
}

export interface PlanFixtureCase {
  readonly name: string;
  readonly positions: readonly { token: Hex; targetWeightBps: number }[];
  readonly over?: Partial<{
    cashTargetBps: number;
    minTradeUsdc: string;
    volatilityBrakeBps: number;
    costHurdleBps: number;
    maxLegBps: number;
  }>;
  readonly expect: readonly string[];
}

interface PlanFixture {
  chainId: number;
  block: string;
  now: string;
  usdc: Hex;
  wmon: Hex;
  tokens: FixtureToken[];
  agent: {
    aggressiveness: "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";
    mode: "NORMAL" | "REDUCE_ONLY" | "PAUSED";
    screenedOptIn: boolean;
    holdings: { token: Hex; decimals: number; balance: string; costBasis: string }[];
  };
  quotes: { bpsUnderOracle: number };
  base: {
    cashTargetBps: number;
    minTradeUsdc: string;
    volatilityBrakeBps: number;
    costHurdleBps: number;
    maxLegBps: number;
  };
  cases: PlanFixtureCase[];
}

export function loadPlanFixture(): PlanFixture {
  return JSON.parse(
    readFileSync(new URL("./plan-rules.fixture.json", import.meta.url), "utf8"),
  ) as PlanFixture;
}

/** The fixture's market and account as the Test stage v2 reads them. */
export function fixtureInputs(f: PlanFixture = loadPlanFixture()): TestInputsV2 {
  const now = BigInt(Math.floor(Date.parse(f.now) / 1000));
  const tokens: TokenInfoV3[] = f.tokens.map((t) => ({
    token: t.token,
    symbol: t.symbol,
    decimals: t.decimals,
    lane: t.lane,
    status: t.status,
    priceClass: t.priceClass as never,
    maxPositionBps: t.maxPositionBps,
  }));
  const market: MarketStateV3 = {
    chainId: f.chainId,
    block: BigInt(f.block),
    timestamp: now,
    policy: { ...executorV3.LAUNCH_POLICY },
    policyHash: executorV3.LAUNCH_POLICY_HASH,
    paused: false,
    adapterAllowed: true,
    attestorSet: true,
    usdc: f.usdc,
    wmon: f.wmon,
    tokens,
    prices: Object.fromEntries(
      f.tokens.map((t) => [
        t.token.toLowerCase(),
        { priceE18: BigInt(t.priceE18), updatedAt: now, reason: "OK" as const },
      ]),
    ),
    pools: [],
  };
  const holdings = f.agent.holdings.map((h) => ({
    token: h.token,
    decimals: h.decimals,
    balance: BigInt(h.balance),
    free: BigInt(h.balance),
    costBasis: BigInt(h.costBasis),
    lastPriceE18: BigInt(f.tokens.find((t) => t.token === h.token)?.priceE18 ?? "0"),
    lastPricedAt: now,
  }));
  const nav = holdings.reduce((sum, h) => sum + h.costBasis, 0n);
  const agent: AgentStateV3 = {
    block: BigInt(f.block),
    timestamp: now,
    owner: "0x00000000000000000000000000000000000a11ce",
    ownerEpoch: 1n,
    configEpoch: 0n,
    account: "0x00000000000000000000000000000000000ac003",
    v2Account: null,
    mode: f.agent.mode,
    screenedOptIn: f.agent.screenedOptIn,
    holdings,
    values: { nav, capped: nav, totalBasis: nav, classABasis: 0n },
    breaker: { nav, perUnit: 10n ** 18n, peak: 10n ** 18n, drawdownBps: 0n },
    grant: null,
    trades: [],
    tradesLeft: 20,
    nextSlotFreesAt: 0n,
    turnoverUsed: 0n,
  };
  return {
    aggressiveness: f.agent.aggressiveness,
    market,
    agent,
    screenFresh: async () => true,
    // Every venue quote lands a fixed share under the oracle: the cost to move is that share.
    quoteBuy: async (t, usdcE6) => {
      const info = tokens.find((x) => x.token.toLowerCase() === t.toLowerCase());
      const px = market.prices[t.toLowerCase()]?.priceE18;
      if (!info || !px) return null;
      return (
        (amountForValue(usdcE6, px, info.decimals) * BigInt(10_000 - f.quotes.bpsUnderOracle)) /
        10_000n
      );
    },
    lastAgentChangeAt: null,
    now: new Date(f.now),
  };
}

/** A case's plan in the policy's shape, the stage's and the evaluator's alike. */
export function fixturePlan(
  c: PlanFixtureCase,
  f: PlanFixture = loadPlanFixture(),
): TargetPortfolioParams {
  const p = { ...f.base, ...(c.over ?? {}) };
  const [whole = "0", frac = ""] = p.minTradeUsdc.split(".");
  return {
    positions: c.positions.map((pos) => ({
      token: pos.token.toLowerCase() as Hex,
      targetWeightBps: pos.targetWeightBps,
      bandBps: 300,
      thesisId: `t-${pos.token.slice(-2)}`,
      exit: { killCriterion: "The thesis fails", recheckAt: "2026-11-01T00:00:00.000Z" },
    })),
    cashTargetBps: p.cashTargetBps,
    minTradeUsdcE6: BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6) || "0"),
    volatilityBrakeBps: p.volatilityBrakeBps,
    costHurdleBps: p.costHurdleBps,
    maxLegBps: p.maxLegBps,
  };
}

/** The same plan as the Zoom out's complete_stage decision carries it (minTradeUsdc as text). */
export function fixtureDecisionParams(c: PlanFixtureCase, f: PlanFixture = loadPlanFixture()) {
  const plan = fixturePlan(c, f);
  const p = { ...f.base, ...(c.over ?? {}) };
  return {
    positions: plan.positions,
    cashTargetBps: plan.cashTargetBps,
    minTradeUsdc: p.minTradeUsdc,
    volatilityBrakeBps: plan.volatilityBrakeBps,
    costHurdleBps: plan.costHurdleBps,
    maxLegBps: plan.maxLegBps,
  };
}
