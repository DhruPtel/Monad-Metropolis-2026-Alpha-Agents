import { describe, expect, it } from "vitest";
import type { PlanCardJson, ProposalJson } from "@/api/client";
import {
  allocationText,
  latestDecided,
  latestRunNote,
  noPlanLine,
  planCardView,
  planKept,
  refusedDraft,
  runFinish,
  shownProposal,
} from "./plan-card";

const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c";
const proposal = (over: Partial<ProposalJson> = {}): ProposalJson => ({
  proposalId: "prop-00000000-0000-4000-8000-000000000001",
  kind: "proposal",
  status: "pending_owner",
  needsApproval: true,
  strategyEpoch: "1",
  ownerEpoch: "2",
  cycleId: "cycle-1",
  template: "target_portfolio@1",
  plan: {
    cashTargetBps: 6_000,
    minTradeUsdcE6: "500000",
    volatilityBrakeBps: 20_000,
    costHurdleBps: 40,
    maxLegBps: 1_000,
  },
  positions: [
    {
      token: WBTC,
      symbol: "WBTC",
      targetWeightBps: 2_000,
      bandBps: 300,
      currentWeightBps: null,
      action: "ADD",
      thesisCode: "WBTC_ADD",
      thesis: "WBTC tracks bitcoin while its pool stays deep.",
      killCriterion: "The pool halves.",
      recheckAt: "2026-11-01",
      trimAboveBps: 3_000,
      confidence: "medium",
      sources: { onchain: 2, market: 1, primary: 0, news: 1, social: 0 },
      verdict: "WEAKENED",
      reason: "A deep pool and a standing thesis.",
    },
  ],
  rationale: {
    decision: "PROPOSE",
    reasonCode: null,
    portfolioView: "One position plus cash fits a Balanced goal.",
    evidenceStrength: "mixed",
    whatWouldChangeIt: "The pool thinning out.",
    themeCodes: ["WBTC_ADD"],
  },
  evaluation: {
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
    approval: "ask_first",
  },
  reasonCode: null,
  explanation: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: "2026-10-10T12:00:00.000Z",
  expiresAt: "2026-10-11T12:00:00.000Z",
  ...over,
});
const card = (over: Partial<PlanCardJson> = {}): PlanCardJson => ({
  strategyEpoch: "1",
  planChanges: "ASK_FIRST",
  current: {
    paramId: "plan-1",
    template: "target_portfolio@1",
    setBy: "owner",
    setAt: "2026-10-09T12:00:00.000Z",
    strategyEpoch: "1",
    positions: [
      {
        token: WMON.toUpperCase().replace("0X", "0x"),
        symbol: "WMON",
        targetWeightBps: 2_000,
        bandBps: 300,
      },
    ],
    cashTargetBps: 8_000,
    targetWmonBps: null,
  },
  pending: proposal(),
  recent: [],
  noChange: null,
  ...over,
});

