import { randomUUID } from "node:crypto";
import type {
  ChainCallLog,
  ChainTool,
  IntentDraft,
  IntentRecord,
  IntentStatus,
  IntentStore,
} from "@alpha-agents/chain-tools";
import {
  type RejectionCode,
  SLOT_HOLDING_INTENT_STATES,
  type TradeFlowCode,
} from "@alpha-agents/domain";
import { sql } from "@alpha-agents/db";
import { type AgentIdentity, ToolError } from "@alpha-agents/tool-server";
import type { Hex } from "viem";
import type { CycleStore } from "../cycle/store.ts";
import type { Store } from "../store.ts";

/**
 * The chain tools' records in Postgres (P2-U5): every call in the action log
 * (`platform.tool_calls`, server `chain`, free, rate limited per lease), and
 * every proposal in `platform.intents`. Both are keyed by the agent and lease
 * the injected token named; nothing an agent sends can choose another's rows.
 */

/** A-42: the chain tool calls one run (lease) may make, reads and proposals together. */
export const MAX_CHAIN_CALLS_PER_LEASE = 60;

const json = (v: unknown) => JSON.stringify(v ?? null);

export class PgChainCallLog implements ChainCallLog {
  private readonly store: Store;
  private readonly limit: number;
  /** P3-U4: inside a cycle, calls carry their stage and their results are stored. */
  private readonly cycles: CycleStore | null;

  constructor(store: Store, limit = MAX_CHAIN_CALLS_PER_LEASE, cycles: CycleStore | null = null) {
    this.store = store;
    this.limit = limit;
    this.cycles = cycles;
  }

  async begin(identity: AgentIdentity, tool: ChainTool, input: Record<string, unknown>) {
    const callId = `call-${randomUUID()}`;
    const ref = { chainId: identity.chainId, agentId: identity.agentId };
    const stageRunId = (await this.cycles?.currentStage(identity.leaseId))?.stageRunId ?? null;
    const refused = await this.store.withAgentLock(ref, async () => {
      const used = await this.store.db
        .selectFrom("platform.tool_calls")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("lease_id", "=", identity.leaseId)
        .where("server", "=", "chain")
        .where("status", "!=", "refused")
        .executeTakeFirstOrThrow();
      const over = Number(used.n) >= this.limit;
      await this.store.db
        .insertInto("platform.tool_calls")
        .values({
          call_id: callId,
          chain_id: identity.chainId,
          agent_id: identity.agentId,
          lease_id: identity.leaseId,
          server: "chain",
          tool,
          input: json(input),
          status: over ? "refused" : "running",
          error_code: over ? "LEASE_CALL_LIMIT" : null,
          ...(over ? { finished_at: new Date() } : {}),
          stage_run_id: stageRunId,
        })
        .execute();
      return over;
    });
    if (refused)
      throw new ToolError(
        "RATE_LIMITED",
        `This run has used all ${this.limit} of its chain tool calls.`,
        false,
      );
    return callId;
  }

  async finish(callId: string, outcome: Parameters<ChainCallLog["finish"]>[1]) {
    if (this.cycles && outcome.status === "succeeded" && outcome.result) {
      const row = await this.store.db
        .selectFrom("platform.tool_calls")
        .select(["stage_run_id", "tool"])
        .where("call_id", "=", callId)
        .executeTakeFirst();
      const run = row?.stage_run_id ? await this.cycles.stageRun(row.stage_run_id) : null;
      if (run && row) await this.cycles.storeResult(callId, run, row.tool, outcome.result);
    }
    await this.store.db
      .updateTable("platform.tool_calls")
      .set({
        status: outcome.status,
        error_code: outcome.errorCode ?? null,
        summary: outcome.summary ? json(outcome.summary) : null,
        ...(outcome.cacheHit === undefined ? {} : { cache_hit: outcome.cacheHit }),
        finished_at: new Date(),
      })
      .where("call_id", "=", callId)
      .execute();
  }
}

export interface IntentRow {
  intent_id: string;
  idempotency_key: string;
  account: string | null;
  sell: string;
  buy: string;
  custody: "v2" | "v3";
  sell_token: string | null;
  buy_token: string | null;
  route: string[] | null;
  amount_in: string;
  reason: string;
  client_request_id: string | null;
  status: IntentStatus;
  reason_codes: string[];
  blockers: Record<string, unknown>[];
  checks: Record<string, unknown>;
  owner_epoch: string | null;
  config_epoch: string | null;
  tx_hash: string | null;
  created_at: Date;
  expires_at: Date;
}

export const intentRecord = (r: IntentRow): IntentRecord => {
  return {
    intentId: r.intent_id,
    idempotencyKey: r.idempotency_key,
    account: (r.account as Hex | null) ?? null,
    custody: r.custody,
    sell: r.sell,
    buy: r.buy,
    sellToken: (r.sell_token as Hex | null) ?? null,
    buyToken: (r.buy_token as Hex | null) ?? null,
    route: r.route ? r.route.map((id) => id as Hex) : null,
    amountIn: BigInt(r.amount_in),
    reason: r.reason,
    clientRequestId: r.client_request_id,
    status: r.status,
    reasonCodes: r.reason_codes as (RejectionCode | TradeFlowCode)[],
    blockers: r.blockers as unknown as IntentRecord["blockers"],
    checks: r.checks,
    ownerEpoch: r.owner_epoch === null ? null : BigInt(r.owner_epoch),
    configEpoch: r.config_epoch === null ? null : BigInt(r.config_epoch),
    expiresAt: new Date(r.expires_at),
    createdAt: new Date(r.created_at),
    txHash: r.tx_hash,
  };
};

