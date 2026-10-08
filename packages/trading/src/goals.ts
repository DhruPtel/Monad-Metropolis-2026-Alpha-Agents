import { randomUUID } from "node:crypto";
import { type Db, sql } from "@alpha-agents/db";
import type { AgentState, GoalInput } from "@alpha-agents/domain";
import { type GoalConfig, canonicalJson } from "@alpha-agents/policy";
import { type Hex, getAddress } from "viem";

/**
 * The owner's goal and the agent's offchain state (P3-U1): every saved goal
 * in `platform.agent_goals` (one current), the agent's state and strategy
 * epoch in `platform.agent_states`, and every change of state in
 * `platform.agent_state_changes`.
 *
 * The strategy epoch (D-281) is bumped on every saved goal. Intents carry the
 * epoch they were proposed under, and the trade flow refuses a stale one with
 * STRATEGY_EPOCH_STALE; it never touches the Executor's configuration epoch,
 * so it never ends arming.
 *
 * A goal binds the owner who saved it: it applies only while the agent's
 * ownership epoch is the one it was saved under (FINAL_PLAN 6.1). Under a new
 * owner the agent reads as UNCONFIGURED until that owner saves a goal.
 */

export interface StoredGoal {
  readonly goalId: string;
  readonly chainId: number;
  readonly agentId: number;
  readonly strategyEpoch: bigint;
  readonly ownerEpoch: bigint;
  readonly savedBy: Hex;
  readonly goal: GoalInput;
  /** The translated configuration as stored: bigints are decimal strings. */
  readonly config: StoredGoalConfig;
  readonly policyHash: Hex;
  readonly soulBlock: string;
  readonly createdAt: Date;
}

/** GoalConfig after a round trip through JSON: every bigint becomes its decimal string. */
export type StoredGoalConfig = Jsonified<Omit<GoalConfig, "soulBlock">>;
type Jsonified<T> = T extends bigint
  ? string
  : T extends readonly (infer U)[]
    ? readonly Jsonified<U>[]
    : T extends object
      ? { readonly [K in keyof T]: Jsonified<T[K]> }
      : T;

export interface StateChange {
  readonly from: AgentState;
  readonly to: AgentState;
  readonly reason: string;
  readonly strategyEpoch: bigint;
  readonly at: Date;
}

export interface AgentGoalView {
  /** The goal that applies to the current owner, or null. */
  readonly goal: StoredGoal | null;
  /** The agent's state as the current owner sees it. */
  readonly state: AgentState;
  readonly strategyEpoch: bigint;
}

/** The reason recorded when a saved goal moves an agent to READY. */
export const GOAL_SAVED_REASON = "goal_saved";

const toJson = (v: unknown) => canonicalJson(v);

function storedGoal(r: {
  goal_id: string;
  chain_id: number;
  agent_id: number;
  strategy_epoch: string | number;
  owner_epoch: string | number;
  saved_by: string;
  goal: unknown;
  config: unknown;
  policy_hash: string;
  soul_block: string;
  created_at: Date | string;
}): StoredGoal {
  return {
    goalId: r.goal_id,
    chainId: r.chain_id,
    agentId: r.agent_id,
    strategyEpoch: BigInt(r.strategy_epoch),
    ownerEpoch: BigInt(r.owner_epoch),
    savedBy: getAddress(r.saved_by),
    goal: r.goal as GoalInput,
    config: r.config as StoredGoalConfig,
    policyHash: r.policy_hash as Hex,
    soulBlock: r.soul_block,
    createdAt: new Date(r.created_at),
  };
}

export class GoalStore {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** The current goal for the agent, whatever owner saved it; null if none was ever saved. */
  async currentGoal(chainId: number, agentId: number): Promise<StoredGoal | null> {
    const row = await this.db
      .selectFrom("platform.agent_goals")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("current", "=", true)
      .executeTakeFirst();
    return row ? storedGoal(row) : null;
  }

  /** The agent's strategy epoch: 0 before its first goal. */
  async strategyEpoch(chainId: number, agentId: number): Promise<bigint> {
    const row = await this.db
      .selectFrom("platform.agent_states")
      .select("strategy_epoch")
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .executeTakeFirst();
    return row ? BigInt(row.strategy_epoch) : 0n;
  }

