import { describe, expect, it } from "vitest";
import {
  checkTargetPortfolio,
  inputsFingerprint,
  stateChangedFinding,
  whatChanged,
} from "./plan-rules.ts";
import { TARGET_PORTFOLIO_ID } from "@alpha-agents/policy";
import {
  fixtureDecisionParams,
  fixtureInputs,
  fixturePlan,
  loadPlanFixture,
} from "./plan-rules.fixture.ts";
import { ProposalService } from "./proposals.ts";
import { CycleResearch } from "./research.ts";

/**
 * One rule set for plans (F-T2): the shared fixture's cases through the rule
 * set itself; the Test stage's and the evaluator's sides run the same cases
 * in their own tests. And the fingerprint: what the rules read, and what
 * changed between two reads, named.
 */
describe("the plan rules on the shared fixture", () => {
  const f = loadPlanFixture();
  for (const c of f.cases)
    it(c.name, async () => {
      const verdict = await checkTargetPortfolio(fixturePlan(c, f), fixtureInputs(f));
      expect(verdict.findings.map((x) => x.code)).toEqual(c.expect);
      expect(verdict.fingerprint.block).toBe(f.block);
      if (c.positions.length > 0) expect(verdict.cost?.legs).toBeGreaterThan(0);
    });
});

describe("both sides give the fixture's codes: the Test stage's verdict and the proposal evaluator", () => {
  const f = loadPlanFixture();
  const inputs = () => fixtureInputs(f);
  const stage = new CycleResearch({
    cycles: {} as never,
    goals: {} as never,
    plans: {} as never,
    skillRuns: () => new Set(),
    portfolio: { inputs: async () => inputs() },
  });
  const evaluator = new ProposalService({
    db: {} as never,
    cycles: {} as never,
    goals: {
      currentGoal: async () => ({
        config: { planChanges: { mode: "ASK_FIRST", workflowMode: "require_approval" } },
      }),
    } as never,
    plans: { active: async () => null } as never,
    trades: { openArming: async () => null } as never,
    narrator: null,
    inputs: async () => inputs(),
    log: () => undefined,
  });
  for (const c of f.cases)
    it(c.name, async () => {
      const onStage = await stage.targetPortfolioVerdict(fixtureDecisionParams(c, f), inputs());
      expect(onStage.findings.map((x) => x.code)).toEqual(c.expect);
      const byEvaluator = await evaluator.evaluate(
        { chainId: f.chainId, agentId: 7 },
        { template: TARGET_PORTFOLIO_ID, params: fixturePlan(c, f) },
        { tested: onStage.fingerprint },
      );
      // The same codes, and nothing changed since the stage read, so no STATE_CHANGED beside them.
      expect(byEvaluator.findings.map((x) => x.code).filter((x) => x !== "STATE_CHANGED")).toEqual(
        c.expect,
      );
      if (c.expect.length > 0)
        expect(byEvaluator.findings.at(-1)?.message).toMatch(/^Nothing the Test read has changed/);
      expect(byEvaluator.passed).toBe(c.expect.length === 0);
      expect(byEvaluator.cost).toEqual(onStage.cost);
    });

  it("names what changed when the evaluator refuses a plan the stage accepted", async () => {
    const c = f.cases[0] as (typeof f.cases)[number];
    const onStage = await stage.targetPortfolioVerdict(fixtureDecisionParams(c, f), inputs());
    expect(onStage.findings).toEqual([]);
    // Between the two reads the owner opted out of the screened lane; the plan's screened position now fails.
    const later = new ProposalService({
      db: {} as never,
      cycles: {} as never,
      goals: {
        currentGoal: async () => ({
          config: { planChanges: { mode: "ASK_FIRST", workflowMode: "require_approval" } },
        }),
      } as never,
      plans: { active: async () => null } as never,
      trades: { openArming: async () => null } as never,
      narrator: null,
      inputs: async () => {
        const i = inputs();
        return { ...i, agent: { ...i.agent, screenedOptIn: false } };
      },
      log: () => undefined,
    });
    const refused = await later.evaluate(
      { chainId: f.chainId, agentId: 7 },
      { template: TARGET_PORTFOLIO_ID, params: fixturePlan(c, f) },
      { tested: onStage.fingerprint },
    );
    expect(refused.findings.map((x) => x.code)).toEqual(["NOT_OPTED_IN", "STATE_CHANGED"]);
    expect(refused.findings.at(-1)?.message).toBe(
      "Since the Test accepted this plan: the owner opted out of the screened lane on chain.",
    );
  });
});

describe("the fingerprint of what the rules read", () => {
  it("is the same for the same read, and names each change between two reads", () => {
    const f = loadPlanFixture();
    const a = fixtureInputs(f);
    const before = inputsFingerprint(a);
    expect(inputsFingerprint(fixtureInputs(f))).toEqual(before);
    expect(whatChanged(before, before)).toEqual([]);
    const wmon = f.wmon.toLowerCase();
    const after = inputsFingerprint({
      ...a,
      agent: {
        ...a.agent,
        mode: "REDUCE_ONLY",
        screenedOptIn: false,
        holdings: [
          ...a.agent.holdings,
          {
            token: f.wmon,
            decimals: 18,
            balance: 10n ** 18n,
            free: 10n ** 18n,
            costBasis: 25_000n,
            lastPriceE18: 25n * 10n ** 15n,
            lastPricedAt: a.agent.timestamp,
          },
        ],
      },
      market: {
        ...a.market,
        block: a.market.block + 1n,
        prices: {
          ...a.market.prices,
          [wmon]: { priceE18: 30n * 10n ** 15n, updatedAt: a.market.timestamp, reason: "OK" },
        },
        tokens: a.market.tokens.map((t) =>
          t.symbol === "SCRN" ? { ...t, status: "SELL_ONLY" as const } : t,
        ),
      },
    });
    const symbols = Object.fromEntries(f.tokens.map((t) => [t.token.toLowerCase(), t.symbol]));
    expect(whatChanged(before, after, symbols)).toEqual([
      "the account's mode changed from NORMAL to REDUCE_ONLY",
      "the owner opted out of the screened lane on chain",
      "the account's WMON balance changed from 0 to 1000000000000000000 (basis 0 to 25000)",
      "WMON's price moved from 25000000000000000 (OK) to 30000000000000000 (OK)",
      "SCRN in the registry changed from SCREENED BUYABLE class A cap 1500 to SCREENED SELL_ONLY class A cap 1500",
    ]);
    // A block alone: only the quotes may differ.
    const moved = inputsFingerprint({ ...a, market: { ...a.market, block: a.market.block + 3n } });
    expect(whatChanged(before, moved)).toEqual([
      "the chain moved from block 500 to 503, so the venues' quotes may differ",
    ]);
    expect(stateChangedFinding(before, moved).message).toMatch(
      /^Since the Test accepted this plan: the chain moved/,
    );
    expect(stateChangedFinding(before, before).message).toMatch(
      /^Nothing the Test read has changed/,
    );
  });
});
