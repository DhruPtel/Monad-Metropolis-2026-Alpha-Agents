import { type Db, type RuntimeStatus, sql } from "@alpha-agents/db";

/**
 * The orchestrator's Postgres records (D-202). Every write that a repeated
 * job could repeat is conditional, and per-agent work runs under a Postgres
 * advisory lock, so two workers never provision one agent at the same time.
 */
export interface AgentRef {
  readonly chainId: number;
  readonly agentId: number;
}

export const refKey = (r: AgentRef): string => `${r.chainId}-${r.agentId}`;

export interface IndexedAgent extends AgentRef {
  readonly species: number;
  readonly tier: number;
  readonly owner: string;
}

export interface Runtime extends AgentRef {
  readonly generation: number;
  readonly status: RuntimeStatus;
  readonly tier: number;
  readonly species: number;
  readonly config: Record<string, unknown>;
  readonly configHash: string;
  readonly keyAlias: string;
  readonly keyCiphertext: string | null;
  readonly budgetUsd: string;
  readonly lastError: string | null;
  readonly updatedAt: Date;
  readonly provisionedAt: Date | null;
}

export interface Lease extends AgentRef {
  readonly leaseId: string;
  readonly runTag: string;
  readonly namespace: string;
  readonly purpose: string;
  readonly sandboxId: string | null;
  readonly gateTokenHash: string;
  readonly status: "active" | "ended";
  readonly startedAt: Date;
  readonly expiresAt: Date;
  readonly endedAt: Date | null;
  readonly endReason: string | null;
}

export type TaskKind = "noop" | "scan" | "chain_check" | "research_check";
/** Who asked for a task (D-219). */
export type TaskRequester = "owner" | "console" | "schedule";

