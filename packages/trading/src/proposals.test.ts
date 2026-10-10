import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { DEFAULT_GOAL_INPUT } from "@alpha-agents/domain";
import {
  TARGET_PORTFOLIO_ID,
  type TargetPortfolioParams,
  translateGoal,
} from "@alpha-agents/policy";
import type { Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GoalStore } from "./goals.ts";
import { PlanStore } from "./plans.ts";
import { PROPOSAL_TTL_MS, type ProposalRationale, ProposalStore } from "./proposals.ts";

const dbUp = await databaseAvailable();
const CHAIN = 143143;
const ALICE = "0x00000000000000000000000000000000000a11ce" as Hex;
const WMON = "0x00000000000000000000000000000000000000c2" as Hex;
const WBTC = "0x00000000000000000000000000000000000000c3" as Hex;

const rationale: ProposalRationale = {
  decision: "PROPOSE",
  reasonCode: null,
  portfolioView: "A first portfolio of two large tokens against a Balanced goal.",
  evidenceStrength: "mixed",
  whatWouldChangeIt: "A pool thinning out.",
  themeCodes: ["WMON_ADD", "WBTC_ADD"],
  points: [],
};
const plan = (): { template: typeof TARGET_PORTFOLIO_ID; params: TargetPortfolioParams } => ({
  template: TARGET_PORTFOLIO_ID,
  params: {
    positions: [
      {
        token: WMON,
        targetWeightBps: 2_000,
        bandBps: 300,
        thesisId: "WMON_ADD",
        exit: { killCriterion: "MON loses its feed.", recheckAt: "2026-11-01" },
      },
      {
        token: WBTC,
        targetWeightBps: 2_000,
        bandBps: 300,
        thesisId: "WBTC_ADD",
        exit: { killCriterion: "The pool halves.", recheckAt: "2026-11-01", trimAboveBps: 3_000 },
      },
    ],
    cashTargetBps: 6_000,
    minTradeUsdcE6: 500_000n,
    volatilityBrakeBps: 20_000,
    costHurdleBps: 40,
    maxLegBps: 1_000,
  },
});
const evaluation = {
  checkedAt: "2026-10-10T12:00:00.000Z",
  passed: true,
  findings: [],
  cost: {
    legs: 2,
    turnoverUsdcE6: "40000000",
    estimatedCostUsdcE6: "80000",
    costBps: 20,
    basis: "test",
  },
  approval: "ask_first" as const,
};

describe.skipIf(!dbUp)("portfolio proposals (F-U9, needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let proposals: ProposalStore;
  let plans: PlanStore;
  beforeAll(async () => {
    t = await createTestDatabase("proposals");
    proposals = new ProposalStore(t.db);
    plans = new PlanStore(t.db);
    const r = translateGoal(structuredClone(DEFAULT_GOAL_INPUT));
    if (!r.ok) throw new Error("goal");
    await new GoalStore(t.db).save({
      chainId: CHAIN,
      agentId: 1,
      ownerEpoch: 1n,
      savedBy: ALICE,
      config: r.config,
    });
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.db.deleteFrom("platform.plan_proposals").execute();
  });

  it("stores a proposal with its plan, positions, rationale and evaluation, waiting for the owner for a day", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const p = await proposals.create({
      chainId: CHAIN,
      agentId: 1,
      cycleId: "cycle-1",
      stageRunId: "stage-1",
      strategyEpoch: 1n,
      ownerEpoch: 1n,
      plan: plan(),
      rationale,
      positions: [],
      evaluation,
      status: "pending_owner",
      needsApproval: true,
      now,
    });
    expect(p).toMatchObject({
      kind: "proposal",
      status: "pending_owner",
      needsApproval: true,
      strategyEpoch: 1n,
      ownerEpoch: 1n,
      plan: {
        template: TARGET_PORTFOLIO_ID,
        params: { cashTargetBps: 6_000, minTradeUsdcE6: 500_000n },
      },
      rationale: { evidenceStrength: "mixed" },
      evaluation: { passed: true, cost: { legs: 2 } },
    });
    expect(p.paramsHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(p.expiresAt?.getTime()).toBe(now.getTime() + PROPOSAL_TTL_MS);
    expect(await proposals.pending(CHAIN, 1)).toMatchObject({ proposalId: p.proposalId });
    expect((await proposals.list(CHAIN, 1)).map((x) => x.proposalId)).toEqual([p.proposalId]);
  });

  it("decides a waiting proposal once: applied with its plan, declined, or expired past its time", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const make = () =>
      proposals.create({
        chainId: CHAIN,
        agentId: 1,
        cycleId: null,
        stageRunId: null,
        strategyEpoch: 1n,
        ownerEpoch: 1n,
        plan: plan(),
        rationale,
        positions: [],
        evaluation,
        status: "pending_owner",
        needsApproval: true,
        now,
      });
    const a = await make();
    const set = await plans.set({
      chainId: CHAIN,
      agentId: 1,
      setBy: "owner",
      setByAddress: ALICE,
      ...plan(),
    });
    const applied = await proposals.decide(CHAIN, 1, a.proposalId, {
      status: "applied",
      by: ALICE,
      planParamId: set.paramId,
      now,
    });
    expect(applied).toMatchObject({
      status: "applied",
      decidedBy: ALICE,
      planParamId: set.paramId,
    });
    // A decided proposal is not decided again.
    expect(
      await proposals.decide(CHAIN, 1, a.proposalId, { status: "declined", by: ALICE }),
    ).toBeNull();
    const b = await make();
    expect(
      await proposals.decide(CHAIN, 1, b.proposalId, { status: "declined", by: ALICE }),
    ).toMatchObject({
      status: "declined",
    });
    const c = await make();
    expect(await proposals.expireDue(CHAIN, 1, new Date(now.getTime() + PROPOSAL_TTL_MS - 1))).toBe(
      0,
    );
    expect(await proposals.expireDue(CHAIN, 1, new Date(now.getTime() + PROPOSAL_TTL_MS))).toBe(1);
    expect((await proposals.get(CHAIN, 1, c.proposalId))?.status).toBe("expired");
    expect(await proposals.pending(CHAIN, 1)).toBeNull();
  });

  it("records a no-change decision with its reason and explanation", async () => {
    const n = await proposals.recordNoChange({
      chainId: CHAIN,
      agentId: 1,
      cycleId: "cycle-2",
      stageRunId: "stage-2",
      strategyEpoch: 1n,
      ownerEpoch: 1n,
      rationale: { ...rationale, decision: "NO_CHANGE", reasonCode: "EVIDENCE_THIN" },
      reasonCode: "EVIDENCE_THIN",
      explanation:
        "The only thesis was weakened. What would change it: onchain flows that confirm it.",
    });
    expect(n).toMatchObject({
      kind: "no_change",
      status: "recorded",
      reasonCode: "EVIDENCE_THIN",
      plan: null,
      evaluation: null,
    });
    expect(n.explanation).toContain("What would change it");
  });
});