export class PgIntentStore implements IntentStore {
  private readonly store: Store;
  private readonly now: () => Date;

  constructor(store: Store, now: () => Date = () => new Date()) {
    this.store = store;
    this.now = now;
  }

  /** Marks every waiting intent past its expiry as expired. Returns how many. */
  async expireDue(chainId: number, agentId?: number): Promise<number> {
    let q = this.store.db
      .updateTable("platform.intents")
      .set({ status: "expired", updated_at: new Date() })
      .where("chain_id", "=", chainId)
      .where("status", "=", "awaiting_approval")
      .where("expires_at", "<=", this.now());
    if (agentId !== undefined) q = q.where("agent_id", "=", agentId);
    const r = await q.executeTakeFirst();
    return Number(r.numUpdatedRows);
  }

  private byKey(identity: AgentIdentity, key: string) {
    return this.store.db
      .selectFrom("platform.intents")
      .selectAll()
      .where("chain_id", "=", identity.chainId)
      .where("agent_id", "=", identity.agentId)
      .where("idempotency_key", "=", key)
      .executeTakeFirst();
  }

  async propose(identity: AgentIdentity, draft: IntentDraft, maxOpen: number) {
    const ref = { chainId: identity.chainId, agentId: identity.agentId };
    return this.store.withAgentLock(ref, async () => {
      await this.expireDue(identity.chainId, identity.agentId);
      const same = await this.byKey(identity, draft.idempotencyKey);
      if (same) return { record: intentRecord(same as IntentRow), duplicate: true };
      if (draft.status === "awaiting_approval") {
        const open = await this.store.db
          .selectFrom("platform.intents")
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .where("chain_id", "=", identity.chainId)
          .where("agent_id", "=", identity.agentId)
          .where("status", "=", "awaiting_approval")
          .executeTakeFirstOrThrow();
        if (Number(open.n) >= maxOpen)
          throw new ToolError(
            "RATE_LIMITED",
            `You already have ${maxOpen} intents awaiting approval; wait for them to be approved or expire.`,
            false,
          );
      }
      const intentId = `intent-${randomUUID()}`;
      await this.store.db
        .insertInto("platform.intents")
        .values({
          intent_id: intentId,
          chain_id: identity.chainId,
          agent_id: identity.agentId,
          lease_id: identity.leaseId,
          kind: "swap",
          account: draft.account?.toLowerCase() ?? null,
          custody: draft.custody ?? "v2",
          sell: draft.sell,
          buy: draft.buy,
          sell_token: draft.sellToken?.toLowerCase() ?? null,
          buy_token: draft.buyToken?.toLowerCase() ?? null,
          route: draft.route ? json([...draft.route]) : null,
          amount_in: draft.amountIn.toString(),
          reason: draft.reason,
          client_request_id: draft.clientRequestId,
          idempotency_key: draft.idempotencyKey,
          status: draft.status,
          reason_codes: json(draft.reasonCodes),
          blockers: json(draft.blockers),
          checks: json(draft.checks),
          owner_epoch: draft.ownerEpoch === null ? null : draft.ownerEpoch.toString(),
          config_epoch: draft.configEpoch === null ? null : draft.configEpoch.toString(),
          // The goal it is proposed under (D-281): the plan's epoch for the template runner,
          // otherwise the agent's strategy epoch now, null before any goal.
          strategy_epoch:
            draft.strategyEpoch !== undefined
              ? draft.strategyEpoch.toString()
              : sql<
                  string | null
                >`(select strategy_epoch from platform.agent_states where chain_id = ${identity.chainId} and agent_id = ${identity.agentId})`,
          source: draft.source ?? "agent",
          expires_at: draft.expiresAt,
        })
        .execute();
      const row = await this.byKey(identity, draft.idempotencyKey);
      if (!row) throw new Error("the intent was not stored");
      return { record: intentRecord(row as IntentRow), duplicate: false };
    });
  }

  async get(identity: AgentIdentity, intentId: string) {
    await this.expireDue(identity.chainId, identity.agentId);
    const row = await this.store.db
      .selectFrom("platform.intents")
      .selectAll()
      .where("intent_id", "=", intentId)
      .where("chain_id", "=", identity.chainId)
      .where("agent_id", "=", identity.agentId)
      .executeTakeFirst();
    return row ? intentRecord(row as IntentRow) : null;
  }

  async reservedSlots(identity: AgentIdentity, exceptIntentId?: string) {
    await this.expireDue(identity.chainId, identity.agentId);
    let q = this.store.db
      .selectFrom("platform.intents")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("chain_id", "=", identity.chainId)
      .where("agent_id", "=", identity.agentId)
      .where("status", "in", [...SLOT_HOLDING_INTENT_STATES]);
    if (exceptIntentId !== undefined) q = q.where("intent_id", "!=", exceptIntentId);
    return Number((await q.executeTakeFirstOrThrow()).n);
  }

  /** An agent's intents, newest first, for the dev console. */
  async list(chainId: number, agentId: number, limit = 20) {
    await this.expireDue(chainId, agentId);
    const rows = await this.store.db
      .selectFrom("platform.intents")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => intentRecord(r as IntentRow));
  }
}
