import { randomUUID } from "node:crypto";
import { type Db, sql } from "@alpha-agents/db";
import type { PlanTemplate } from "@alpha-agents/domain";
import {
  type RebalanceBandsParams,
  TARGET_PORTFOLIO_ID,
  type TargetPortfolioParams,
  canonicalJson,
  paramsHash,
  portfolioParamsFromJson,
  portfolioParamsHash,
  portfolioParamsJson,
} from "@alpha-agents/policy";
import type { Hex } from "viem";

/**
 * The plan store (P3-U3): the active plan per agent, its template and
 * parameters recorded by hash with the strategy epoch it was set at
 * (`platform.strategy_params`, until BuildRegistry exists). Setting a plan
 * bumps the strategy epoch (D-281), so any leg proposed under the previous
 * plan or goal is never sent, and moves a READY agent to RUNNING. Until
 * P3-U6's proposals, the owner or the dev console sets the plan. F-U6 adds
 * the second template, `target_portfolio@1` (D-344): the same row, with the
 * template named and its own parameters.
 */
export const PLAN_SET_REASON = "plan_set";

export type PlanSetter = "owner" | "console" | "agent" | "activation";

/** A plan's template with its parameters, as stored and as set. */
export type PlanParams =
  | { readonly template: "rebalance_bands@1"; readonly params: RebalanceBandsParams }
  | { readonly template: typeof TARGET_PORTFOLIO_ID; readonly params: TargetPortfolioParams };

interface StoredPlanBase {
  readonly paramId: string;
  readonly chainId: number;
  readonly agentId: number;
  readonly paramsHash: Hex;
  readonly strategyEpoch: bigint;
  readonly setBy: PlanSetter;
  readonly setByAddress: Hex | null;
  readonly createdAt: Date;
}

export type StoredPlan = StoredPlanBase & PlanParams;
export type StoredBandsPlan = Extract<StoredPlan, { template: "rebalance_bands@1" }>;
export type StoredPortfolioPlan = Extract<StoredPlan, { template: typeof TARGET_PORTFOLIO_ID }>;

export const isPortfolioPlan = (p: StoredPlan): p is StoredPortfolioPlan =>
  p.template === TARGET_PORTFOLIO_ID;
export const isBandsPlan = (p: StoredPlan): p is StoredBandsPlan =>
  p.template === "rebalance_bands@1";

/** Parameters from their stored JSON (bigints as decimal strings). */
export function paramsFromJson(raw: Record<string, unknown>): RebalanceBandsParams {
  return {
    targetWmonBps: Number(raw.targetWmonBps),
    bandHalfWidthBps: Number(raw.bandHalfWidthBps),
    minTradeUsdcE6: BigInt(String(raw.minTradeUsdcE6)),
    volatilityBrakeBps: Number(raw.volatilityBrakeBps),
    costHurdleBps: Number(raw.costHurdleBps),
    maxLegBps: Number(raw.maxLegBps),
  };
}

/** A plan's parameters as canonical JSON and their hash, by template. */
export function planJsonAndHash(p: PlanParams): { json: string; hash: Hex } {
  if (p.template === TARGET_PORTFOLIO_ID)
    return { json: portfolioParamsJson(p.params), hash: portfolioParamsHash(p.params) };
  return { json: canonicalJson(p.params), hash: paramsHash("rebalance_bands@1", p.params) };
}

interface Row {
  param_id: string;
  chain_id: number;
  agent_id: number;
  template: string;
  params: Record<string, unknown>;
  params_hash: string;
  strategy_epoch: string;
  set_by: PlanSetter;
  set_by_address: string | null;
  created_at: Date | string;
}

const storedPlan = (r: Row): StoredPlan => {
  const base: StoredPlanBase = {
    paramId: r.param_id,
    chainId: r.chain_id,
    agentId: r.agent_id,
    paramsHash: r.params_hash as Hex,
    strategyEpoch: BigInt(r.strategy_epoch),
    setBy: r.set_by,
    setByAddress: (r.set_by_address as Hex | null) ?? null,
    createdAt: new Date(r.created_at),
  };
  const template = r.template as PlanTemplate;
  if (template === TARGET_PORTFOLIO_ID)
    return { ...base, template, params: portfolioParamsFromJson(r.params) };
  return { ...base, template: "rebalance_bands@1", params: paramsFromJson(r.params) };
};

