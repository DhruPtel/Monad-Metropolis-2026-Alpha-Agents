import { randomUUID } from "node:crypto";
import type { Db } from "@alpha-agents/db";
import {
  type RebalanceBandsParams,
  TARGET_PORTFOLIO_ID,
  type TargetPortfolioParams,
  portfolioParamsFromJson,
} from "@alpha-agents/policy";
import type { Hex } from "viem";
import { type PlanParams, paramsFromJson, planJsonAndHash } from "./plans.ts";

/**
 * Portfolio proposals (F-U9, P3-U6 revised): a Zoom out's draft, stored with
 * everything the owner reads on the plan card, tied to the strategy epoch and
 * the owner's epoch it was made under; and the Zoom out's "no change"
 * decisions with their reason. A proposal waits for the owner
 * (`pending_owner`), became the plan (`applied`, by the owner or
 * automatically), was refused by the evaluator (`rejected`, never offered),
 * was turned down by the owner (`declined`) or ran out of time (`expired`,
 * 24 hours). A no-change decision is `recorded`.
 */
export type ProposalStatus =
  "pending_owner" | "applied" | "rejected" | "declined" | "expired" | "recorded";

/** Where a claim's evidence came from, as the briefs tag it. */
export interface SourceCount {
  readonly onchain: number;
  readonly market: number;
  readonly primary: number;
  readonly news: number;
  readonly social: number;
}

/** One proposed position as the owner reads it: the weight, the thesis, the exit plan, the evidence. */
export interface ProposalPosition {
  readonly token: Hex;
  readonly symbol: string;
  readonly targetWeightBps: number;
  readonly bandBps: number;
  /** The weight the plan in force gives the token; null when it is new. */
  readonly currentWeightBps: number | null;
  readonly action: "ADD" | "HOLD" | "TRIM" | "EXIT";
  readonly thesisCode: string | null;
  readonly thesis: string | null;
  readonly killCriterion: string;
  readonly recheckAt: string;
  readonly trimAboveBps: number | null;
  readonly confidence: "high" | "medium" | "low" | null;
  readonly sources: SourceCount;
  readonly verdict: "STANDS" | "WEAKENED" | "REJECTED" | null;
  readonly reason: string;
}

export interface ProposalEvaluation {
  readonly checkedAt: string;
  readonly passed: boolean;
  readonly findings: readonly {
    readonly code: string;
    readonly field: string;
    readonly message: string;
  }[];
  /** The estimated cost to move to the proposal: legs, their value and the cost at today's depth. */
  readonly cost: {
    readonly legs: number;
    readonly turnoverUsdcE6: string;
    readonly estimatedCostUsdcE6: string;
    readonly costBps: number;
    readonly basis: string;
  } | null;
  /** Why the proposal needs the owner (the goal's setting, or the first plan after arming), or null. */
  readonly approval: "ask_first" | "first_plan_after_arming" | null;
}

export interface ProposalRationale {
  readonly decision: "NO_CHANGE" | "PROPOSE";
  readonly reasonCode: string | null;
  readonly portfolioView: string;
  readonly evidenceStrength: "strong" | "mixed" | "weak";
  readonly whatWouldChangeIt: string;
  readonly themeCodes: readonly string[];
  readonly points: readonly {
    readonly text: string;
    readonly class: string;
    readonly confidence: string;
  }[];
}

