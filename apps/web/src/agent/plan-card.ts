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
    allocationNote: p.rationale.allocationNote ?? null,
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

const pct = (bps: number) =>
  `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;

/** "20% WMON, 80% USDC": the plan in force, its tokens by weight and the rest in USDC. */
export function allocationText(current: PlanCardJson["current"]): string | null {
  if (!current) return null;
  if (current.positions.length === 0 && current.targetWmonBps !== null)
    return `${pct(current.targetWmonBps)} WMON, ${pct(10_000 - current.targetWmonBps)} USDC`;
  const parts = [...current.positions]
    .sort((a, b) => b.targetWeightBps - a.targetWeightBps)
    .map((p) => `${pct(p.targetWeightBps)} ${p.symbol}`);
  const cash =
    current.cashTargetBps ?? 10_000 - current.positions.reduce((t, p) => t + p.targetWeightBps, 0);
  if (cash > 0) parts.push(`${pct(cash)} USDC`);
  return parts.length > 0 ? parts.join(", ") : null;
}

export interface PlanKept {
  readonly date: string;
  readonly allocation: string | null;
  readonly reason: string | null;
  readonly cycleId: string | null;
  readonly at: string;
}

/**
 * 2026-10-15: the newest research run kept the plan: its no-change is newer than every
 * proposal, and nothing waits for the owner. Null otherwise.
 */
export function planKept(card: PlanCardJson | null): PlanKept | null {
  const kept = card?.noChange ?? null;
  if (!card || !kept || card.pending) return null;
  const newest = card.recent[0] ?? null;
  if (newest && newest.createdAt >= kept.createdAt) return null;
  return {
    date: kept.createdAt.slice(0, 10),
    allocation: allocationText(card.current),
    reason: kept.rationale.portfolioView || null,
    cycleId: kept.cycleId,
    at: kept.createdAt,
  };
}
