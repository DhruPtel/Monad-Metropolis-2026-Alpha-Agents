import { randomUUID } from "node:crypto";
import type {
  ChainCallLog,
  ChainTool,
  IntentDraft,
  IntentRecord,
  IntentStatus,
  IntentStore,
} from "@alpha-agents/chain-tools";
import type { AssetId, RejectionCode } from "@alpha-agents/domain";
import { type AgentIdentity, ToolError } from "@alpha-agents/tool-server";
import type { Hex } from "viem";
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

  constructor(store: Store, limit = MAX_CHAIN_CALLS_PER_LEASE) {
    this.store = store;
    this.limit = limit;
  }

  async begin(identity: AgentIdentity, tool: ChainTool, input: Record<string, unknown>) {
    const callId = `call-${randomUUID()}`;
    const ref = { chainId: identity.chainId, agentId: identity.agentId };
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
    await this.store.db
      .updateTable("platform.tool_calls")
      .set({
        status: outcome.status,
        error_code: outcome.errorCode ?? null,
        summary: outcome.summary ? json(outcome.summary) : null,
        finished_at: new Date(),
      })
      .where("call_id", "=", callId)
      .execute();
  }
}

interface Row {
  intent_id: string;
  idempotency_key: string;
  account: string | null;
  sell: "USDC" | "WMON";
  buy: "USDC" | "WMON";
  amount_in: string;
  reason: string;
  client_request_id: string | null;
  status: IntentStatus;
  reason_codes: string[];
  checks: Record<string, unknown>;
  owner_epoch: string | null;
  config_epoch: string | null;
  tx_hash: string | null;
  created_at: Date;
  expires_at: Date;
}

const record = (r: Row): IntentRecord => {
  const checks = r.checks as Record<string, unknown> & { blockers?: IntentRecord["blockers"] };
  const { blockers = [], ...rest } = checks;
  return {
    intentId: r.intent_id,
    idempotencyKey: r.idempotency_key,
    account: (r.account as Hex | null) ?? null,
    sell: r.sell as AssetId,
    buy: r.buy as AssetId,
    amountIn: BigInt(r.amount_in),
    reason: r.reason,
    clientRequestId: r.client_request_id,
    status: r.status,
    reasonCodes: r.reason_codes as RejectionCode[],
    blockers,
    checks: rest,
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
      if (same) return { record: record(same as Row), duplicate: true };
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
          sell: draft.sell,
          buy: draft.buy,
          amount_in: draft.amountIn.toString(),
          reason: draft.reason,
          client_request_id: draft.clientRequestId,
          idempotency_key: draft.idempotencyKey,
          status: draft.status,
          reason_codes: json(draft.reasonCodes),
          checks: json({ ...draft.checks, blockers: draft.blockers }),
          owner_epoch: draft.ownerEpoch === null ? null : draft.ownerEpoch.toString(),
          config_epoch: draft.configEpoch === null ? null : draft.configEpoch.toString(),
          expires_at: draft.expiresAt,
        })
        .execute();
      const row = await this.byKey(identity, draft.idempotencyKey);
      if (!row) throw new Error("the intent was not stored");
      return { record: record(row as Row), duplicate: false };
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
    return row ? record(row as Row) : null;
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
    return rows.map((r) => record(r as Row));
  }
}