export interface StoredProposal {
  readonly proposalId: string;
  readonly chainId: number;
  readonly agentId: number;
  readonly cycleId: string | null;
  readonly stageRunId: string | null;
  readonly kind: "proposal" | "no_change";
  readonly strategyEpoch: bigint;
  readonly ownerEpoch: bigint;
  readonly plan: PlanParams | null;
  readonly paramsHash: Hex | null;
  readonly rationale: ProposalRationale;
  readonly positions: readonly ProposalPosition[];
  readonly evaluation: ProposalEvaluation | null;
  readonly status: ProposalStatus;
  readonly needsApproval: boolean;
  readonly reasonCode: string | null;
  readonly explanation: string | null;
  readonly decidedBy: Hex | null;
  readonly decidedAt: Date | null;
  readonly planParamId: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

/** How long a proposal waits for the owner before it expires (P3-U6). */
export const PROPOSAL_TTL_MS = 24 * 60 * 60_000;

interface Row {
  proposal_id: string;
  chain_id: number;
  agent_id: number;
  cycle_id: string | null;
  stage_run_id: string | null;
  kind: "proposal" | "no_change";
  strategy_epoch: string;
  owner_epoch: string;
  template: string | null;
  params: Record<string, unknown> | null;
  params_hash: string | null;
  rationale: Record<string, unknown>;
  positions: unknown[];
  evaluation: Record<string, unknown>;
  status: ProposalStatus;
  needs_approval: boolean;
  reason_code: string | null;
  explanation: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  plan_param_id: string | null;
  created_at: Date;
  expires_at: Date | null;
}

function planOf(r: Row): PlanParams | null {
  if (!r.template || !r.params) return null;
  return r.template === TARGET_PORTFOLIO_ID
    ? { template: TARGET_PORTFOLIO_ID, params: portfolioParamsFromJson(r.params) }
    : { template: "rebalance_bands@1", params: paramsFromJson(r.params) };
}

const stored = (r: Row): StoredProposal => ({
  proposalId: r.proposal_id,
  chainId: r.chain_id,
  agentId: r.agent_id,
  cycleId: r.cycle_id,
  stageRunId: r.stage_run_id,
  kind: r.kind,
  strategyEpoch: BigInt(r.strategy_epoch),
  ownerEpoch: BigInt(r.owner_epoch),
  plan: planOf(r),
  paramsHash: (r.params_hash as Hex | null) ?? null,
  rationale: r.rationale as unknown as ProposalRationale,
  positions: r.positions as ProposalPosition[],
  evaluation:
    Object.keys(r.evaluation).length > 0 ? (r.evaluation as unknown as ProposalEvaluation) : null,
  status: r.status,
  needsApproval: r.needs_approval,
  reasonCode: r.reason_code,
  explanation: r.explanation,
  decidedBy: (r.decided_by as Hex | null) ?? null,
  decidedAt: r.decided_at ? new Date(r.decided_at) : null,
  planParamId: r.plan_param_id,
  createdAt: new Date(r.created_at),
  expiresAt: r.expires_at ? new Date(r.expires_at) : null,
});

export interface NewProposal {
  readonly chainId: number;
  readonly agentId: number;
  readonly cycleId: string | null;
  readonly stageRunId: string | null;
  readonly strategyEpoch: bigint;
  readonly ownerEpoch: bigint;
  readonly plan:
    | { readonly template: typeof TARGET_PORTFOLIO_ID; readonly params: TargetPortfolioParams }
    | { readonly template: "rebalance_bands@1"; readonly params: RebalanceBandsParams };
  readonly rationale: ProposalRationale;
  readonly positions: readonly ProposalPosition[];
  readonly evaluation: ProposalEvaluation;
  /** The status the evaluator gave it: waiting for the owner, applied at once, or rejected. */
  readonly status: "pending_owner" | "applied" | "rejected";
  readonly needsApproval: boolean;
  readonly planParamId?: string | null;
  readonly now?: Date;
}

export interface NewNoChange {
  readonly chainId: number;
  readonly agentId: number;
  readonly cycleId: string | null;
  readonly stageRunId: string | null;
  readonly strategyEpoch: bigint;
  readonly ownerEpoch: bigint;
  readonly rationale: ProposalRationale;
  readonly reasonCode: string;
  readonly explanation: string;
  readonly now?: Date;
}

export class ProposalStore {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async create(p: NewProposal): Promise<StoredProposal> {
    const now = p.now ?? new Date();
    const { json, hash } = planJsonAndHash(p.plan as PlanParams);
    const id = `prop-${randomUUID()}`;
    await this.db
      .insertInto("platform.plan_proposals")
      .values({
        proposal_id: id,
        chain_id: p.chainId,
        agent_id: p.agentId,
        cycle_id: p.cycleId,
        stage_run_id: p.stageRunId,
        kind: "proposal",
        strategy_epoch: p.strategyEpoch.toString(),
        owner_epoch: p.ownerEpoch.toString(),
        template: p.plan.template,
        params: json,
        params_hash: hash,
        rationale: JSON.stringify(p.rationale),
        positions: JSON.stringify(p.positions),
        evaluation: JSON.stringify(p.evaluation),
        status: p.status,
        needs_approval: p.needsApproval,
        reason_code: null,
        explanation: null,
        decided_by: null,
        decided_at: p.status === "applied" ? now : null,
        plan_param_id: p.planParamId ?? null,
        created_at: now,
        expires_at: p.status === "pending_owner" ? new Date(now.getTime() + PROPOSAL_TTL_MS) : null,
      })
      .execute();
    return (await this.get(p.chainId, p.agentId, id)) as StoredProposal;
  }

