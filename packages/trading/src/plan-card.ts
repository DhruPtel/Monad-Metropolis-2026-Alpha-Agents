import type { Db } from "@alpha-agents/db";
import { type RunPlanOutcome, type CheckedDraft, runPlanOutcome } from "@alpha-agents/domain";
import { TARGET_PORTFOLIO_ID } from "@alpha-agents/policy";
import type { GoalStore } from "./goals.ts";
import { type PlanStore, type StoredPlan, isPortfolioPlan } from "./plans.ts";
import { type ProposalStore, type StoredProposal } from "./proposals.ts";

/**
 * The plan card (F-U9; moved here from the control API on 2026-10-17 so the orchestrator's
 * research read and the API's plan card read a run's outcome with one function): the plan in
 * force and the proposal that set it, the proposal waiting for the owner, recent decisions, why
 * the plan did not change, and what the newest research run did with the plan.
 */
const bps = (n: number) => n;

export function proposalJson(p: StoredProposal) {
  return {
    proposalId: p.proposalId,
    kind: p.kind,
    status: p.status,
    needsApproval: p.needsApproval,
    strategyEpoch: p.strategyEpoch.toString(),
    ownerEpoch: p.ownerEpoch.toString(),
    cycleId: p.cycleId,
    template: p.plan?.template ?? null,
    plan:
      p.plan && p.plan.template === TARGET_PORTFOLIO_ID
        ? {
            cashTargetBps: bps(p.plan.params.cashTargetBps),
            minTradeUsdcE6: p.plan.params.minTradeUsdcE6.toString(),
            volatilityBrakeBps: p.plan.params.volatilityBrakeBps,
            costHurdleBps: p.plan.params.costHurdleBps,
            maxLegBps: p.plan.params.maxLegBps,
          }
        : p.plan
          ? {
              targetWmonBps: p.plan.params.targetWmonBps,
              bandHalfWidthBps: p.plan.params.bandHalfWidthBps,
              minTradeUsdcE6: p.plan.params.minTradeUsdcE6.toString(),
              volatilityBrakeBps: p.plan.params.volatilityBrakeBps,
              costHurdleBps: p.plan.params.costHurdleBps,
              maxLegBps: p.plan.params.maxLegBps,
            }
          : null,
    positions: p.positions,
    rationale: p.rationale,
    evaluation: p.evaluation,
    reasonCode: p.reasonCode,
    explanation: p.explanation,
    decidedBy: p.decidedBy,
    decidedAt: p.decidedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    expiresAt: p.expiresAt?.toISOString() ?? null,
  };
}

export type ProposalJson = ReturnType<typeof proposalJson>;

/** The plan in force as the card shows it beside a proposal. */
export function currentPlanJson(
  plan: StoredPlan | null,
  symbols: Readonly<Record<string, string>>,
) {
  if (!plan) return null;
  return {
    paramId: plan.paramId,
    template: plan.template,
    setBy: plan.setBy,
    setAt: plan.createdAt.toISOString(),
    strategyEpoch: plan.strategyEpoch.toString(),
    positions: isPortfolioPlan(plan)
      ? plan.params.positions.map((p) => ({
          token: p.token,
          symbol: symbols[p.token.toLowerCase()] ?? p.token,
          targetWeightBps: p.targetWeightBps,
          bandBps: p.bandBps,
        }))
      : [],
    cashTargetBps: isPortfolioPlan(plan) ? plan.params.cashTargetBps : null,
    targetWmonBps: isPortfolioPlan(plan) ? null : plan.params.targetWmonBps,
  };
}

/** A research run as the outcome reads it. */
export interface RunRef {
  readonly cycleId: string;
  readonly kind: string;
  readonly status: string;
  readonly stopReason: string | null;
}

/**
 * 2026-10-17: what each run did with the plan, from its stages (the Test's checked drafts among
 * them) and the proposal or no-change record it wrote. Two reads for any number of runs.
 */