export class PlanStore {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async active(chainId: number, agentId: number): Promise<StoredPlan | null> {
    const row = await this.db
      .selectFrom("platform.strategy_params")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("active", "=", true)
      .executeTakeFirst();
    return row ? storedPlan(row as unknown as Row) : null;
  }

  /** Every agent of the chain with an active plan, with its plan. */
  async activePlans(chainId: number): Promise<StoredPlan[]> {
    const rows = await this.db
      .selectFrom("platform.strategy_params")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("active", "=", true)
      .orderBy("agent_id")
      .execute();
    return rows.map((r) => storedPlan(r as unknown as Row));
  }

  async history(chainId: number, agentId: number, limit = 10): Promise<StoredPlan[]> {
    const rows = await this.db
      .selectFrom("platform.strategy_params")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => storedPlan(r as unknown as Row));
  }

  /**
   * Sets the plan: one transaction under the agent's state row lock, which
   * bumps the strategy epoch, ends the previous plan and records this one at
   * the new epoch; a READY agent becomes RUNNING. The caller has checked the
   * parameters against the template and the goal (packages/policy `checkPlan`,
   * or the Test stage for a target portfolio). Without a template the plan is
   * the two-asset one, as before F-U6.
   */
  async set(
    s: {
      chainId: number;
      agentId: number;
      setBy: PlanSetter;
      setByAddress?: Hex | null;
    } & (
      | { template?: "rebalance_bands@1"; params: RebalanceBandsParams }
      | { template: typeof TARGET_PORTFOLIO_ID; params: TargetPortfolioParams }
    ),
  ): Promise<StoredPlan> {
    const plan: PlanParams =
      s.template === TARGET_PORTFOLIO_ID
        ? { template: TARGET_PORTFOLIO_ID, params: s.params }
        : { template: "rebalance_bands@1", params: s.params };
    const { json, hash } = planJsonAndHash(plan);
    return this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("platform.agent_states")
        .values({ chain_id: s.chainId, agent_id: s.agentId, state: "UNCONFIGURED" })
        .onConflict((oc) => oc.columns(["chain_id", "agent_id"]).doNothing())
        .execute();
      const locked = await trx
        .selectFrom("platform.agent_states")
        .selectAll()
        .where("chain_id", "=", s.chainId)
        .where("agent_id", "=", s.agentId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (locked.state === "UNCONFIGURED")
        throw new Error("the agent has no goal yet; its owner saves one before a plan");
      const epoch = BigInt(locked.strategy_epoch) + 1n;
      const next = locked.state === "READY" ? "RUNNING" : locked.state;
      await trx
        .updateTable("platform.strategy_params")
        .set({ active: false, superseded_at: sql`now()` })
        .where("chain_id", "=", s.chainId)
        .where("agent_id", "=", s.agentId)
        .where("active", "=", true)
        .execute();
      const paramId = `plan-${randomUUID()}`;
      await trx
        .insertInto("platform.strategy_params")
        .values({
          param_id: paramId,
          chain_id: s.chainId,
          agent_id: s.agentId,
          template: plan.template,
          params: json,
          params_hash: hash,
          strategy_epoch: epoch.toString(),
          set_by: s.setBy,
          set_by_address: s.setByAddress?.toLowerCase() ?? null,
        })
        .execute();
      await trx
        .updateTable("platform.agent_states")
        .set({ state: next, strategy_epoch: epoch.toString(), updated_at: sql`now()` })
        .where("chain_id", "=", s.chainId)
        .where("agent_id", "=", s.agentId)
        .execute();
      if (next !== locked.state)
        await trx
          .insertInto("platform.agent_state_changes")
          .values({
            chain_id: s.chainId,
            agent_id: s.agentId,
            from_state: locked.state,
            to_state: next,
            reason: PLAN_SET_REASON,
            strategy_epoch: epoch.toString(),
          })
          .execute();
      const row = await trx
        .selectFrom("platform.strategy_params")
        .selectAll()
        .where("param_id", "=", paramId)
        .executeTakeFirstOrThrow();
      return storedPlan(row as unknown as Row);
    });
  }
}
