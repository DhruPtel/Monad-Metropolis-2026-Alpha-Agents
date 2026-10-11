import type { Hono } from "hono";
import { z } from "zod";
import { cycleJson, stageJson } from "./cycle-routes.ts";
import { utcDayStart } from "./cycle/stages.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { type TerminalCall, terminalEvents } from "./terminal.ts";
import {
  PRICE_TRIGGER_BPS,
  TRIGGER_CODES,
  TRIGGER_KIND,
  TRIGGER_TEXT,
  type TriggerCode,
  cadence,
} from "./research-loop.ts";

/**
 * The research loop's routes (P3-U10): an agent's schedule, cadence, budget
 * and the triggers the watcher fired, for the Research page; pause and
 * resume for the owner (through the control API) and the operator; and, for
 * the dev console on the local fork only, the fast cadence, a trigger fired
 * by hand and one pass of the loop now.
 */
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function registerResearchRoutes(
  app: Hono,
  o: {
    orchestrator: Orchestrator;
    chainId: number;
    agentRef: (raw: string) => { chainId: number; agentId: number } | null;
    /** Pause and resume: the owner through the control API, or the operator. */
    canAct: boolean;
    /** The fast cadence, triggers by hand and a pass now: the dev console only. */
    canDrive: boolean;
  },
): void {
  const orch = o.orchestrator;

  app.get("/v1/agents/:agentId/research", async (c) => {
    const ref = o.agentRef(c.req.param("agentId"));
    if (!ref) return c.json({ error: "bad_agent_id" }, 400);
    const goal = await orch.goals.currentGoal(ref.chainId, ref.agentId);
    const row = await orch.loop.schedule(ref);
    const last = await orch.cycles.lastStages(ref);
    const running = (await orch.loop.runningAgents(ref.chainId)).includes(ref.agentId);
    const now = new Date();
    const day = utcDayStart(now);
    const history = await orch.cycles.diveHistory(ref, now, day);
    const open = await orch.cycles.openCycle(ref);
    const cad = goal ? cadence(goal.config.research.intensity, row.fastCadence) : null;
    return c.json({
      agentId: String(ref.agentId),
      /** The loop runs for a RUNNING agent: an approved plan, armed. */
      running,
      schedulingOn: orch.schedulingOn,
      schedule: {
        paused: row.paused,
        fastCadence: row.fastCadence,
        lastScanAt: iso(last.scanAt ?? row.lastScanAt),
        lastZoomOutAt: iso(last.zoomOutAt ?? row.lastZoomOutAt),
        lastOverviewAt: iso(last.overviewAt ?? row.lastOverviewAt),
        lastTriggerCycleAt: iso(row.lastTriggerCycleAt),
        waitingReason: row.waitingReason,
        waitingSince: iso(row.waitingSince),
        nextDueAt: iso(row.nextDueAt),
        baselineTakenAt: row.baseline?.takenAt ?? null,
      },
      cadence:
        goal && cad
          ? {
              intensity: goal.config.research.intensity,
              aggressiveness: goal.config.aggressiveness,
              priceTriggerBps: PRICE_TRIGGER_BPS[goal.config.aggressiveness],
              positionTriggerBps: goal.config.envelope.reviewTriggerBps,
              scanEveryMs: cad.scanEveryMs,
              zoomOutEveryMs: cad.zoomOutEveryMs,
              overviewEveryMs: cad.overviewEveryMs,
              triggerSpacingMs: cad.triggerSpacingMs,
              watchEveryMs: cad.watchEveryMs,
              refreshesOverview: goal.config.research.intensity !== "LIGHT",
            }
          : null,
      budget: goal
        ? {
            dailyBudgetUsdcE6: String(goal.config.research.dailyBudgetUsdcE6),
            usedTodayUsdcE6: (await orch.cycles.usedToday(ref, day)).toString(),
            divesPerDay: goal.config.research.divesPerDay,
            divesToday: history.divesToday,
          }
        : null,
      open: open
        ? { ...cycleJson(open), stages: (await orch.cycles.stages(open.cycleId)).map(stageJson) }
        : null,
      triggers: (await orch.loop.recent(ref, 20)).map((t) => ({
        triggerId: t.triggerId,
        code: t.code,
        text: TRIGGER_TEXT[t.code] ?? t.code,
        kind: TRIGGER_KIND[t.code] ?? "REVIEW",
        detail: t.detail,
        firedAt: t.firedAt.toISOString(),
        cycleId: t.cycleId,
        spaced: t.spaced,
      })),
    });
  });

  /**
   * The agent terminal (P3-U10): a cycle's events as plain lines, the open
   * cycle by default (else the newest), from the sequence after `after`.
   * The control API serves it to the owner alone.
   */
  app.get("/v1/agents/:agentId/terminal", async (c) => {
    const ref = o.agentRef(c.req.param("agentId"));
    if (!ref) return c.json({ error: "bad_agent_id" }, 400);
    const wanted = c.req.query("cycleId") ?? null;
    if (wanted !== null && !/^cycle-[0-9a-f-]{36}$/.test(wanted))
      return c.json({ error: "bad_cycle_id" }, 400);
    const afterRaw = c.req.query("after") ?? "0";
    if (!/^\d{1,9}$/.test(afterRaw)) return c.json({ error: "bad_after" }, 400);
    const after = Number(afterRaw);
    const cycle = wanted
      ? await orch.cycles.cycle(wanted)
      : ((await orch.cycles.openCycle(ref)) ?? (await orch.cycles.cycles(ref, 1))[0] ?? null);
    if (!cycle || cycle.chainId !== ref.chainId || cycle.agentId !== ref.agentId)
      return c.json({ agentId: String(ref.agentId), cycle: null, live: false, events: [], last: 0 });
    const stages = await orch.cycles.stages(cycle.cycleId);
    const ids = stages.map((s) => s.stageRunId);
    const none = ["-"];
    const db = orch.loop.db;
    const [calls, briefs, records, proposals] = await Promise.all([
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
          "finished_at",
        ])
        .where("stage_run_id", "in", ids.length ? ids : none)
        .orderBy("started_at")
        .execute(),
      orch.cycles.briefs({ cycleId: cycle.cycleId }, 100),
      db
        .selectFrom("platform.stage_records")
        .select(["stage_run_id", "outcome", "decision", "created_at"])
        .where("stage_run_id", "in", ids.length ? ids : none)
        .execute(),
      orch.proposals.store.list(ref.chainId, ref.agentId, 20),
    ]);
    const goal = await orch.goals.currentGoal(ref.chainId, ref.agentId);
    const usedToday = await orch.cycles.usedToday(ref, utcDayStart(new Date()));
    const usedBefore = usedToday > cycle.chargedUsdcE6 ? usedToday - cycle.chargedUsdcE6 : 0n;
    const events = terminalEvents({
      cycle,
      stages,
      calls: calls.map(
        (r): TerminalCall => ({
          callId: r.call_id,
          stageRunId: r.stage_run_id,
          server: r.server,
          tool: r.tool,
          input: r.input,
          status: r.status,
          errorCode: r.error_code,
          chargeUsdcE6: r.charge_usdc_e6,
          cacheHit: r.cache_hit,
          summary: r.summary,
          startedAt: new Date(r.started_at),
          finishedAt: r.finished_at ? new Date(r.finished_at) : null,
        }),
      ),
      briefs: briefs.map((b) => ({
        stageRunId: b.stageRunId,
        kind: b.kind,
        status: b.status,
        body: b.body,
        reasons: b.reasons,
        createdAt: new Date(b.createdAt),
      })),
      records: records.map((r) => ({
        stageRunId: r.stage_run_id,
        outcome: r.outcome,
        decision: r.decision,
        createdAt: new Date(r.created_at),
      })),
      proposals: proposals
        .filter((p) => p.cycleId === cycle.cycleId)
        .map((p) => ({ status: p.status, evaluation: p.evaluation, createdAt: p.createdAt })),
      budget: goal
        ? { dailyUsdcE6: BigInt(goal.config.research.dailyBudgetUsdcE6), usedBeforeUsdcE6: usedBefore }
        : null,
      skillRuns: orch.skillText(),
    });
    return c.json({
      agentId: String(ref.agentId),
      cycle: cycleJson(cycle),
      live: cycle.status === "queued" || cycle.status === "running",
      events: events.filter((e) => e.seq > after),
      last: events.length,
    });
  });

  if (!o.canAct) return;

  const Pause = z.strictObject({ paused: z.boolean() });
  /** Pauses or resumes the agent's research loop; a running cycle finishes. */
  app.post("/v1/agents/:agentId/research/pause", async (c) => {
    const ref = o.agentRef(c.req.param("agentId"));
    if (!ref) return c.json({ error: "bad_agent_id" }, 400);
    const body = Pause.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "bad_request", message: "paused must be a boolean" }, 400);
    await orch.loop.update(ref, { paused: body.data.paused, waitingReason: null, waitingSince: null });
    return c.json({ agentId: String(ref.agentId), paused: body.data.paused });
  });

  if (!o.canDrive) return;

  const Cadence = z.strictObject({ fast: z.boolean() });
  /** The fork's fast cadence: minutes instead of hours, so a playtest sees the loop run. */
  app.post("/v1/agents/:agentId/research/cadence", async (c) => {
    const ref = o.agentRef(c.req.param("agentId"));
    if (!ref) return c.json({ error: "bad_agent_id" }, 400);
    const body = Cadence.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "bad_request", message: "fast must be a boolean" }, 400);
    await orch.loop.update(ref, { fastCadence: body.data.fast });
    return c.json({ agentId: String(ref.agentId), fastCadence: body.data.fast });
  });

  /** Fires a trigger by hand, as the watcher would have; the next scheduler pass answers it. */
  app.post("/v1/agents/:agentId/research/triggers/:code", async (c) => {
    const ref = o.agentRef(c.req.param("agentId"));
    if (!ref) return c.json({ error: "bad_agent_id" }, 400);
    const code = c.req.param("code");
    if (!(TRIGGER_CODES as readonly string[]).includes(code))
      return c.json({ error: "bad_trigger", message: `code must be one of ${TRIGGER_CODES.join(", ")}` }, 400);
    const row = await orch.loop.schedule(ref);
    const goal = await orch.goals.currentGoal(ref.chainId, ref.agentId);
    const spacing = goal
      ? cadence(goal.config.research.intensity, row.fastCadence).triggerSpacingMs
      : 2 * 3_600_000;
    const now = new Date();
    const spaced =
      row.lastTriggerCycleAt !== null && now.getTime() - row.lastTriggerCycleAt.getTime() < spacing;
    const triggerId = await orch.loop.recordTrigger(
      ref,
      { code: code as TriggerCode, detail: { by: "console" } },
      now,
      spaced,
    );
    return c.json({ agentId: String(ref.agentId), triggerId, code, spaced }, 202);
  });

  /** One pass of the watcher and the scheduler now. */
  app.post("/v1/research/tick", async (c) => {
    try {
      return c.json(await orch.researchTick());
    } catch (err) {
      return c.json({ error: "research_off", message: err instanceof Error ? err.message : String(err) }, 409);
    }
  });
}