describe("the plan card's view (F-U9)", () => {
  it("sets the proposal against the plan in force: new positions, the ones it leaves, cash both ways", () => {
    const v = planCardView(card(), proposal());
    expect(v).toMatchObject({
      status: "pending_owner",
      cashTargetBps: 6_000,
      currentCashBps: 8_000,
      leaving: [{ symbol: "WMON", currentWeightBps: 2_000 }],
      evidenceStrength: "mixed",
      evaluation: { passed: true, cost: { legs: 2 } },
    });
    expect(v.positions[0]?.symbol).toBe("WBTC");
    // No plan in force: nothing is left, and the cash now is unknown.
    expect(planCardView(card({ current: null }), proposal())).toMatchObject({
      leaving: [],
      currentCashBps: null,
    });
  });

  it("shows the latest decided proposal only when no newer no-change decision exists", () => {
    const rejected = proposal({ status: "rejected", createdAt: "2026-10-10T10:00:00.000Z" });
    const noChange = proposal({
      kind: "no_change",
      status: "recorded",
      reasonCode: "EVIDENCE_THIN",
      createdAt: "2026-10-10T11:00:00.000Z",
    });
    expect(latestDecided(card({ pending: null, recent: [rejected], noChange: null }))).toBe(
      rejected,
    );
    expect(latestDecided(card({ pending: null, recent: [rejected], noChange }))).toBeNull();
    expect(
      latestDecided(
        card({
          pending: null,
          recent: [rejected],
          noChange: { ...noChange, createdAt: "2026-10-10T09:00:00.000Z" },
        }),
      ),
    ).toBe(rejected);
    expect(latestDecided(card({ pending: null, recent: [] }))).toBeNull();
  });

  it("says a run kept the plan when its no-change is the newest decision and nothing waits (2026-10-15)", () => {
    const applied = proposal({ status: "applied", createdAt: "2026-10-14T10:00:00.000Z" });
    const noChange = proposal({
      kind: "no_change",
      status: "recorded",
      reasonCode: "NO_MATERIAL_CHANGE",
      cycleId: "cycle-9",
      createdAt: "2026-10-15T08:00:00.000Z",
    });
    expect(planKept(card({ pending: null, recent: [applied], noChange }))).toMatchObject({
      date: "2026-10-15",
      allocation: "20% WMON, 80% USDC",
      cycleId: "cycle-9",
    });
    // A plan waiting, a newer proposal, or no no-change: nothing to say.
    expect(planKept(card({ recent: [applied], noChange }))).toBeNull();
    expect(
      planKept(
        card({
          pending: null,
          recent: [{ ...applied, createdAt: "2026-10-15T09:00:00.000Z" }],
          noChange,
        }),
      ),
    ).toBeNull();
    expect(planKept(card({ pending: null, noChange: null }))).toBeNull();
    expect(planKept(null)).toBeNull();
  });

  it("writes the plan in force as shares, largest first, the rest in USDC", () => {
    const current = card().current;
    expect(allocationText(current)).toBe("20% WMON, 80% USDC");
    expect(
      allocationText(
        current && {
          ...current,
          positions: [
            { token: "0x1", symbol: "TALPHA", targetWeightBps: 1_500, bandBps: 300 },
            { token: "0x2", symbol: "WMON", targetWeightBps: 1_500, bandBps: 300 },
            { token: "0x3", symbol: "TBETA", targetWeightBps: 3_000, bandBps: 300 },
          ],
          cashTargetBps: 4_000,
        },
      ),
    ).toBe("30% TBETA, 15% TALPHA, 15% WMON, 40% USDC");
    expect(
      allocationText(
        current && {
          ...current,
          template: "rebalance_bands@1",
          positions: [],
          cashTargetBps: null,
          targetWmonBps: 2_500,
        },
      ),
    ).toBe("25% WMON, 75% USDC");
    expect(allocationText(null)).toBeNull();
  });
});

