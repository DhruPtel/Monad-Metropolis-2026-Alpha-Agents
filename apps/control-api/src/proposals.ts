import { randomUUID } from "node:crypto";
import type { Db } from "@alpha-agents/db";
import { TARGET_PORTFOLIO_ID, type TargetPortfolioParams, checkPlan } from "@alpha-agents/policy";
import {
  type ActivationStore,
  type GoalStore,
  type PlanStore,
  type ProposalEvaluation,
  ProposalStore,
  type StoredPlan,
  type StoredProposal,
  type TradeStore,
  isPortfolioPlan,
  proposalFacts,
  templateProposalEntry,
} from "@alpha-agents/trading";
import type { Hex } from "viem";

/**
 * The plan card's routes (F-U9): what the owner reads (the plan in force,
 * the proposal waiting for them with every reason, the recent decisions and
 * why the plan did not change) and the two owner actions. An approval
 * re-runs the evaluator through the orchestrator's Test stage v2 before the
 * plan is set, so a proposal that went stale is rejected, never applied.
 */
export interface ProposalFinding {
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface ProposalDeps {
  /** The Test stage v2 on the fund agent's set, through the orchestrator; null answers "unavailable". */
  readonly recheck:
    | ((
        agentId: number,
        params: TargetPortfolioParams,
      ) => Promise<readonly ProposalFinding[] | null>)
    | null;
}

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

/** One template entry per event, under the proposal's key, so the owner's activity feed shows it. */
export async function writeProposalEntry(
  db: Db,
  p: StoredProposal,
  event: "approved" | "declined" | "rejected",
): Promise<void> {
  const facts = proposalFacts(`Alpha Agent #${p.agentId}`, p, event);
  await db
    .insertInto("platform.activity_entries")
    .values({
      entry_id: `act-${randomUUID()}`,
      chain_id: p.chainId,
      agent_id: p.agentId,
      task_id: `${p.proposalId}:${event}`,
      kind: "proposal",
      text: templateProposalEntry(facts),
      rendered_by: "template",
      facts: JSON.stringify(facts),
      rejections: "[]",
      model: null,
    })
    .onConflict((oc) => oc.doNothing())
    .execute()
    .catch(() => undefined);
}

export type ProposalRefusal =
  | { readonly ok: false; readonly code: "NOT_FOUND"; readonly message: string }
  | { readonly ok: false; readonly code: "NOT_WAITING"; readonly message: string }
  | { readonly ok: false; readonly code: "STALE"; readonly message: string }
  | { readonly ok: false; readonly code: "UNAVAILABLE"; readonly message: string }
  | {
      readonly ok: false;
      readonly code: "REJECTED";
      readonly message: string;
      readonly findings: readonly ProposalFinding[];
      readonly proposal: StoredProposal;
    };

export interface ProposalStores {
  readonly db: Db;
  readonly proposals: ProposalStore;
  readonly plans: PlanStore;
  readonly goals: GoalStore;
  readonly trades: TradeStore;
  /** F-U10: the activation sweeps, so approving a sweep's plan arms the agent (D-291). */
  readonly activations: ActivationStore;
  readonly recheck: ProposalDeps["recheck"];
  readonly now: () => Date;
}

/** The proposal, if it is the owner's to decide now: waiting, unexpired, and from the current epochs. */
async function waiting(
  s: ProposalStores,
  chainId: number,
  agentId: number,
  proposalId: string,
  owner: { readonly wallet: Hex; readonly epoch: bigint },
): Promise<StoredProposal | ProposalRefusal> {
  await s.proposals.expireDue(chainId, agentId, s.now());
  const p = await s.proposals.get(chainId, agentId, proposalId);
  if (!p) return { ok: false, code: "NOT_FOUND", message: "No such proposal." };
  if (p.status !== "pending_owner")
    return {
      ok: false,
      code: "NOT_WAITING",
      message: `This proposal is ${p.status.replace("_", " ")}; only one waiting for you can be decided.`,
    };
  const epoch = await s.goals.strategyEpoch(chainId, agentId);
  if (p.strategyEpoch !== epoch || p.ownerEpoch !== owner.epoch)
    return {
      ok: false,
      code: "STALE",
      message:
        "This proposal was made under an earlier goal or owner; the agent's next cycle makes a fresh one.",
    };
  return p;
}

/**
 * Approve: the evaluator runs again (the Test stage v2 on the fund agent's
 * set for a portfolio, the goal's limits for the two-asset plan); a draft
 * that fails now is stored as rejected with every finding; one that passes
 * becomes the plan the runner follows, set by the owner. When the proposal
 * is the activation sweep's, this approval is the one that arms the agent
 * (F-U10, D-291): the arming registered when trading was turned on moves
 * from waiting for its first trade to armed, and `armed` says so.
 */
export async function approveProposal(
  s: ProposalStores,
  chainId: number,
  agentId: number,
  proposalId: string,
  owner: { readonly wallet: Hex; readonly epoch: bigint },
): Promise<
  { ok: true; proposal: StoredProposal; plan: StoredPlan; armed: boolean } | ProposalRefusal
> {
  const p = await waiting(s, chainId, agentId, proposalId, owner);
  if ("ok" in p) return p;
  if (!p.plan)
    return { ok: false, code: "NOT_WAITING", message: "This record carries no plan to approve." };
  let findings: readonly ProposalFinding[];
  if (p.plan.template === TARGET_PORTFOLIO_ID) {
    if (!s.recheck)
      return {
        ok: false,
        code: "UNAVAILABLE",
        message: "The platform cannot check the proposal right now; try again in a moment.",
      };
    const checked = await s.recheck(agentId, p.plan.params).catch(() => null);
    if (checked === null)
      return {
        ok: false,
        code: "UNAVAILABLE",
        message: "The platform cannot check the proposal right now; try again in a moment.",
      };
    findings = checked;
  } else {
    const goal = await s.goals.currentGoal(chainId, agentId);
    findings = goal
      ? checkPlan(p.plan.params, goal.config).map((e) => ({
          code: "HARD_LIMIT",
          field: e.field,
          message: e.message,
        }))
      : [{ code: "HARD_LIMIT", field: "goal", message: "The agent has no goal." }];
  }
  const evaluation: ProposalEvaluation = {
    ...(p.evaluation ?? { cost: null, approval: "ask_first" }),
    checkedAt: s.now().toISOString(),
    passed: findings.length === 0,
    findings,
  };
  if (findings.length > 0) {
    const rejected =
      (await s.proposals.decide(chainId, agentId, proposalId, {
        status: "rejected",
        by: owner.wallet,
        evaluation,
        now: s.now(),
      })) ?? p;
    await writeProposalEntry(s.db, rejected, "rejected");
    return {
      ok: false,
      code: "REJECTED",
      message: `The proposal no longer passes the platform's checks and was not applied: ${findings.map((f) => f.code).join(", ")}.`,
      findings,
      proposal: rejected,
    };
  }
  const plan = await s.plans.set({
    chainId,
    agentId,
    setBy: "owner",
    setByAddress: owner.wallet,
    ...p.plan,
  });
  const applied =
    (await s.proposals.decide(chainId, agentId, proposalId, {
      status: "applied",
      by: owner.wallet,
      planParamId: plan.paramId,
      evaluation,
      now: s.now(),
    })) ?? p;
  await writeProposalEntry(s.db, applied, "approved");
  const activation = p.cycleId ? await s.activations.forCycle(p.cycleId) : null;
  const armed =
    activation?.armingId !== null && activation?.armingId !== undefined
      ? (await s.trades.markArmedByPlan(activation.armingId)) !== null
      : false;
  return { ok: true, proposal: applied, plan, armed };
}

export async function declineProposal(
  s: ProposalStores,
  chainId: number,
  agentId: number,
  proposalId: string,
  owner: { readonly wallet: Hex; readonly epoch: bigint },
): Promise<{ ok: true; proposal: StoredProposal } | ProposalRefusal> {
  const p = await waiting(s, chainId, agentId, proposalId, owner);
  if ("ok" in p) return p;
  const declined =
    (await s.proposals.decide(chainId, agentId, proposalId, {
      status: "declined",
      by: owner.wallet,
      now: s.now(),
    })) ?? p;
  await writeProposalEntry(s.db, declined, "declined");
  return { ok: true, proposal: declined };
}

/** Everything the plan card shows: the plan in force, the proposal waiting, recent decisions, why no change. */
export async function planCard(
  s: ProposalStores,
  chainId: number,
  agentId: number,
  symbols: Readonly<Record<string, string>>,
) {
  await s.proposals.expireDue(chainId, agentId, s.now());
  const [plan, pending, recent, goal, epoch] = await Promise.all([
    s.plans.active(chainId, agentId),
    s.proposals.pending(chainId, agentId),
    s.proposals.list(chainId, agentId, 8),
    s.goals.currentGoal(chainId, agentId),
    s.goals.strategyEpoch(chainId, agentId),
  ]);
  const noChange = recent.find((p) => p.kind === "no_change") ?? null;
  return {
    strategyEpoch: epoch.toString(),
    planChanges: goal?.config.planChanges.mode ?? null,
    current: currentPlanJson(plan, symbols),
    pending: pending ? proposalJson(pending) : null,
    recent: recent
      .filter((p) => p.kind === "proposal" && p.status !== "pending_owner")
      .slice(0, 5)
      .map(proposalJson),
    noChange: noChange ? proposalJson(noChange) : null,
  };
}