export interface Task extends AgentRef {
  readonly taskId: string;
  readonly kind: TaskKind;
  readonly status: "queued" | "running" | "succeeded" | "failed";
  readonly leaseId: string | null;
  readonly result: Record<string, unknown> | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

/** How long a provisioning attempt may sit in `provisioning` or `failed` before a retry. */
export const RETRY_AFTER_MS = 30_000;

interface RuntimeRow {
  chain_id: number;
  agent_id: number;
  generation: number;
  status: RuntimeStatus;
  tier: number;
  species: number;
  config: Record<string, unknown>;
  config_hash: string;
  key_alias: string;
  key_ciphertext: string | null;
  budget_usd: string;
  last_error: string | null;
  updated_at: Date;
  provisioned_at: Date | null;
}

const toRuntime = (r: RuntimeRow): Runtime => ({
  chainId: r.chain_id,
  agentId: r.agent_id,
  generation: r.generation,
  status: r.status,
  tier: r.tier,
  species: r.species,
  config: r.config,
  configHash: r.config_hash,
  keyAlias: r.key_alias,
  keyCiphertext: r.key_ciphertext,
  budgetUsd: r.budget_usd,
  lastError: r.last_error,
  updatedAt: r.updated_at,
  provisionedAt: r.provisioned_at,
});

interface LeaseRow {
  lease_id: string;
  chain_id: number;
  agent_id: number;
  run_tag: string;
  namespace: string;
  purpose: string;
  sandbox_id: string | null;
  gate_token_hash: string;
  status: "active" | "ended";
  started_at: Date;
  expires_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
}

const toLease = (r: LeaseRow): Lease => ({
  leaseId: r.lease_id,
  chainId: r.chain_id,
  agentId: r.agent_id,
  runTag: r.run_tag,
  namespace: r.namespace,
  purpose: r.purpose,
  sandboxId: r.sandbox_id,
  gateTokenHash: r.gate_token_hash,
  status: r.status,
  startedAt: r.started_at,
  expiresAt: r.expires_at,
  endedAt: r.ended_at,
  endReason: r.end_reason,
});

interface TaskRow {
  task_id: string;
  chain_id: number;
  agent_id: number;
  kind: TaskKind;
  status: Task["status"];
  lease_id: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const toTask = (r: TaskRow): Task => ({
  taskId: r.task_id,
  chainId: r.chain_id,
  agentId: r.agent_id,
  kind: r.kind,
  status: r.status,
  leaseId: r.lease_id,
  result: r.result,
  error: r.error,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

/** A Scan is already queued or running for the agent (the partial unique index, D-219). */
export class OpenScanExistsError extends Error {
  constructor(agentId: number) {
    super(`Agent ${agentId} already has a Scan queued or running.`);
    this.name = "OpenScanExistsError";
  }
}

/** A lease is refused because the agent already has an active one. */
export class LeaseHeldError extends Error {
  constructor(ref: AgentRef) {
    super(`agent ${ref.agentId} already has an active sandbox lease`);
    this.name = "LeaseHeldError";
  }
}

export class Store {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Runs fn while holding this agent's advisory lock. Waiting is a try-lock loop
   * that holds no pooled connection between tries: a blocking pg_advisory_lock
   * held one connection per waiter, so enough waiters starved the holder's own
   * queries and the pool deadlocked (L-72).
   */
  async withAgentLock<T>(ref: AgentRef, fn: () => Promise<T>, timeoutMs = 120_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const outcome = await this.db.connection().execute(async (conn) => {
        const { rows } = await sql<{ ok: boolean }>`
          select pg_try_advisory_lock(${ref.chainId}::int4, ${ref.agentId}::int4) as ok`.execute(
          conn,
        );
        if (!rows[0]?.ok) return { held: false as const };
        try {
          return { held: true as const, value: await fn() };
        } finally {
          await sql`select pg_advisory_unlock(${ref.chainId}::int4, ${ref.agentId}::int4)`.execute(
            conn,
          );
        }
      });
      if (outcome.held) return outcome.value;
      if (Date.now() > deadline) throw new Error(`agent ${ref.agentId} stayed locked`);
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    }
  }

  // ---- indexed agents (read only: the indexer owns them) ----

  async indexedAgent(ref: AgentRef): Promise<IndexedAgent | null> {
    const row = await this.db
      .selectFrom("indexer.agents")
      .select(["chain_id", "agent_id", "species", "tier", "owner"])
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .executeTakeFirst();
    return row
      ? {
          chainId: row.chain_id,
          agentId: row.agent_id,
          species: row.species,
          tier: row.tier,
          owner: row.owner,
        }
      : null;
  }

  /** Revealed agents that need provisioning: no runtime, deprovisioned, or a stale attempt. */
  async agentsToProvision(chainId: number, now = new Date()): Promise<AgentRef[]> {
    const stale = new Date(now.getTime() - RETRY_AFTER_MS);
    const rows = await this.db
      .selectFrom("indexer.agents as a")
      .leftJoin("platform.agent_runtimes as r", (j) =>
        j.onRef("r.chain_id", "=", "a.chain_id").onRef("r.agent_id", "=", "a.agent_id"),
      )
      .select(["a.chain_id", "a.agent_id"])
      .where("a.chain_id", "=", chainId)
      .where("a.species", ">", 0)
      .where((eb) =>
        eb.or([
          eb("r.agent_id", "is", null),
          eb("r.status", "=", "deprovisioned"),
          eb.and([
            eb("r.status", "in", ["provisioning", "failed"]),
            eb("r.updated_at", "<", stale),
          ]),
          // A reorg that changed the reveal: the runtime no longer matches the agent.
          eb.and([
            eb("r.status", "=", "ready"),
            eb.or([
              eb("r.species", "!=", eb.ref("a.species")),
              eb("r.tier", "!=", eb.ref("a.tier")),
            ]),
          ]),
        ]),
      )
      .orderBy("a.agent_id")
      .execute();
    return rows.map((r) => ({ chainId: r.chain_id, agentId: r.agent_id }));
  }

  /** Runtimes whose agent is gone or no longer revealed (a reorg rolled it back). */
  async runtimesToDeprovision(chainId: number): Promise<AgentRef[]> {
    const rows = await this.db
      .selectFrom("platform.agent_runtimes as r")
      .leftJoin("indexer.agents as a", (j) =>
        j.onRef("a.chain_id", "=", "r.chain_id").onRef("a.agent_id", "=", "r.agent_id"),
      )
      .select(["r.chain_id", "r.agent_id"])
      .where("r.chain_id", "=", chainId)
      .where("r.status", "!=", "deprovisioned")
      .where((eb) => eb.or([eb("a.agent_id", "is", null), eb("a.species", "=", 0)]))
      .orderBy("r.agent_id")
      .execute();
    return rows.map((r) => ({ chainId: r.chain_id, agentId: r.agent_id }));
  }

  // ---- runtimes ----

  async runtime(ref: AgentRef): Promise<Runtime | null> {
    const row = await this.db
      .selectFrom("platform.agent_runtimes")
      .selectAll()
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .executeTakeFirst();
    return row ? toRuntime(row as RuntimeRow) : null;
  }

  async runtimes(chainId: number): Promise<Runtime[]> {
    const rows = await this.db
      .selectFrom("platform.agent_runtimes")
      .selectAll()
      .where("chain_id", "=", chainId)
      .orderBy("agent_id")
      .execute();
    return rows.map((r) => toRuntime(r as RuntimeRow));
  }

  /** Creates or restarts the runtime row in `provisioning` for one generation. */
  async beginProvisioning(r: {
    ref: AgentRef;
    generation: number;
    tier: number;
    species: number;
    config: Record<string, unknown>;
    configHash: string;
    keyAlias: string;
    keyCiphertext: string;
    budgetUsd: string;
  }): Promise<void> {
    const values = {
      chain_id: r.ref.chainId,
      agent_id: r.ref.agentId,
      generation: r.generation,
      status: "provisioning" as const,
      tier: r.tier,
      species: r.species,
      config: JSON.stringify(r.config),
      config_hash: r.configHash,
      key_alias: r.keyAlias,
      key_ciphertext: r.keyCiphertext,
      budget_usd: r.budgetUsd,
      last_error: null,
    };
    await this.db
      .insertInto("platform.agent_runtimes")
      .values(values)
      .onConflict((oc) =>
        oc.columns(["chain_id", "agent_id"]).doUpdateSet({
          ...values,
          updated_at: sql`now()`,
          provisioned_at: null,
          deprovisioned_at: null,
        }),
      )
      .execute();
  }

  async setRuntimeStatus(
    ref: AgentRef,
    status: RuntimeStatus,
    extra: { lastError?: string | null; clearKey?: boolean } = {},
  ): Promise<void> {
    await this.db
      .updateTable("platform.agent_runtimes")
      .set({
        status,
        updated_at: sql`now()`,
        ...(status === "ready" ? { provisioned_at: sql`now()`, last_error: null } : {}),
        ...(status === "deprovisioned" ? { deprovisioned_at: sql`now()` } : {}),
        ...(extra.lastError === undefined ? {} : { last_error: extra.lastError }),
        ...(extra.clearKey ? { key_ciphertext: null } : {}),
      })
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .execute();
  }

  // ---- leases ----

  /** Inserts an active lease; the partial unique index refuses a second one for the agent. */
  async insertLease(l: {
    leaseId: string;
    ref: AgentRef;
    runTag: string;
    namespace: string;
    purpose: string;
    gateTokenHash: string;
    expiresAt: Date;
  }): Promise<Lease> {
    try {
      const row = await this.db
        .insertInto("platform.sandbox_leases")
        .values({
          lease_id: l.leaseId,
          chain_id: l.ref.chainId,
          agent_id: l.ref.agentId,
          run_tag: l.runTag,
          namespace: l.namespace,
          purpose: l.purpose,
          gate_token_hash: l.gateTokenHash,
          status: "active",
          expires_at: l.expiresAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toLease(row as LeaseRow);
    } catch (err) {
      if (err instanceof Error && /sandbox_leases_one_active/.test(err.message))
        throw new LeaseHeldError(l.ref);
      throw err;
    }
  }

  async setLeaseSandbox(leaseId: string, sandboxId: string): Promise<void> {
    await this.db
      .updateTable("platform.sandbox_leases")
      .set({ sandbox_id: sandboxId })
      .where("lease_id", "=", leaseId)
      .execute();
  }

  /** Ends a lease once; returns false when it had already ended. */
  async endLease(leaseId: string, reason: string): Promise<boolean> {
    const res = await this.db
      .updateTable("platform.sandbox_leases")
      .set({ status: "ended", ended_at: sql`now()`, end_reason: reason })
      .where("lease_id", "=", leaseId)
      .where("status", "=", "active")
      .executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  async lease(leaseId: string): Promise<Lease | null> {
    const row = await this.db
      .selectFrom("platform.sandbox_leases")
      .selectAll()
      .where("lease_id", "=", leaseId)
      .executeTakeFirst();
    return row ? toLease(row as LeaseRow) : null;
  }

  async activeLease(ref: AgentRef): Promise<Lease | null> {
    const row = await this.db
      .selectFrom("platform.sandbox_leases")
      .selectAll()
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .where("status", "=", "active")
      .executeTakeFirst();
    return row ? toLease(row as LeaseRow) : null;
  }

  /** The active, unexpired lease holding this gate token hash. */
  async leaseByTokenHash(hash: string, now = new Date()): Promise<Lease | null> {
    const row = await this.db
      .selectFrom("platform.sandbox_leases")
      .selectAll()
      .where("gate_token_hash", "=", hash)
      .where("status", "=", "active")
      .where("expires_at", ">", now)
      .executeTakeFirst();
    return row ? toLease(row as LeaseRow) : null;
  }

  async activeLeases(filter: { namespace?: string; expiredBy?: Date } = {}): Promise<Lease[]> {
    let q = this.db
      .selectFrom("platform.sandbox_leases")
      .selectAll()
      .where("status", "=", "active");
    if (filter.namespace !== undefined) q = q.where("namespace", "=", filter.namespace);
    if (filter.expiredBy !== undefined) q = q.where("expires_at", "<=", filter.expiredBy);
    const rows = await q.orderBy("started_at").execute();
    return rows.map((r) => toLease(r as LeaseRow));
  }

  async recentLeases(chainId: number, limit = 50): Promise<Lease[]> {
    const rows = await this.db
      .selectFrom("platform.sandbox_leases")
      .selectAll()
      .where("chain_id", "=", chainId)
      .orderBy("started_at", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => toLease(r as LeaseRow));
  }

  // ---- tasks ----

  /**
   * Records a queued task. A second open Scan for the agent breaks the partial
   * unique index (D-219) and throws OpenScanExistsError.
   */
  async insertTask(
    taskId: string,
    ref: AgentRef,
    kind: TaskKind,
    requestedBy: TaskRequester = "console",
  ): Promise<Task> {
    const row = await this.db
      .insertInto("platform.agent_tasks")
      .values({
        task_id: taskId,
        chain_id: ref.chainId,
        agent_id: ref.agentId,
        kind,
        status: "queued",
        requested_by: requestedBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
      .catch((err: unknown) => {
        if (err instanceof Error && /agent_tasks_one_open_scan/.test(err.message))
          throw new OpenScanExistsError(ref.agentId);
        throw err;
      });
    return toTask(row as TaskRow);
  }

  /** Queued Scan tasks, oldest first, for the orchestrator to put on its queue (D-219). */
  async queuedScans(chainId: number): Promise<Task[]> {
    const rows = await this.db
      .selectFrom("platform.agent_tasks")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("kind", "=", "scan")
      .where("status", "=", "queued")
      .orderBy("created_at")
      .execute();
    return rows.map((r) => toTask(r as TaskRow));
  }

  async task(taskId: string): Promise<Task | null> {
    const row = await this.db
      .selectFrom("platform.agent_tasks")
      .selectAll()
      .where("task_id", "=", taskId)
      .executeTakeFirst();
    return row ? toTask(row as TaskRow) : null;
  }

  async latestTasks(chainId: number): Promise<Task[]> {
    const rows = await this.db
      .selectFrom("platform.agent_tasks")
      .selectAll()
      .where("chain_id", "=", chainId)
      .orderBy("created_at", "desc")
      .limit(100)
      .execute();
    return rows.map((r) => toTask(r as TaskRow));
  }

  /** Moves a queued task to running; false when another worker already took it. */
  async startTask(taskId: string): Promise<boolean> {
    const res = await this.db
      .updateTable("platform.agent_tasks")
      .set({ status: "running", started_at: sql`now()` })
      .where("task_id", "=", taskId)
      .where("status", "=", "queued")
      .executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  async setTaskLease(taskId: string, leaseId: string): Promise<void> {
    await this.db
      .updateTable("platform.agent_tasks")
      .set({ lease_id: leaseId })
      .where("task_id", "=", taskId)
      .execute();
  }

  async finishTask(
    taskId: string,
    outcome:
      { result: Record<string, unknown> } | { error: string; result?: Record<string, unknown> },
  ): Promise<void> {
    const failed = "error" in outcome;
    await this.db
      .updateTable("platform.agent_tasks")
      .set({
        status: failed ? "failed" : "succeeded",
        // A failed task may still carry its structured result (a billing stop, P1-U6).
        result: outcome.result ? JSON.stringify(outcome.result) : null,
        error: failed ? outcome.error : null,
        finished_at: sql`now()`,
      })
      .where("task_id", "=", taskId)
      .where("status", "in", ["queued", "running"])
      .execute();
  }

  /** Tasks left running by an orchestrator that stopped: failed by the startup sweep. */
  async failUnfinishedTasks(reason: string): Promise<number> {
    const res = await this.db
      .updateTable("platform.agent_tasks")
      .set({ status: "failed", error: reason, finished_at: sql`now()` })
      .where("status", "=", "running")
      .executeTakeFirst();
    return Number(res.numUpdatedRows);
  }
}
