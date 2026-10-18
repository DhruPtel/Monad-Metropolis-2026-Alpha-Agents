import {
  type FinishView,
  type PlanCardRefs,
  type RunPlanOutcome,
  finishView,
} from "@alpha-agents/domain";
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

/** 2026-10-17: what the plan card shows, reduced to what decides it. */
export function planCardRefs(card: PlanCardJson | null): PlanCardRefs {
  return {
    pendingId: card?.pending?.proposalId ?? null,
    inForceId: card?.inForce?.proposalId ?? null,
    planInForce: Boolean(card?.current),
  };
}

/**
 * 2026-10-17: the proposal the plan card shows: the one waiting for the owner, else the one that
 * set the plan in force. Never a refused, declined, expired or replaced proposal under "In force"
 * (before, the latest decided one stood in when nothing was applied in the last eight records).
 * An API from before 2026-10-17 sends no `inForce`: the latest applied one, while a plan is in force.
 */
export function shownProposal(card: PlanCardJson | null): ProposalJson | null {
  if (!card) return null;
  if (card.pending) return card.pending;
  if (card.inForce !== undefined) return card.inForce;
  return card.current ? (card.recent.find((p) => p.status === "applied") ?? null) : null;
}

/**
 * 2026-10-17 (owner): the newest run's plan the platform's checks refused, for the card to show
 * read-only with the reasons when no plan waits and none is in force. Null otherwise.
 */
export function refusedDraft(card: PlanCardJson | null): ProposalJson | null {
  if (!card || shownProposal(card)) return null;
  const o = card.latestRun?.outcome;
  if (o?.kind !== "refused" || !o.proposalId) return null;
  return card.recent.find((p) => p.proposalId === o.proposalId && p.status === "rejected") ?? null;
}

/**
 * The finish strip for a run, from what it did with the plan and what the plan card shows. Until
 * the card has loaded, or while it was read before this run ended (its newest run is another one,
 * or still going), from the run's outcome alone.
 */
export function runFinish(
  outcome: RunPlanOutcome | null | undefined,
  card: PlanCardJson | null,
  cycleId?: string,
): FinishView | null {
  if (!outcome) return null;
  const latest = card?.latestRun;
  const fresh =
    card !== null &&
    (cycleId === undefined ||
      latest === undefined ||
      (latest?.cycleId === cycleId && latest.outcome.kind !== "running"));
  const refs: PlanCardRefs =
    card && fresh
      ? planCardRefs(card)
      : {
          pendingId: outcome.kind === "awaiting_approval" ? outcome.proposalId : null,
          inForceId:
            outcome.kind === "applied" ? outcome.proposalId : (card?.inForce?.proposalId ?? null),
          planInForce: card
            ? outcome.kind === "applied" || Boolean(card.current)
            : outcome.kind === "applied" || outcome.kind === "kept",
        };
  return finishView(outcome, refs);
}

/** The finish strip's buttons, each leading to the plan card. */
export const FINISH_BUTTONS: Readonly<
  Record<FinishView["button"] & string, { readonly label: string; readonly testId: string }>
> = {
  review_plan: { label: "Review plan", testId: "review-plan" },
  view_plan: { label: "View plan", testId: "view-plan" },
  view_current_plan: { label: "View current plan", testId: "view-current-plan" },
};

const hhmm = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;

/**
 * 2026-10-17: the plan card's line when it shows no proposal: the plan in force set without
 * one, a run going now, or why the newest run made no plan, from that run's own outcome.
 */
export function noPlanLine(card: PlanCardJson | null): string {
  const run = card?.latestRun ?? null;
  const allocation = allocationText(card?.current ?? null);
  if (card?.current)
    return `In force since ${card.current.setAt.slice(0, 10)}${allocation ? `: ${allocation}` : ""}.`;
  if (!run) return "No plan yet: the activation sweep makes the first one.";
  if (run.outcome.kind === "running")
    return "No plan yet: a research run is going now; its plan shows here when it ends.";
  return `No plan yet: ${runSentence(run.createdAt, run.outcome)}`;
}

const NOT_APPLIED = new Set(["declined", "expired", "superseded"]);
const lowerFirst = (s: string) => `${s[0]?.toLowerCase() ?? ""}${s.slice(1)}`;

/** "the research run of 2026-10-17 19:17 UTC made no plan: the plan step stopped ..." */
function runSentence(createdAt: string, o: RunPlanOutcome): string {
  const reason = o.reason ? lowerFirst(o.reason) : "no reason was recorded.";
  return NOT_APPLIED.has(o.kind)
    ? `the plan from the research run of ${hhmm(createdAt)} UTC was not applied: ${reason}`
    : `the research run of ${hhmm(createdAt)} UTC made no plan: ${reason}`;
}

/**
 * 2026-10-17: under a plan the card does show, why the newest run left it as it is, when that
 * run made no plan of its own (refused, stopped, declined, expired or replaced); else null.
 */
export function latestRunNote(card: PlanCardJson | null): string | null {
  const run = card?.latestRun ?? null;
  if (!run || !card || (!card.pending && !card.current)) return null;
  const o = run.outcome;
  if (o.kind === "running")
    return "A research run is going now; a new plan from it shows here when it ends.";
  if (o.kind === "refused" || o.kind === "no_plan" || NOT_APPLIED.has(o.kind)) {
    const line = runSentence(run.createdAt, o);
    return `${line[0]?.toUpperCase() ?? ""}${line.slice(1)}`;
  }
  return null;
}