  async recordNoChange(n: NewNoChange): Promise<StoredProposal> {
    const now = n.now ?? new Date();
    const id = `prop-${randomUUID()}`;
    await this.db
      .insertInto("platform.plan_proposals")
      .values({
        proposal_id: id,
        chain_id: n.chainId,
        agent_id: n.agentId,
        cycle_id: n.cycleId,
        stage_run_id: n.stageRunId,
        kind: "no_change",
        strategy_epoch: n.strategyEpoch.toString(),
        owner_epoch: n.ownerEpoch.toString(),
        template: null,
        params: null,
        params_hash: null,
        rationale: JSON.stringify(n.rationale),
        positions: "[]",
        evaluation: "{}",
        status: "recorded",
        needs_approval: false,
        reason_code: n.reasonCode,
        explanation: n.explanation,
        decided_by: null,
        decided_at: null,
        plan_param_id: null,
        created_at: now,
        expires_at: null,
      })
      .execute();
    return (await this.get(n.chainId, n.agentId, id)) as StoredProposal;
  }

  async get(chainId: number, agentId: number, proposalId: string): Promise<StoredProposal | null> {
    const row = await this.db
      .selectFrom("platform.plan_proposals")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("proposal_id", "=", proposalId)
      .executeTakeFirst();
    return row ? stored(row as unknown as Row) : null;
  }

  /** The agent's proposals and no-change decisions, newest first. */
  async list(chainId: number, agentId: number, limit = 10): Promise<StoredProposal[]> {
    const rows = await this.db
      .selectFrom("platform.plan_proposals")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => stored(r as unknown as Row));
  }

  /** The proposal waiting for the owner, if any (at most one is kept waiting). */
  async pending(chainId: number, agentId: number): Promise<StoredProposal | null> {
    const row = await this.db
      .selectFrom("platform.plan_proposals")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("status", "=", "pending_owner")
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    return row ? stored(row as unknown as Row) : null;
  }

  /** Expires every waiting proposal past its time; returns how many. */
  async expireDue(
    chainId: number,
    agentId: number | null = null,
    now = new Date(),
  ): Promise<number> {
    let q = this.db
      .updateTable("platform.plan_proposals")
      .set({ status: "expired", decided_at: now })
      .where("chain_id", "=", chainId)
      .where("status", "=", "pending_owner")
      .where("expires_at", "<=", now);
    if (agentId !== null) q = q.where("agent_id", "=", agentId);
    const r = await q.executeTakeFirst();
    return Number(r.numUpdatedRows ?? 0n);
  }

  /** Moves a waiting proposal to its decided state; false when it was not waiting. */
  async decide(
    chainId: number,
    agentId: number,
    proposalId: string,
    d: {
      readonly status: "applied" | "declined" | "rejected" | "expired";
      readonly by: Hex | null;
      readonly planParamId?: string | null;
      readonly evaluation?: ProposalEvaluation;
      readonly now?: Date;
    },
  ): Promise<StoredProposal | null> {
    const r = await this.db
      .updateTable("platform.plan_proposals")
      .set({
        status: d.status,
        decided_by: d.by,
        decided_at: d.now ?? new Date(),
        plan_param_id: d.planParamId ?? null,
        ...(d.evaluation ? { evaluation: JSON.stringify(d.evaluation) } : {}),
      })
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("proposal_id", "=", proposalId)
      .where("status", "=", "pending_owner")
      .executeTakeFirst();
    if (Number(r.numUpdatedRows ?? 0n) === 0) return null;
    return this.get(chainId, agentId, proposalId);
  }
}

