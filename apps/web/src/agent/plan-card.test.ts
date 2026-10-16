import { describe, expect, it } from "vitest";
import type { PlanCardJson, ProposalJson } from "@/api/client";
import { allocationText, latestDecided, planCardView, planKept } from "./plan-card";

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
