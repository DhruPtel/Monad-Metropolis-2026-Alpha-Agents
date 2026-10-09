import { type Db, sql } from "@alpha-agents/db";
import { canonicalJson } from "@alpha-agents/policy";

/**
 * The template runner's decisions (P3-U3, D-290): every minute the runner
 * decides one leg or one hold per agent, and `platform.runner_decisions` gets
 * a new row only when the outcome or its reason changes (a new plan, another
 * reason, another set of blocking codes). An unchanged hold moves its row's
 * `last_at` and `ticks` and keeps the latest facts, so a day of ticks in band
 * is one row. Every leg is a row of its own, with the intent it proposed.
 */
export interface RunnerDecision {
  readonly decisionId: number;
  readonly chainId: number;
  readonly agentId: number;
  readonly paramId: string | null;
  readonly strategyEpoch: bigint;
  readonly outcome: "hold" | "leg";
  /** The main reason: the runner's, the Executor's or the trade flow's code; for a leg, "LEG". */
  readonly code: string;
  /** Every code that stopped the leg, for a hold the Executor or the trade flow refused. */
  readonly codes: readonly string[];
  readonly leg: {
    readonly sell: "USDC" | "WMON";
    readonly buy: "USDC" | "WMON";
    readonly amountIn: string;
    readonly valueUsdcE6: string;
  } | null;
  readonly intentId: string | null;
  readonly facts: Record<string, unknown>;
  readonly block: bigint | null;
  readonly firstAt: Date;
  readonly lastAt: Date;
  readonly ticks: number;
}

export type NewDecision = Omit<RunnerDecision, "decisionId" | "firstAt" | "lastAt" | "ticks">;

interface Row {
  decision_id: number;
  chain_id: number;
  agent_id: number;
  param_id: string | null;
  strategy_epoch: string;
  outcome: "hold" | "leg";
  code: string;
  codes: string[];
  leg: Record<string, unknown> | null;
  intent_id: string | null;
  facts: Record<string, unknown>;
  block: string | null;
  first_at: Date | string;
  last_at: Date | string;
  ticks: number;
}

const decision = (r: Row): RunnerDecision => ({
  decisionId: r.decision_id,
  chainId: r.chain_id,
  agentId: r.agent_id,
  paramId: r.param_id,
  strategyEpoch: BigInt(r.strategy_epoch),
  outcome: r.outcome,
  code: r.code,
  codes: r.codes,
  leg: (r.leg as RunnerDecision["leg"]) ?? null,
  intentId: r.intent_id,
  facts: r.facts,
  block: r.block === null ? null : BigInt(r.block),
  firstAt: new Date(r.first_at),
  lastAt: new Date(r.last_at),
  ticks: r.ticks,
});

const sameHold = (a: RunnerDecision, b: NewDecision) =>
  a.outcome === "hold" &&
  b.outcome === "hold" &&
  a.code === b.code &&
  a.paramId === b.paramId &&
  a.strategyEpoch === b.strategyEpoch &&
  canonicalJson([...a.codes].sort()) === canonicalJson([...b.codes].sort());

export class DecisionStore {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async latest(chainId: number, agentId: number): Promise<RunnerDecision | null> {
    const row = await this.db
      .selectFrom("platform.runner_decisions")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .orderBy("decision_id", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? decision(row as unknown as Row) : null;
  }

  async recent(chainId: number, agentId: number, limit = 20): Promise<RunnerDecision[]> {
    const rows = await this.db
      .selectFrom("platform.runner_decisions")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .orderBy("decision_id", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => decision(r as unknown as Row));
  }

  /**
   * Records a decision: an unchanged hold extends the latest row; anything
   * else is a new row. Returns the stored decision and whether it is a change.
   */
  async record(d: NewDecision, at: Date): Promise<{ decision: RunnerDecision; changed: boolean }> {
    const last = await this.latest(d.chainId, d.agentId);
    if (last && sameHold(last, d)) {
      const row = await this.db
        .updateTable("platform.runner_decisions")
        .set({
          last_at: at,
          ticks: sql`ticks + 1`,
          facts: canonicalJson(d.facts),
          block: d.block === null ? null : d.block.toString(),
        })
        .where("decision_id", "=", last.decisionId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { decision: decision(row as unknown as Row), changed: false };
    }
    const row = await this.db
      .insertInto("platform.runner_decisions")
      .values({
        chain_id: d.chainId,
        agent_id: d.agentId,
        param_id: d.paramId,
        strategy_epoch: d.strategyEpoch.toString(),
        outcome: d.outcome,
        code: d.code,
        codes: canonicalJson(d.codes),
        leg: d.leg ? canonicalJson(d.leg) : null,
        intent_id: d.intentId,
        facts: canonicalJson(d.facts),
        block: d.block === null ? null : d.block.toString(),
        first_at: at,
        last_at: at,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { decision: decision(row as unknown as Row), changed: true };
  }
}