/**
 * A proposal's activity entry (F-U9): the facts the narrator or the control
 * API writes it from, and the fixed template whose every number comes from
 * the facts, so it always passes the number validator.
 */
export interface ProposalFacts {
  readonly agent: string;
  readonly activity: "plan_proposal";
  readonly event: "proposed" | "applied" | "rejected" | "approved" | "declined" | "no_change";
  readonly positions: readonly {
    readonly asset: string;
    readonly action: "ADD" | "HOLD" | "TRIM" | "EXIT";
    readonly targetPercent: string;
  }[];
  readonly cashPercent: string | null;
  readonly evidenceStrength: "strong" | "mixed" | "weak";
  readonly reasonCode: string | null;
  readonly reasons: readonly { readonly code: string; readonly message: string }[];
  readonly needsApproval: boolean;
}

export const PROPOSAL_ENTRY_MAX_CHARS = 240;

export function proposalFacts(
  agent: string,
  p: StoredProposal,
  event: ProposalFacts["event"],
): ProposalFacts {
  return {
    agent,
    activity: "plan_proposal",
    event,
    positions: p.positions.map((x) => ({
      asset: x.symbol,
      action: x.action,
      targetPercent: (x.targetWeightBps / 100).toFixed(2),
    })),
    cashPercent:
      p.plan?.template === TARGET_PORTFOLIO_ID
        ? (p.plan.params.cashTargetBps / 100).toFixed(2)
        : null,
    evidenceStrength: p.rationale.evidenceStrength,
    reasonCode: p.reasonCode ?? p.evaluation?.findings[0]?.code ?? null,
    reasons: (p.evaluation?.findings ?? []).map((f) => ({ code: f.code, message: f.message })),
    needsApproval: p.needsApproval,
  };
}

/** The fixed template for a proposal entry: every number in it comes from the facts. */
export function templateProposalEntry(f: ProposalFacts): string {
  const set = f.positions
    .filter((p) => p.action !== "EXIT")
    .map((p) => `${p.asset} ${p.targetPercent}%`)
    .join(", ");
  const exits = f.positions.filter((p) => p.action === "EXIT").map((p) => p.asset);
  const portfolio = `${set || "no positions"}${f.cashPercent === null ? "" : ` and ${f.cashPercent}% cash`}${exits.length > 0 ? `, leaving ${exits.join(", ")}` : ""}`;
  const text =
    f.event === "no_change"
      ? `${f.agent} kept its plan (${(f.reasonCode ?? "NO_CHANGE").toLowerCase().replaceAll("_", " ")}); the evidence was ${f.evidenceStrength}.`
      : f.event === "proposed"
        ? `${f.agent} proposed a portfolio of ${portfolio}, with ${f.evidenceStrength} evidence; it waits for the owner's approval.`
        : f.event === "applied"
          ? `${f.agent} set a new portfolio of ${portfolio}, with ${f.evidenceStrength} evidence; the owner's setting applies plan changes at once.`
          : f.event === "approved"
            ? `The owner approved ${f.agent}'s portfolio of ${portfolio}; the runner trades toward it in capped legs.`
            : f.event === "declined"
              ? `The owner declined ${f.agent}'s proposed portfolio of ${portfolio}; the plan stays as it is.`
              : `${f.agent}'s proposed portfolio was rejected by the platform's checks: ${f.reasons.map((r) => r.code).join(", ") || f.reasonCode || "see the plan card"}.`;
  return text.slice(0, PROPOSAL_ENTRY_MAX_CHARS);
}