describe("the plan card and the finish strip agree (2026-10-17)", () => {
  const run = (
    outcome: NonNullable<PlanCardJson["latestRun"]>["outcome"],
  ): NonNullable<PlanCardJson["latestRun"]> => ({
    cycleId: "cycle-2",
    kind: "ACTIVATION",
    status: "completed",
    stopReason: "COMPLETED",
    createdAt: "2026-10-17T19:17:40.000Z",
    finishedAt: "2026-10-17T19:24:55.000Z",
    outcome,
  });
  const refused = {
    kind: "refused" as const,
    proposalId: null,
    appliedBy: null,
    reasonCode: "DEPTH",
    reason:
      "The platform's checks refused the 2 plans the agent drafted: a position is too large for its pools; then the plan step stopped: the step reached its cost ceiling.",
    findings: [{ code: "DEPTH", message: "a position is too large for its pools" }],
  };

  it("never shows a refused, declined or expired proposal as the plan in force", () => {
    const applied = proposal({ status: "applied", proposalId: "prop-applied" });
    const rejected = proposal({ status: "rejected", proposalId: "prop-rejected" });
    // The API names the proposal in force: it is shown, whatever the recent list holds.
    expect(
      shownProposal(card({ pending: null, inForce: applied, recent: [rejected, applied] })),
    ).toBe(applied);
    // A plan set without a proposal (or none in force): nothing from the recent list stands in.
    expect(shownProposal(card({ pending: null, inForce: null, recent: [rejected] }))).toBeNull();
    // An older API without inForce: the latest applied one only while a plan is in force.
    expect(shownProposal(card({ pending: null, recent: [rejected, applied] }))).toBe(applied);
    expect(shownProposal(card({ pending: null, current: null, recent: [rejected] }))).toBeNull();
    // A waiting proposal always comes first.
    expect(shownProposal(card({ inForce: applied }))?.status).toBe("pending_owner");
  });

  it("with no plan, the card says why from the newest run, the same reason the strip gives", () => {
    const c = card({ current: null, pending: null, inForce: null, latestRun: run(refused) });
    expect(noPlanLine(c)).toBe(
      "No plan yet: the research run of 2026-10-17 19:17 UTC made no plan: the platform's checks refused the 2 plans the agent drafted: a position is too large for its pools; then the plan step stopped: the step reached its cost ceiling.",
    );
    const f = runFinish(refused, c);
    expect(f?.button).toBeNull();
    expect(f?.line).toContain("the platform's checks refused the 2 plans");
    // Before any run.
    expect(noPlanLine(card({ current: null, pending: null }))).toBe(
      "No plan yet: the activation sweep makes the first one.",
    );
    // A run going now.
    expect(
      noPlanLine(
        card({
          current: null,
          pending: null,
          latestRun: run({
            kind: "running",
            proposalId: null,
            appliedBy: null,
            reasonCode: null,
            reason: null,
            findings: [],
          }),
        }),
      ),
    ).toBe("No plan yet: a research run is going now; its plan shows here when it ends.");
  });

  it("with no plan, shows the newest run's refused draft read-only, never one from an older run (2026-10-17)", () => {
    const rejected = proposal({ status: "rejected", proposalId: "prop-refused" });
    const own = run({ ...refused, proposalId: "prop-refused" });
    expect(
      refusedDraft(
        card({ current: null, pending: null, inForce: null, recent: [rejected], latestRun: own }),
      ),
    ).toBe(rejected);
    // A run whose drafts left no proposal, or a plan waiting or in force: no refused draft.
    expect(
      refusedDraft(
        card({
          current: null,
          pending: null,
          inForce: null,
          recent: [rejected],
          latestRun: run(refused),
        }),
      ),
    ).toBeNull();
    expect(refusedDraft(card({ recent: [rejected], latestRun: own }))).toBeNull();
    expect(
      refusedDraft(
        card({
          pending: null,
          inForce: proposal({ status: "applied", proposalId: "prop-applied" }),
          recent: [rejected],
          latestRun: own,
        }),
      ),
    ).toBeNull();
  });

  it("under a plan in force, notes a newest run that made no plan; says nothing for one that did", () => {
    expect(latestRunNote(card({ pending: null, latestRun: run(refused) }))).toBe(
      "The research run of 2026-10-17 19:17 UTC made no plan: the platform's checks refused the 2 plans the agent drafted: a position is too large for its pools; then the plan step stopped: the step reached its cost ceiling.",
    );
    expect(
      latestRunNote(
        card({
          pending: null,
          latestRun: run({
            kind: "applied",
            proposalId: "prop-1",
            appliedBy: "agent",
            reasonCode: null,
            reason: null,
            findings: [],
          }),
        }),
      ),
    ).toBeNull();
  });

  it("Review plan only for the proposal the card shows waiting, also before the card loads", () => {
    const waiting = {
      kind: "awaiting_approval" as const,
      proposalId: "prop-00000000-0000-4000-8000-000000000001",
      appliedBy: null,
      reasonCode: null,
      reason: null,
      findings: [],
    };
    expect(runFinish(waiting, card())?.button).toBe("review_plan");
    expect(runFinish(waiting, null)?.button).toBe("review_plan");
    // The card shows another proposal waiting: this run's is no longer offered.
    const other = runFinish(waiting, card({ pending: proposal({ proposalId: "prop-newer" }) }));
    expect(other?.button).not.toBe("review_plan");
    expect(other?.otherWaiting).toBe(true);
    expect(runFinish(null, card())).toBeNull();
    // A card read before this run ended (its newest run is another one): the outcome decides,
    // so the strip never says the plan no longer waits while the card is being read again.
    const stale = card({
      pending: null,
      latestRun: run({
        kind: "running",
        proposalId: null,
        appliedBy: null,
        reasonCode: null,
        reason: null,
        findings: [],
      }),
    });
    expect(runFinish(waiting, stale, "cycle-2")?.button).toBe("review_plan");
    expect(runFinish(waiting, stale, "cycle-3")?.button).toBe("review_plan");
    // The card read after it ended, naming the run: the card decides.
    const fresh = card({ pending: null, latestRun: run(waiting) });
    expect(runFinish(waiting, fresh, "cycle-2")).toMatchObject({
      button: "view_current_plan",
      line: "Its plan no longer waits for you",
    });
  });
});
