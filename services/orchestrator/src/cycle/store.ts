import { randomUUID } from "node:crypto";
import { chargeFor, usdToPicos } from "@alpha-agents/accounting";
import { type Db, sql } from "@alpha-agents/db";
import type { GateStage, ModelUsage } from "../gate.ts";
import type { AgentRef } from "../store.ts";
import type { CycleKind, Stage, StageCaps } from "./stages.ts";

/**
 * The discovery loop's records (P3-U4, migration 0018): cycles, their stage
 * runs, the model calls the gate saw under each stage, the bounded results of
 * each tool call a stage made, and the briefs agents wrote. Raw results and
 * refused briefs are platform-only; the console shows them to operators.
 */
export const MAX_RESULT_CHARS = 48_000;

export type StageStatus =
  "pending" | "running" | "completed" | "capped" | "stopped" | "failed" | "skipped";

export interface StageRun {
  readonly stageRunId: string;
  readonly cycleId: string;
  readonly chainId: number;
  readonly agentId: number;
  readonly seq: number;
  readonly stage: Stage;
  readonly themeCode: string | null;
  readonly idempotencyKey: string;
  readonly modelAlias: string | null;
  readonly caps: StageCaps;
  readonly ceilingUsdcE6: bigint;
  readonly status: StageStatus;
  readonly stopReason: string | null;
  readonly runId: string | null;
  readonly sessionId: string | null;
  readonly outcome: Record<string, unknown> | null;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly chargedUsdcE6: bigint;
  readonly absorbedUsdcE6: bigint;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

export interface Cycle {
  readonly cycleId: string;
  readonly chainId: number;
  readonly agentId: number;
  readonly taskId: string;
  readonly kind: CycleKind;
  readonly status: "queued" | "running" | "completed" | "stopped" | "failed";
  readonly stopReason: string | null;
  readonly reasoningAlias: string;
  readonly leaseId: string | null;
  readonly canary: string;
  readonly chargedUsdcE6: bigint;
  readonly absorbedUsdcE6: bigint;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

export interface BriefRow {
  readonly briefId: string;
  readonly cycleId: string;
  readonly stageRunId: string;
  readonly kind: string;
  readonly status: "accepted" | "refused";
  readonly body: Record<string, unknown>;
  readonly reasons: readonly string[];
  readonly createdAt: Date;
}

/** A result a cycle stored, as the brief validator reads it. */
export interface StoredResult {
  readonly callId: string;
  readonly stageRunId: string;
  readonly tool: string;
  readonly result: unknown;
}

interface StageRow {
  stage_run_id: string;
  cycle_id: string;
  chain_id: number;
  agent_id: number;
  seq: number;
  stage: Stage;
  theme_code: string | null;
  idempotency_key: string;
  model_alias: string | null;
  caps: Record<string, unknown>;
  ceiling_usdc_e6: string;
  status: StageStatus;
  stop_reason: string | null;
  run_id: string | null;
  session_id: string | null;
  outcome: Record<string, unknown> | null;
  model_calls: number;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  charged_usdc_e6: string;
  absorbed_usdc_e6: string;
  started_at: Date | null;
  finished_at: Date | null;
}

const toStage = (r: StageRow): StageRun => ({
  stageRunId: r.stage_run_id,
  cycleId: r.cycle_id,
  chainId: r.chain_id,
  agentId: r.agent_id,
  seq: r.seq,
  stage: r.stage,
  themeCode: r.theme_code,
  idempotencyKey: r.idempotency_key,
  modelAlias: r.model_alias,
  caps: r.caps as unknown as StageCaps,
  ceilingUsdcE6: BigInt(r.ceiling_usdc_e6),
  status: r.status,
  stopReason: r.stop_reason,
  runId: r.run_id,
  sessionId: r.session_id,
  outcome: r.outcome,
  modelCalls: r.model_calls,
  inputTokens: Number(r.input_tokens),
  outputTokens: Number(r.output_tokens),
  cacheReadTokens: Number(r.cache_read_tokens),
  cacheWriteTokens: Number(r.cache_write_tokens),
  chargedUsdcE6: BigInt(r.charged_usdc_e6),
  absorbedUsdcE6: BigInt(r.absorbed_usdc_e6),
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

/** Bounded JSON for a stored result: whole when small, otherwise its text cut at the bound. */
export function boundResult(result: unknown): { json: string; truncated: boolean } {
  const whole = JSON.stringify(result ?? null, (_k, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  if (whole.length <= MAX_RESULT_CHARS) return { json: whole, truncated: false };
  return {
    json: JSON.stringify({ truncatedText: whole.slice(0, MAX_RESULT_CHARS) }),
    truncated: true,
  };
}

export class CycleStore {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ---- cycles ----

  async createCycle(c: {
    ref: AgentRef;
    taskId: string;
    kind: CycleKind;
    reasoningAlias: string;
  }): Promise<Cycle> {
    const cycleId = `cycle-${randomUUID()}`;
    await this.db
      .insertInto("platform.research_cycles")
      .values({
        cycle_id: cycleId,
        chain_id: c.ref.chainId,
        agent_id: c.ref.agentId,
        task_id: c.taskId,
        kind: c.kind,
        status: "queued",
        reasoning_alias: c.reasoningAlias,
        canary: `AACANARY-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      })
      .execute();
    return (await this.cycle(cycleId)) as Cycle;
  }

  async cycle(cycleId: string): Promise<Cycle | null> {
    const r = await this.db
      .selectFrom("platform.research_cycles")
      .selectAll()
      .where("cycle_id", "=", cycleId)
      .executeTakeFirst();
    return r ? toCycle(r) : null;
  }

  async cycleForTask(taskId: string): Promise<Cycle | null> {
    const r = await this.db
      .selectFrom("platform.research_cycles")
      .selectAll()
      .where("task_id", "=", taskId)
      .executeTakeFirst();
    return r ? toCycle(r) : null;
  }

  async cycles(ref: AgentRef, limit = 10): Promise<Cycle[]> {
    const rows = await this.db
      .selectFrom("platform.research_cycles")
      .selectAll()
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
    return rows.map(toCycle);
  }

  /** An agent's cycle that is queued or running, if any: one at a time per agent. */
  async openCycle(ref: AgentRef): Promise<Cycle | null> {
    const r = await this.db
      .selectFrom("platform.research_cycles")
      .selectAll()
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .where("status", "in", ["queued", "running"])
      .executeTakeFirst();
    return r ? toCycle(r) : null;
  }

  async startCycle(cycleId: string, leaseId: string): Promise<void> {
    await this.db
      .updateTable("platform.research_cycles")
      .set({ status: "running", lease_id: leaseId, started_at: new Date() })
      .where("cycle_id", "=", cycleId)
      .execute();
  }

  /** Ends the cycle with its stop reason and totals its stages' charges. */
  async finishCycle(
    cycleId: string,
    status: "completed" | "stopped" | "failed",
    stopReason: string,
  ): Promise<void> {
    const totals = await this.db
      .selectFrom("platform.stage_runs")
      .select([
        sql<string | null>`sum(charged_usdc_e6)`.as("charged"),
        sql<string | null>`sum(absorbed_usdc_e6)`.as("absorbed"),
      ])
      .where("cycle_id", "=", cycleId)
      .executeTakeFirst();
    await this.db
      .updateTable("platform.research_cycles")
      .set({
        status,
        stop_reason: stopReason,
        charged_usdc_e6: totals?.charged ?? "0",
        absorbed_usdc_e6: totals?.absorbed ?? "0",
        finished_at: new Date(),
      })
      .where("cycle_id", "=", cycleId)
      .execute();
  }

  /**
   * At startup nothing of this process can be running yet: a cycle or stage
   * still marked running was cut off by a restart, so it ends as INTERRUPTED.
   */
  async failInterrupted(): Promise<number> {
    const stages = await this.db
      .updateTable("platform.stage_runs")
      .set({ status: "failed", stop_reason: "INTERRUPTED", finished_at: new Date() })
      .where("status", "=", "running")
      .executeTakeFirst();
    await this.db
      .updateTable("platform.research_cycles")
      .set({ status: "failed", stop_reason: "INTERRUPTED", finished_at: new Date() })
      .where("status", "=", "running")
      .execute();
    return Number(stages.numUpdatedRows);
  }

  // ---- stage runs ----

  async addStage(s: {
    cycle: Cycle;
    seq: number;
    stage: Stage;
    themeCode: string | null;
    modelAlias: string | null;
    caps: StageCaps;
    ceilingUsdcE6: bigint;
    status?: StageStatus;
    stopReason?: string | null;
  }): Promise<StageRun> {
    const stageRunId = `stage-run-${randomUUID()}`;
    const n = s.stage === "DIVE" ? `:${s.seq}` : "";
    await this.db
      .insertInto("platform.stage_runs")
      .values({
        stage_run_id: stageRunId,
        cycle_id: s.cycle.cycleId,
        chain_id: s.cycle.chainId,
        agent_id: s.cycle.agentId,
        seq: s.seq,
        stage: s.stage,
        theme_code: s.themeCode,
        idempotency_key: `${s.cycle.chainId}-${s.cycle.agentId}:${s.cycle.cycleId}:${s.stage}${n}`,
        model_alias: s.modelAlias,
        caps: JSON.stringify(s.caps),
        ceiling_usdc_e6: s.ceilingUsdcE6.toString(),
        status: s.status ?? "pending",
        stop_reason: s.stopReason ?? null,
        ...(s.status && s.status !== "pending" ? { finished_at: new Date() } : {}),
      })
      .execute();
    return (await this.stageRun(stageRunId)) as StageRun;
  }

  async stageRun(stageRunId: string): Promise<StageRun | null> {
    const r = await this.db
      .selectFrom("platform.stage_runs")
      .selectAll()
      .where("stage_run_id", "=", stageRunId)
      .executeTakeFirst();
    return r ? toStage(r as unknown as StageRow) : null;
  }

  async stages(cycleId: string): Promise<StageRun[]> {
    const rows = await this.db
      .selectFrom("platform.stage_runs")
      .selectAll()
      .where("cycle_id", "=", cycleId)
      .orderBy("seq")
      .execute();
    return rows.map((r) => toStage(r as unknown as StageRow));
  }

  /** Marks the stage running and makes it the lease's current stage, in one transaction. */
  async beginStage(
    stageRunId: string,
    leaseId: string | null,
    run: { runId?: string; sessionId?: string } = {},
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("platform.stage_runs")
        .set({
          status: "running",
          started_at: new Date(),
          ...(run.sessionId ? { session_id: run.sessionId } : {}),
        })
        .where("stage_run_id", "=", stageRunId)
        .execute();
      if (leaseId)
        await trx
          .updateTable("platform.sandbox_leases")
          .set({ stage_run_id: stageRunId })
          .where("lease_id", "=", leaseId)
          .execute();
    });
  }

  async setRunId(stageRunId: string, runId: string): Promise<void> {
    await this.db
      .updateTable("platform.stage_runs")
      .set({ run_id: runId })
      .where("stage_run_id", "=", stageRunId)
      .execute();
  }

  /**
   * Ends a stage: its status and reason, its outcome, and its token counts from
   * the gate's records. The lease then runs no stage until the next begins.
   */
  async endStage(
    stageRunId: string,
    leaseId: string | null,
    end: { status: StageStatus; stopReason: string; outcome?: Record<string, unknown> | null },
  ): Promise<void> {
    const u = await this.modelTotals(stageRunId);
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("platform.stage_runs")
        .set({
          status: end.status,
          stop_reason: end.stopReason,
          ...(end.outcome === undefined ? {} : { outcome: JSON.stringify(end.outcome) }),
          model_calls: u.calls,
          input_tokens: u.inputTokens,
          output_tokens: u.outputTokens,
          cache_read_tokens: u.cacheReadTokens,
          cache_write_tokens: u.cacheWriteTokens,
          finished_at: new Date(),
        })
        .where("stage_run_id", "=", stageRunId)
        .execute();
      if (leaseId)
        await trx
          .updateTable("platform.sandbox_leases")
          .set({ stage_run_id: null })
          .where("lease_id", "=", leaseId)
          .where("stage_run_id", "=", stageRunId)
          .execute();
    });
  }

  /** The stage run a lease is running now, or null outside a cycle stage. */
  async currentStage(leaseId: string): Promise<StageRun | null> {
    const lease = await this.db
      .selectFrom("platform.sandbox_leases")
      .select("stage_run_id")
      .where("lease_id", "=", leaseId)
      .executeTakeFirst();
    return lease?.stage_run_id ? this.stageRun(lease.stage_run_id) : null;
  }

  // ---- usage ----

  async modelTotals(stageRunId: string) {
    const r = await this.db
      .selectFrom("platform.model_calls")
      .select([
        sql<string>`count(*)`.as("calls"),
        sql<string | null>`sum(input_tokens)`.as("input"),
        sql<string | null>`sum(output_tokens)`.as("output"),
        sql<string | null>`sum(cache_read_tokens)`.as("cache_read"),
        sql<string | null>`sum(cache_write_tokens)`.as("cache_write"),
      ])
      .where("stage_run_id", "=", stageRunId)
      .executeTakeFirst();
    // Refused calls (402 at a cap) are recorded by the gate's log, not here: only forwarded calls count.
    return {
      calls: Number(r?.calls ?? 0),
      inputTokens: Number(r?.input ?? 0),
      outputTokens: Number(r?.output ?? 0),
      cacheReadTokens: Number(r?.cache_read ?? 0),
      cacheWriteTokens: Number(r?.cache_write ?? 0),
    };
  }

  /** Paid tool charges posted for a stage (reversed calls excluded). */
  async toolCharges(stageRunId: string): Promise<{ paidCalls: number; chargeUsdcE6: bigint }> {
    const r = await this.db
      .selectFrom("platform.tool_calls")
      .select([
        sql<string>`count(*) filter (where charge_usdc_e6 > 0)`.as("paid"),
        sql<string | null>`sum(charge_usdc_e6)`.as("charge"),
      ])
      .where("stage_run_id", "=", stageRunId)
      .where("status", "in", ["running", "succeeded"])
      .executeTakeFirst();
    return { paidCalls: Number(r?.paid ?? 0), chargeUsdcE6: BigInt(r?.charge ?? "0") };
  }

  /** Model charges metered for a stage so far: what the agent paid and what was absorbed. */
  async meteredModel(stageRunId: string): Promise<{ charged: bigint; absorbed: bigint }> {
    const r = await this.db
      .selectFrom("platform.usage_receipts")
      .select([
        sql<string | null>`sum(charge_usdc_e6)`.as("charged"),
        sql<string | null>`sum(absorbed_usdc_e6)`.as("absorbed"),
      ])
      .where("stage_run_id", "=", stageRunId)
      .executeTakeFirst();
    return { charged: BigInt(r?.charged ?? "0"), absorbed: BigInt(r?.absorbed ?? "0") };
  }

  /**
   * What a stage has used, as the gate checks it: forwarded model calls,
   * tokens, and its charge so far, its paid tools plus its model calls at
   * LiteLLM's cost plus the markup (an estimate until metering settles).
   */
  async gateStage(stage: StageRun): Promise<GateStage> {
    const calls = await this.db
      .selectFrom("platform.model_calls")
      .select(["input_tokens", "output_tokens", "cost_usd"])
      .where("stage_run_id", "=", stage.stageRunId)
      .execute();
    const tools = await this.toolCharges(stage.stageRunId);
    const model = calls.reduce((sum, c) => sum + chargeFor(usdToPicos(c.cost_usd)), 0n);
    return {
      stageRunId: stage.stageRunId,
      turns: stage.caps.turns,
      tokens: stage.caps.tokens,
      ceilingUsdcE6: stage.ceilingUsdcE6,
      used: {
        calls: calls.length,
        tokens: calls.reduce((n, c) => n + c.input_tokens + c.output_tokens, 0),
        chargeUsdcE6: tools.chargeUsdcE6 + model,
      },
    };
  }

  async recordModelCall(c: {
    ref: AgentRef;
    leaseId: string;
    stageRunId: string | null;
    model: string;
    status: number;
    usage: ModelUsage;
  }): Promise<void> {
    await this.db
      .insertInto("platform.model_calls")
      .values({
        request_id: c.usage.requestId,
        chain_id: c.ref.chainId,
        agent_id: c.ref.agentId,
        lease_id: c.leaseId,
        stage_run_id: c.stageRunId,
        model: c.model,
        status: c.status,
        input_tokens: c.usage.inputTokens,
        output_tokens: c.usage.outputTokens,
        cache_read_tokens: c.usage.cacheReadTokens,
        cache_write_tokens: c.usage.cacheWriteTokens,
        cost_usd: c.usage.costUsd,
      })
      .onConflict((oc) => oc.column("request_id").doNothing())
      .execute();
  }

  async modelCalls(stageRunId: string) {
    return this.db
      .selectFrom("platform.model_calls")
      .selectAll()
      .where("stage_run_id", "=", stageRunId)
      .orderBy("at")
      .execute();
  }

  /**
   * Settles a stage's charge after metering: what the agent paid for its
   * tools and model calls, and what the platform absorbed above its ceiling.
   */
  async settleStage(stageRunId: string): Promise<{ charged: bigint; absorbed: bigint }> {
    const tools = await this.toolCharges(stageRunId);
    const model = await this.meteredModel(stageRunId);
    const charged = tools.chargeUsdcE6 + model.charged;
    await this.db
      .updateTable("platform.stage_runs")
      .set({ charged_usdc_e6: charged.toString(), absorbed_usdc_e6: model.absorbed.toString() })
      .where("stage_run_id", "=", stageRunId)
      .execute();
    return { charged, absorbed: model.absorbed };
  }

  /**
   * What the day's research has used (D-293): charges of the agent's stages
   * that started today (UTC), with a running stage counted at its whole
   * ceiling, which it reserves until it ends.
   */
  async usedToday(ref: AgentRef, dayStart: Date): Promise<bigint> {
    const rows = await this.db
      .selectFrom("platform.stage_runs")
      .select(["stage_run_id", "status", "ceiling_usdc_e6", "charged_usdc_e6"])
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .where("started_at", ">=", dayStart)
      .execute();
    let used = 0n;
    for (const r of rows)
      used += r.status === "running" ? BigInt(r.ceiling_usdc_e6) : BigInt(r.charged_usdc_e6);
    return used;
  }

  /** Dives started today, and theme codes dived in the last 48 hours. */
  async diveHistory(ref: AgentRef, now: Date, dayStart: Date) {
    const rows = await this.db
      .selectFrom("platform.stage_runs")
      .select(["theme_code", "started_at"])
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .where("stage", "=", "DIVE")
      .where("started_at", ">=", new Date(now.getTime() - 48 * 3_600_000))
      .execute();
    return {
      divesToday: rows.filter((r) => r.started_at && r.started_at >= dayStart).length,
      recentlyDived: [...new Set(rows.map((r) => r.theme_code).filter((c): c is string => !!c))],
    };
  }

  // ---- tool results ----

  async storeResult(callId: string, stage: StageRun, tool: string, result: unknown) {
    const b = boundResult(result);
    await this.db
      .insertInto("platform.tool_results")
      .values({
        call_id: callId,
        cycle_id: stage.cycleId,
        stage_run_id: stage.stageRunId,
        tool,
        result: b.json,
        truncated: b.truncated,
      })
      .onConflict((oc) => oc.column("call_id").doNothing())
      .execute();
  }

  async results(cycleId: string): Promise<StoredResult[]> {
    const rows = await this.db
      .selectFrom("platform.tool_results")
      .select(["call_id", "stage_run_id", "tool", "result"])
      .where("cycle_id", "=", cycleId)
      .orderBy("created_at")
      .execute();
    return rows.map((r) => ({
      callId: r.call_id,
      stageRunId: r.stage_run_id,
      tool: r.tool,
      result: r.result,
    }));
  }

  /** URLs the cycle retrieved: pages it read, plus links search results returned. */
  async retrievedUrls(cycleId: string): Promise<string[]> {
    const urls = new Set<string>();
    for (const r of await this.results(cycleId)) {
      const res = r.result as Record<string, unknown> | null;
      if (!res) continue;
      if (r.tool === "read_url" && typeof res.url === "string") urls.add(res.url);
      if (Array.isArray(res.results))
        for (const hit of res.results as { url?: unknown }[])
          if (typeof hit?.url === "string") urls.add(hit.url);
      if (Array.isArray(res.posts))
        for (const p of res.posts as { url?: unknown }[])
          if (typeof p?.url === "string") urls.add(p.url);
    }
    return [...urls];
  }

  // ---- briefs ----

  async addBrief(b: {
    stage: StageRun;
    kind: string;
    status: "accepted" | "refused";
    body: unknown;
    reasons: readonly string[];
  }): Promise<string> {
    const briefId = `brief-${randomUUID()}`;
    await this.db
      .insertInto("platform.research_briefs")
      .values({
        brief_id: briefId,
        chain_id: b.stage.chainId,
        agent_id: b.stage.agentId,
        cycle_id: b.stage.cycleId,
        stage_run_id: b.stage.stageRunId,
        kind: b.kind as "SCAN",
        status: b.status,
        body: JSON.stringify(b.body ?? {}),
        reasons: JSON.stringify(b.reasons),
      })
      .execute();
    return briefId;
  }

  async briefs(
    filter: { cycleId?: string; stageRunId?: string; ref?: AgentRef; status?: "accepted" },
    limit = 50,
  ): Promise<BriefRow[]> {
    let q = this.db.selectFrom("platform.research_briefs").selectAll();
    if (filter.cycleId) q = q.where("cycle_id", "=", filter.cycleId);
    if (filter.stageRunId) q = q.where("stage_run_id", "=", filter.stageRunId);
    if (filter.ref)
      q = q.where("chain_id", "=", filter.ref.chainId).where("agent_id", "=", filter.ref.agentId);
    if (filter.status) q = q.where("status", "=", filter.status);
    const rows = await q.orderBy("created_at", "desc").limit(limit).execute();
    return rows.map((r) => ({
      briefId: r.brief_id,
      cycleId: r.cycle_id,
      stageRunId: r.stage_run_id,
      kind: r.kind,
      status: r.status,
      body: r.body,
      reasons: r.reasons,
      createdAt: r.created_at,
    }));
  }
}

function toCycle(r: {
  cycle_id: string;
  chain_id: number;
  agent_id: number;
  task_id: string;
  kind: CycleKind;
  status: Cycle["status"];
  stop_reason: string | null;
  reasoning_alias: string;
  lease_id: string | null;
  canary: string;
  charged_usdc_e6: string;
  absorbed_usdc_e6: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}): Cycle {
  return {
    cycleId: r.cycle_id,
    chainId: r.chain_id,
    agentId: r.agent_id,
    taskId: r.task_id,
    kind: r.kind,
    status: r.status,
    stopReason: r.stop_reason,
    reasoningAlias: r.reasoning_alias,
    leaseId: r.lease_id,
    canary: r.canary,
    chargedUsdcE6: BigInt(r.charged_usdc_e6),
    absorbedUsdcE6: BigInt(r.absorbed_usdc_e6),
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}
