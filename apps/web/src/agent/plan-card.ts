import type { PlanCardView } from "@alpha-agents/ui";
import type { PlanCardJson, ProposalJson } from "@/api/client";

/**
 * The plan card's view from the API's plan card (F-U9): the proposal against
 * the plan in force, with the positions the plan holds that the proposal
 * leaves, and the cash target both ways. Every figure comes from the API.
 */
export function planCardView(card: PlanCardJson, p: ProposalJson): PlanCardView {
  const proposed = new Set(p.positions.map((x) => x.token.toLowerCase()));
  const leaving = (card.current?.positions ?? [])
    .filter((c) => !proposed.has(c.token.toLowerCase()))
    .map((c) => ({ symbol: c.symbol, currentWeightBps: c.targetWeightBps }));
  return {
    proposalId: p.proposalId,
    status: p.status,
    needsApproval: p.needsApproval,
    cashTargetBps: p.plan?.cashTargetBps ?? null,
    currentCashBps: card.current?.cashTargetBps ?? null,
    positions: p.positions,
    leaving,
    portfolioView: p.rationale.portfolioView,
    evidenceStrength: p.rationale.evidenceStrength,
    whatWouldChangeIt: p.rationale.whatWouldChangeIt,
    evaluation: p.evaluation
      ? {
          passed: p.evaluation.passed,
          checkedAt: p.evaluation.checkedAt,
          findings: p.evaluation.findings,
          cost: p.evaluation.cost,
        }
      : null,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    decidedAt: p.decidedAt,
  };
}

/** The proposal the card shows when none waits: the latest decided one, if it is newer than the last no-change. */
export function latestDecided(card: PlanCardJson): ProposalJson | null {
  const recent = card.recent[0] ?? null;
  if (!recent) return null;
  if (card.noChange && card.noChange.createdAt > recent.createdAt) return null;
  return recent;
}
