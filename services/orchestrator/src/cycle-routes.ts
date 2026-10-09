import type { Hono } from "hono";
import { z } from "zod";
import { cyclePlan } from "./cycle/cycle.ts";
import { CYCLE_KINDS, type ReasoningAlias, isReasoningAlias, utcDayStart } from "./cycle/stages.ts";
import type { Cycle, StageRun } from "./cycle/store.ts";
import {
  CreditsExhaustedError,
  CycleOpenError,
  NoGoalError,
  type Orchestrator,
} from "./orchestrator.ts";
import type { Store } from "./store.ts";

/**
 * The console's research cycle routes (P3-U4): start a routine or an
 * activation-shaped cycle, list an agent's cycles with what each stage may
 * cost before it runs, and read one cycle in full: each stage's model, caps,
 * cost against its ceiling, cache reads, model and tool calls, raw notes,
 * briefs (refused ones with their reasons) and records. Raw notes and refused
 * briefs are operator-only: the detail route exists only where operator
 * actions do, and the orchestrator's API is loopback-only (D-205).
 */
export const CycleRequest = z.strictObject({ kind: z.enum(CYCLE_KINDS).default("ROUTINE") });

const e6 = (v: bigint) => v.toString();

export const cycleJson = (c: Cycle) => ({
  cycleId: c.cycleId,
  taskId: c.taskId,
  kind: c.kind,
  status: c.status,
  stopReason: c.stopReason,
  reasoning: c.reasoningAlias,
  chargedUsdcE6: e6(c.chargedUsdcE6),
  absorbedUsdcE6: e6(c.absorbedUsdcE6),
  createdAt: c.createdAt.toISOString(),
  startedAt: c.startedAt?.toISOString() ?? null,
  finishedAt: c.finishedAt?.toISOString() ?? null,
});

export const stageJson = (s: StageRun) => ({
  stageRunId: s.stageRunId,
  seq: s.seq,
  stage: s.stage,
  themeCode: s.themeCode,
  model: s.modelAlias,
  caps: s.caps,
  ceilingUsdcE6: e6(s.ceilingUsdcE6),
  status: s.status,
  stopReason: s.stopReason,
  runId: s.runId,
  modelCalls: s.modelCalls,
  inputTokens: s.inputTokens,
  outputTokens: s.outputTokens,
  cacheReadTokens: s.cacheReadTokens,
  cacheWriteTokens: s.cacheWriteTokens,
  chargedUsdcE6: e6(s.chargedUsdcE6),
  absorbedUsdcE6: e6(s.absorbedUsdcE6),
  outcome: s.outcome,
  startedAt: s.startedAt?.toISOString() ?? null,
  finishedAt: s.finishedAt?.toISOString() ?? null,
});