  /**
   * The goal and state as the owner at `ownerEpoch` sees them. A goal another
   * owner saved does not apply, and the agent reads as UNCONFIGURED.
   */
  async view(chainId: number, agentId: number, ownerEpoch: bigint): Promise<AgentGoalView> {
    const [goal, stateRow] = await Promise.all([
      this.currentGoal(chainId, agentId),
      this.db
        .selectFrom("platform.agent_states")
        .selectAll()
        .where("chain_id", "=", chainId)
        .where("agent_id", "=", agentId)
        .executeTakeFirst(),
    ]);
    const strategyEpoch = stateRow ? BigInt(stateRow.strategy_epoch) : 0n;
    const mine = goal && goal.ownerEpoch === ownerEpoch ? goal : null;
    const stored: AgentState = stateRow?.state ?? "UNCONFIGURED";
    const state: AgentState = mine ? stored : "UNCONFIGURED";
    return { goal: mine, state, strategyEpoch };
  }

  /**
   * Saves the goal as the current one, bumps the strategy epoch, and moves an
   * UNCONFIGURED agent (or one whose goal another owner saved) to READY,
   * recording the change. One transaction, serialized per agent by the state
   * row's lock, so two saves never share an epoch.
   */
  async save(s: {
    chainId: number;
    agentId: number;
    ownerEpoch: bigint;
    savedBy: Hex;
    config: GoalConfig;
  }): Promise<AgentGoalView & { readonly changed: StateChange | null }> {
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
      const previous = await trx
        .selectFrom("platform.agent_goals")
        .select("owner_epoch")
        .where("chain_id", "=", s.chainId)
        .where("agent_id", "=", s.agentId)
        .where("current", "=", true)
        .executeTakeFirst();
      // The state this owner saw: a goal another owner saved does not count.
      const seen: AgentState =
        previous && BigInt(previous.owner_epoch) === s.ownerEpoch ? locked.state : "UNCONFIGURED";
      // A goal makes an unconfigured agent READY; RUNNING and the stopped states are set elsewhere.
      const next: AgentState = seen === "UNCONFIGURED" ? "READY" : seen;
      const epoch = BigInt(locked.strategy_epoch) + 1n;
      const { soulBlock, ...config } = s.config;

      await trx
        .updateTable("platform.agent_goals")
        .set({ current: false })
        .where("chain_id", "=", s.chainId)
        .where("agent_id", "=", s.agentId)
        .where("current", "=", true)
        .execute();
      const goalId = `goal-${randomUUID()}`;
      await trx
        .insertInto("platform.agent_goals")
        .values({
          goal_id: goalId,
          chain_id: s.chainId,
          agent_id: s.agentId,
          strategy_epoch: epoch.toString(),
          owner_epoch: s.ownerEpoch.toString(),
          saved_by: s.savedBy.toLowerCase(),
          goal: toJson(s.config.goal),
          config: toJson(config),
          policy_hash: s.config.policyHash,
          soul_block: soulBlock,
          current: true,
        })
        .execute();
      await trx
        .updateTable("platform.agent_states")
        .set({ state: next, strategy_epoch: epoch.toString(), updated_at: sql`now()` })
        .where("chain_id", "=", s.chainId)
        .where("agent_id", "=", s.agentId)
        .execute();
      let changed: StateChange | null = null;
      if (seen !== next) {
        const from: AgentState = seen;
        const row = await trx
          .insertInto("platform.agent_state_changes")
          .values({
            chain_id: s.chainId,
            agent_id: s.agentId,
            from_state: from,
            to_state: next,
            reason: GOAL_SAVED_REASON,
            strategy_epoch: epoch.toString(),
          })
          .returning("created_at")
          .executeTakeFirstOrThrow();
        changed = {
          from,
          to: next,
          reason: GOAL_SAVED_REASON,
          strategyEpoch: epoch,
          at: new Date(row.created_at),
        };
      }
      const saved = await trx
        .selectFrom("platform.agent_goals")
        .selectAll()
        .where("goal_id", "=", goalId)
        .executeTakeFirstOrThrow();
      return { goal: storedGoal(saved), state: next, strategyEpoch: epoch, changed };
    });
  }

  /** Every change of the agent's state, oldest first. */
  async stateChanges(chainId: number, agentId: number): Promise<StateChange[]> {
    const rows = await this.db
      .selectFrom("platform.agent_state_changes")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .orderBy("change_id")
      .execute();
    return rows.map((r) => ({
      from: r.from_state,
      to: r.to_state,
      reason: r.reason,
      strategyEpoch: BigInt(r.strategy_epoch),
      at: new Date(r.created_at),
    }));
  }

  /** Every goal saved for the agent, newest first. */
  async history(chainId: number, agentId: number): Promise<StoredGoal[]> {
    const rows = await this.db
      .selectFrom("platform.agent_goals")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .orderBy("strategy_epoch", "desc")
      .execute();
    return rows.map(storedGoal);
  }
}