export async function runOutcomes(
  db: Db,
  proposals: ProposalStore,
  chainId: number,
  agentId: number,
  runs: readonly RunRef[],
): Promise<Map<string, RunPlanOutcome>> {
  const out = new Map<string, RunPlanOutcome>();
  if (runs.length === 0) return out;
  const ids = runs.map((r) => r.cycleId);
  const [stageRows, byCycle] = await Promise.all([
    db
      .selectFrom("platform.stage_runs")
      .select(["cycle_id", "stage", "status", "stop_reason", "outcome"])
      .where("cycle_id", "in", ids)
      .orderBy("seq")
      .execute(),
    proposals.forCycles(chainId, agentId, ids),
  ]);
  for (const r of runs) {
    const p = byCycle.get(r.cycleId) ?? null;
    out.set(
      r.cycleId,
      runPlanOutcome({
        cycle: r,
        stages: stageRows
          .filter((s) => s.cycle_id === r.cycleId)
          .map((s) => ({
            stage: s.stage,
            status: s.status,
            stopReason: s.stop_reason,
            checked:
              s.stage === "TEST"
                ? (((s.outcome ?? {}) as { checked?: CheckedDraft[] }).checked ?? [])
                : null,
          })),
        proposal: p
          ? {
              proposalId: p.proposalId,
              kind: p.kind,
              status: p.status,
              reasonCode: p.reasonCode,
              decidedBy: p.decidedBy,
              findings: (p.evaluation?.findings ?? []).map((f) => ({
                code: f.code,
                message: f.message,
              })),
            }
          : null,
      }),
    );
  }
  return out;
}

/** The newest research run with what it did with the plan, or null before any. */
export async function latestRun(
  db: Db,
  proposals: ProposalStore,
  chainId: number,
  agentId: number,
) {
  const row = await db
    .selectFrom("platform.research_cycles")
    .select(["cycle_id", "kind", "status", "stop_reason", "created_at", "finished_at"])
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  if (!row) return null;
  const run = {
    cycleId: row.cycle_id,
    kind: row.kind,
    status: row.status,
    stopReason: row.stop_reason,
  };
  const outcome = (await runOutcomes(db, proposals, chainId, agentId, [run])).get(run.cycleId);
  return {
    cycleId: run.cycleId,
    kind: run.kind,
    status: run.status,
    stopReason: run.stopReason,
    createdAt: new Date(row.created_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    outcome: outcome as RunPlanOutcome,
  };
}

/** What the plan card reads. */
export interface PlanCardStores {
  readonly db: Db;
  readonly proposals: ProposalStore;
  readonly plans: PlanStore;
  readonly goals: GoalStore;
  readonly now: () => Date;
}

/**
 * Everything the plan card shows: the plan in force and the proposal that set it, the proposal
 * waiting for the owner, recent decisions, why no change, and the newest run's outcome.
 *
 * 2026-10-17: the proposal waiting is the newest one made for the current owner (`ownerEpoch`,
 * when the caller knows it), whatever the strategy epoch, unexpired and not replaced by a plan
 * set after it; one a newer plan replaced is marked superseded here and never offered.
 */
export async function planCard(
  s: PlanCardStores,
  chainId: number,
  agentId: number,
  symbols: Readonly<Record<string, string>>,
  o: { readonly ownerEpoch?: bigint } = {},
) {
  const now = s.now();
  await s.proposals.expireDue(chainId, agentId, now);
  const plan = await s.plans.active(chainId, agentId);
  // A plan set after a waiting proposal (by the owner or an operator) replaced it.
  if (plan) await s.proposals.supersedePending(chainId, agentId, { before: plan.createdAt, now });
  const [pending, recent, goal, epoch, inForce, latest] = await Promise.all([
    s.proposals.pending(
      chainId,
      agentId,
      o.ownerEpoch === undefined ? { now } : { now, ownerEpoch: o.ownerEpoch },
    ),
    s.proposals.list(chainId, agentId, 8),
    s.goals.currentGoal(chainId, agentId),
    s.goals.strategyEpoch(chainId, agentId),
    plan ? s.proposals.forPlan(chainId, agentId, plan.paramId) : Promise.resolve(null),
    latestRun(s.db, s.proposals, chainId, agentId),
  ]);
  const noChange = recent.find((p) => p.kind === "no_change") ?? null;
  return {
    strategyEpoch: epoch.toString(),
    planChanges: goal?.config.planChanges.mode ?? null,
    current: currentPlanJson(plan, symbols),
    pending: pending ? proposalJson(pending) : null,
    /** 2026-10-17: the proposal that set the plan in force; null when none did (or no plan). */
    inForce: inForce ? proposalJson(inForce) : null,
    recent: recent
      .filter((p) => p.kind === "proposal" && p.status !== "pending_owner")
      .slice(0, 5)
      .map(proposalJson),
    noChange: noChange ? proposalJson(noChange) : null,
    /** 2026-10-17: the newest research run and what it did with the plan. */
    latestRun: latest,
  };
}