export function registerCycleRoutes(
  app: Hono,
  o: {
    orchestrator: Orchestrator;
    store: Store;
    agentRef: (raw: string) => { chainId: number; agentId: number } | null;
    canStart: boolean;
  },
): void {
  const orch = o.orchestrator;

  /** An agent's recent cycles, and what a routine and an activation cycle may cost before either runs. */
  app.get("/v1/agents/:agentId/cycles", async (c) => {
    const ref = o.agentRef(c.req.param("agentId"));
    if (!ref) return c.json({ error: "bad_agent_id" }, 400);
    const goal = await orch.goals.currentGoal(ref.chainId, ref.agentId);
    const cycles = await orch.cycles.cycles(ref, 10);
    const now = new Date();
    const day = utcDayStart(now);
    const history = await orch.cycles.diveHistory(ref, now, day);
    const alias = goal?.config.model.alias ?? null;
    const reasoning: ReasoningAlias | null = alias && isReasoningAlias(alias) ? alias : null;
    const divesLeft = goal ? Math.max(0, goal.config.research.divesPerDay - history.divesToday) : 0;
    return c.json({
      agentId: String(ref.agentId),
      goal: goal
        ? {
            reasoning,
            intensity: goal.config.research.intensity,
            divesPerDay: goal.config.research.divesPerDay,
            dailyBudgetUsdcE6: String(goal.config.research.dailyBudgetUsdcE6),
            creditReserveUsdcE6: String(goal.config.creditReserveUsdcE6),
          }
        : null,
      today: {
        usedUsdcE6: e6(await orch.cycles.usedToday(ref, day)),
        divesToday: history.divesToday,
      },
      plans: reasoning
        ? {
            ROUTINE: cyclePlan("ROUTINE", reasoning, divesLeft),
            ACTIVATION: cyclePlan("ACTIVATION", reasoning, divesLeft),
          }
        : null,
      cycles: await Promise.all(
        cycles.map(async (cy) => ({
          ...cycleJson(cy),
          stages: (await orch.cycles.stages(cy.cycleId)).map(stageJson),
        })),
      ),
    });
  });

  if (!o.canStart) return;

  /** Starts a cycle now (local and testnet operators): 202 with its task and cycle. */
  app.post("/v1/agents/:agentId/cycles", async (c) => {
    const ref = o.agentRef(c.req.param("agentId"));
    if (!ref) return c.json({ error: "bad_agent_id" }, 400);
    const body = CycleRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success)
      return c.json({ error: "bad_request", message: "kind must be ROUTINE or ACTIVATION" }, 400);
    if (await o.store.activeLease(ref))
      return c.json(
        { error: "lease_held", message: `Agent ${ref.agentId} already has a sandbox running.` },
        409,
      );
    try {
      return c.json(await orch.enqueueCycle(ref, body.data.kind), 202);
    } catch (err) {
      if (err instanceof CreditsExhaustedError)
        return c.json({ error: "credits_exhausted", message: err.message }, 409);
      if (err instanceof NoGoalError)
        return c.json({ error: "no_goal", message: err.message }, 409);
      if (err instanceof CycleOpenError)
        return c.json({ error: "cycle_open", message: err.message }, 409);
      if (err instanceof Error && /not provisioned/.test(err.message))
        return c.json({ error: "not_provisioned", message: err.message }, 409);
      throw err;
    }
  });

  /** One cycle in full, for operators: every stage's records, calls, raw notes and briefs. */
  app.get("/v1/cycles/:cycleId", async (c) => {
    const cycleId = c.req.param("cycleId");
    if (!/^cycle-[0-9a-f-]{36}$/.test(cycleId)) return c.json({ error: "bad_cycle_id" }, 400);
    const cycle = await orch.cycles.cycle(cycleId);
    if (!cycle) return c.json({ error: "not_found" }, 404);
    const db = o.store.db;
    const stages = await orch.cycles.stages(cycleId);
    const ids = stages.map((s) => s.stageRunId);
    const none = ["-"];
    const [calls, notes, briefs, records, entries, models, results] = await Promise.all([
      db
        .selectFrom("platform.tool_calls")
        .select([
          "call_id",
          "stage_run_id",
          "server",
          "tool",
          "input",
          "status",
          "error_code",
          "charge_usdc_e6",
          "cache_hit",
          "summary",
          "started_at",
        ])
        .where("stage_run_id", "in", ids.length ? ids : none)
        .orderBy("started_at")
        .execute(),
      db
        .selectFrom("platform.thesis_notes")
        .select(["stage_run_id", "title", "notes", "sources", "created_at"])
        .where("stage_run_id", "in", ids.length ? ids : none)
        .orderBy("created_at")
        .execute(),
      orch.cycles.briefs({ cycleId }, 100),
      db
        .selectFrom("platform.stage_records")
        .select(["stage_run_id", "outcome", "candidates", "decision", "created_at"])
        .where("stage_run_id", "in", ids.length ? ids : none)
        .execute(),
      db
        .selectFrom("platform.activity_entries")
        .select(["task_id", "text", "rendered_by"])
        .where("task_id", "in", ids.length ? ids : none)
        .execute(),
      db
        .selectFrom("platform.model_calls")
        .selectAll()
        .where("stage_run_id", "in", ids.length ? ids : none)
        .orderBy("at")
        .execute(),
      db
        .selectFrom("platform.tool_results")
        .select(["call_id", "truncated"])
        .where("cycle_id", "=", cycleId)
        .execute(),
    ]);
    const stored = new Map(results.map((r) => [r.call_id, r.truncated]));
    return c.json({
      cycle: cycleJson(cycle),
      stages: stages.map((s) => ({
        ...stageJson(s),
        entry: entries.find((e) => e.task_id === s.stageRunId) ?? null,
        record: records.find((r) => r.stage_run_id === s.stageRunId) ?? null,
        modelCallRecords: models
          .filter((m) => m.stage_run_id === s.stageRunId)
          .map((m) => ({
            requestId: m.request_id,
            model: m.model,
            status: m.status,
            inputTokens: m.input_tokens,
            outputTokens: m.output_tokens,
            cacheReadTokens: m.cache_read_tokens,
            cacheWriteTokens: m.cache_write_tokens,
            costUsd: m.cost_usd,
            at: new Date(m.at).toISOString(),
          })),
        toolCalls: calls
          .filter((t) => t.stage_run_id === s.stageRunId)
          .map((t) => ({
            callId: t.call_id,
            server: t.server,
            tool: t.tool,
            input: t.input,
            status: t.status,
            errorCode: t.error_code,
            chargeUsdcE6: t.charge_usdc_e6,
            cacheHit: t.cache_hit,
            summary: t.summary,
            resultStored: stored.has(t.call_id),
            resultTruncated: stored.get(t.call_id) ?? false,
            startedAt: new Date(t.started_at).toISOString(),
          })),
        notes: notes
          .filter((n) => n.stage_run_id === s.stageRunId)
          .map((n) => ({
            title: n.title,
            notes: n.notes,
            sources: n.sources,
            at: new Date(n.created_at).toISOString(),
          })),
        briefs: briefs
          .filter((b) => b.stageRunId === s.stageRunId)
          .reverse()
          .map((b) => ({
            briefId: b.briefId,
            kind: b.kind,
            status: b.status,
            body: b.body,
            reasons: b.reasons,
            at: b.createdAt.toISOString(),
          })),
      })),
    });
  });
}
