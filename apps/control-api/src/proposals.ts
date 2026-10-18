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
  isSuperseded,
  planCard as tradingPlanCard,
  proposalFacts,
  templateProposalEntry,
} from "@alpha-agents/trading";

// 2026-10-17: the card's JSON and the card itself live in @alpha-agents/trading, so the
// orchestrator's research read and this API read a run's plan outcome with one function.
export { currentPlanJson, proposalJson, type ProposalJson } from "@alpha-agents/trading";
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

/**
 * 2026-10-16: the symbols the agent's own proposals recorded for the given tokens, for the ones
 * the token table does not list (a testnet's stand-ins, TALPHA and TBETA), so a card names
 * every token by its symbol, never its address.
 */
export async function proposalSymbols(
  db: Db | null,
  chainId: number,
  agentId: number,
  tokens: readonly string[],
): Promise<Record<string, string>> {
  const wanted = new Set(tokens.map((t) => t.toLowerCase()));
  if (!db || wanted.size === 0) return {};
  const rows = await db
    .selectFrom("platform.plan_proposals")
    .select(["positions"])
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .orderBy("created_at", "desc")
    .limit(20)
    .execute();
  const out: Record<string, string> = {};
  for (const r of rows)
    for (const p of (r.positions as { token?: string; symbol?: string }[] | null) ?? []) {
      const token = p.token?.toLowerCase();
      if (token && wanted.has(token) && p.symbol && !p.symbol.startsWith("0x"))
        out[token] ??= p.symbol;
    }
  return out;
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
  /** F-U10: the activation sweeps. */
  readonly activations: ActivationStore;
  readonly recheck: ProposalDeps["recheck"];
  readonly now: () => Date;
}

/**
 * The proposal, if it is the owner's to decide now: waiting, unexpired, made for this owner,
 * and not replaced by a plan set after it. 2026-10-17: whatever the strategy epoch: a goal saved
 * since no longer voids it (the plan card offers it), since approving re-checks it against the
 * goal in force; a plan set since marks it superseded, and a sale (the owner's epoch) ends it.
 */
async function waiting(
  s: ProposalStores,
  chainId: number,
  agentId: number,
  proposalId: string,
  owner: { readonly wallet: Hex; readonly epoch: bigint },
): Promise<StoredProposal | ProposalRefusal> {
  const now = s.now();
  await s.proposals.expireDue(chainId, agentId, now);
  const plan = await s.plans.active(chainId, agentId);
  if (plan) await s.proposals.supersedePending(chainId, agentId, { before: plan.createdAt, now });
  const p = await s.proposals.get(chainId, agentId, proposalId);
  if (!p) return { ok: false, code: "NOT_FOUND", message: "No such proposal." };
  if (p.status !== "pending_owner")
    return {
      ok: false,
      code: "NOT_WAITING",
      message: isSuperseded(p)
        ? "A newer plan replaced this proposal; the plan card shows the one in force or waiting."
        : `This proposal is ${p.status.replace("_", " ")}; only one waiting for you can be decided.`,
    };
  if (p.ownerEpoch !== owner.epoch)
    return {
      ok: false,
      code: "STALE",
      message:
        "This proposal was made for an earlier owner; the agent's next research run makes a fresh one.",
    };
  return p;
}

/**
 * Approve: the evaluator runs again (the Test stage v2 on the fund agent's
 * set for a portfolio, the goal's limits for the two-asset plan); a draft
 * that fails now is stored as rejected with every finding; one that passes
 * becomes the plan the runner follows, set by the owner. 2026-10-18 (owner,
 * replacing D-291's sweep-only rule): approving any plan arms the agent, so
 * the plan's legs start without a second approval: an arming registered and
 * waiting for its first trade moves to armed, and `armed` says so.
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
  // 2026-10-17: the plan set replaces any other proposal still waiting.
  await s.proposals.supersedePending(chainId, agentId, { except: proposalId, now: s.now() });
  const open = await s.trades.openArming(chainId, agentId);
  const armed =
    open?.status === "awaiting_first_trade"
      ? (await s.trades.markArmedByPlan(open.armingId)) !== null
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

/** Everything the plan card shows (the card itself lives in @alpha-agents/trading). */
export async function planCard(
  s: ProposalStores,
  chainId: number,
  agentId: number,
  symbols: Readonly<Record<string, string>>,
  o: { readonly ownerEpoch?: bigint } = {},
) {
  return tradingPlanCard(s, chainId, agentId, symbols, o);
}
