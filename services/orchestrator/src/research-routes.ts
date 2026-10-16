import type { Hono } from "hono";
import { z } from "zod";
import { cycleJson, stageJson } from "./cycle-routes.ts";
import { cyclePlan } from "./cycle/cycle.ts";
import { type ReasoningAlias, isReasoningAlias, utcDayStart } from "./cycle/stages.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { type TerminalCall, carriesSkillText, sourceLabel, terminalEvents } from "./terminal.ts";
import { formatUsdc } from "./narrator.ts";
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

/** A brief's text as the owner may read it: withheld when it carries playbook text or a link. */
const safe = (v: unknown, runs: ReadonlySet<string>, max = 600): string => {
  if (typeof v !== "string") return "";
  const t = v.replace(/\s+/g, " ").trim().slice(0, max);
  if (carriesSkillText(t, runs)) return "[withheld: playbook text]";
  if (/https?:|www\./i.test(t)) return "[withheld: a link]";
  return t;
};

const claimsOf = (v: unknown, runs: ReadonlySet<string>) =>
  Array.isArray(v)
    ? (v as { text?: unknown; class?: unknown; sources?: unknown }[]).map((c) => ({
        text: safe(c.text, runs),
        class: typeof c.class === "string" ? c.class : "source",
        sources: Array.isArray(c.sources)
          ? c.sources.filter((x): x is string => typeof x === "string").map(sourceLabel)
          : [],
      }))
    : [];

const priceText = (e18: bigint | null) =>
  e18 === null ? null : (Number(e18) / 1e18).toFixed(Number(e18) / 1e18 >= 100 ? 0 : 2);

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
    const credits = orch.credits;
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
      // 2026-10-16: the credits a run may spend (above the reserve) and what a full owner run
      // needs, so a run stopped for credits can say both numbers.
      credits:
        goal && credits && isReasoningAlias(goal.config.model.alias)
          ? await (async () => {
              const spendable = (await credits.creditsOf(ref.agentId)).spendable;
              const available = spendable - BigInt(goal.config.creditReserveUsdcE6);
              return {
                availableUsdcE6: (available > 0n ? available : 0n).toString(),
                runNeedsUsdcE6: cyclePlan(
                  "ACTIVATION",
                  goal.config.model.alias as ReasoningAlias,
                  0,
                ).maxUsdcE6,
              };
            })()
          : null,
      open: open
        ? { ...cycleJson(open), stages: (await orch.cycles.stages(open.cycleId)).map(stageJson) }
        : null,
      ...(await researchRecords(orch, ref)),
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
      return c.json({
        agentId: String(ref.agentId),
        cycle: null,
        live: false,
        events: [],
        last: 0,
      });
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
    // P4-U2: the sentinel's actions in the cycle's window, so they show where they happened.
    const sentinel = await orch.sentinelStore.actionsBetween(
      ref,
      cycle.createdAt,
      cycle.finishedAt ?? new Date(),
    );
    // F-U12: the universe the cycle considered, for its own lines.
    const universe = await orch.universe.forCycle(cycle.cycleId);
    const usedBefore = usedToday > cycle.chargedUsdcE6 ? usedToday - cycle.chargedUsdcE6 : 0n;
    const events = terminalEvents({
      cycle,
      stages,
      calls: calls.map((r): TerminalCall => ({
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
      })),
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
      sentinel: sentinel.map((a) => ({
        code: a.code,
        action: a.action,
        state: a.state,
        reason: a.reason,
        txHash: a.txHash,
        status: a.status,
        createdAt: a.createdAt,
      })),
      universe: universe.map((u) => ({
        symbol: u.symbol,
        priceClass: u.priceClass,
        lane: u.lane,
        buyable: u.buyable,
        whyNot: u.whyNot,
        themeCode: u.themeCode,
        themeReason: u.themeReason,
        researched: u.researched,
        proposed: u.proposed,
        droppedReason: u.droppedReason,
      })),
      budget: goal
        ? {
            dailyUsdcE6: BigInt(goal.config.research.dailyBudgetUsdcE6),
            usedBeforeUsdcE6: usedBefore,
          }
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
    if (!body.success)
      return c.json({ error: "bad_request", message: "paused must be a boolean" }, 400);
    await orch.loop.update(ref, {
      paused: body.data.paused,
      waitingReason: null,
      waitingSince: null,
    });
    return c.json({ agentId: String(ref.agentId), paused: body.data.paused });
  });

  if (!o.canDrive) return;

  const Cadence = z.strictObject({ fast: z.boolean() });
  /** The fork's fast cadence: minutes instead of hours, so a playtest sees the loop run. */
  app.post("/v1/agents/:agentId/research/cadence", async (c) => {
    const ref = o.agentRef(c.req.param("agentId"));
    if (!ref) return c.json({ error: "bad_agent_id" }, 400);
    const body = Cadence.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success)
      return c.json({ error: "bad_request", message: "fast must be a boolean" }, 400);
    await orch.loop.update(ref, { fastCadence: body.data.fast });
    return c.json({ agentId: String(ref.agentId), fastCadence: body.data.fast });
  });

  /** Fires a trigger by hand, as the watcher would have; the next scheduler pass answers it. */
  app.post("/v1/agents/:agentId/research/triggers/:code", async (c) => {
    const ref = o.agentRef(c.req.param("agentId"));
    if (!ref) return c.json({ error: "bad_agent_id" }, 400);
    const code = c.req.param("code");
    if (!(TRIGGER_CODES as readonly string[]).includes(code))
      return c.json(
        { error: "bad_trigger", message: `code must be one of ${TRIGGER_CODES.join(", ")}` },
        400,
      );
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

  const Move = z.strictObject({ bps: z.int().min(-9_000).max(9_000) });
  /** The market mover (the local fork only): MON/USD by a share, so the watcher's price trigger can be seen. */
  app.post("/v1/dev/market/move", async (c) => {
    const body = Move.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success)
      return c.json(
        { error: "bad_request", message: "bps must be a whole number within 90% either way" },
        400,
      );
    try {
      return c.json({ bps: body.data.bps, ...(await orch.moveMarket(body.data.bps)) });
    } catch (err) {
      return c.json(
        { error: "mover_off", message: err instanceof Error ? err.message : String(err) },
        409,
      );
    }
  });

  /** One pass of the watcher and the scheduler now. */
  app.post("/v1/research/tick", async (c) => {
    try {
      return c.json(await orch.researchTick());
    } catch (err) {
      return c.json(
        { error: "research_off", message: err instanceof Error ? err.message : String(err) },
        409,
      );
    }
  });
}

/**
 * The Research page's records: the latest overview, the latest Scan's
 * themes, the last review that kept the plan, the recent cycles with their
 * stages' costs, and the watcher's snapshot of the market. Brief texts pass
 * the terminal's guard; sources show as domains and tool names.
 */
/** F-U12: a cycle's universe as the page reads it, or null when the cycle recorded none. */
async function universeJson(
  orch: Orchestrator,
  c: { cycleId: string; kind: string; startedAt: Date | null; createdAt: Date },
) {
  const rows = await orch.universe.forCycle(c.cycleId);
  if (rows.length === 0) return null;
  return {
    cycleId: c.cycleId,
    kind: c.kind,
    at: (c.startedAt ?? c.createdAt).toISOString(),
    rows: rows.map((u) => ({
      token: u.token,
      symbol: u.symbol,
      priceClass: u.priceClass,
      lane: u.lane,
      status: u.status,
      buyable: u.buyable,
      whyNot: u.whyNot,
      held: u.held,
      themeCode: u.themeCode,
      themeReason: u.themeReason,
      researched: u.researched,
      proposed: u.proposed,
      droppedReason: u.droppedReason,
    })),
  };
}

async function researchRecords(orch: Orchestrator, ref: { chainId: number; agentId: number }) {
  const runs = orch.skillText();
  const briefs = await orch.cycles.briefs({ ref, status: "accepted" }, 60);
  const overviewBrief = briefs.find((b) => b.kind === "OVERVIEW");
  const scanBrief = briefs.find((b) => b.kind === "SCAN");
  const noChange = briefs.find(
    (b) => b.kind === "RATIONALE" && (b.body as { decision?: unknown }).decision === "NO_CHANGE",
  );
  const cycles = await orch.cycles.cycles(ref, 10);
  const rows = await Promise.all(
    cycles.map(async (c) => ({
      cycleId: c.cycleId,
      kind: c.kind,
      status: c.status,
      startedAt: iso(c.startedAt),
      finishedAt: iso(c.finishedAt),
      chargedUsdcE6: c.chargedUsdcE6.toString(),
      // 2026-10-16: why a run stopped (CREDITS_SHORT, BUDGET_SHORT, ...), and at which stage.
      stopReason: c.stopReason,
      stages: (await orch.cycles.stages(c.cycleId)).map((s) => ({
        stage: s.stage,
        themeCode: s.themeCode,
        status: s.status,
        stopReason: s.stopReason,
        chargedUsdcE6: s.chargedUsdcE6.toString(),
        ceilingUsdcE6: s.ceilingUsdcE6.toString(),
      })),
    })),
  );
  const o = await orch.researchSnapshot(ref);
  // F-U12: the newest cycle's universe, for the "Universe considered" panel.
  let universe: Awaited<ReturnType<typeof universeJson>> = null;
  for (const c of cycles.slice(0, 3)) {
    universe = await universeJson(orch, c);
    if (universe) break;
  }
  const scanBody = scanBrief?.body as
    { summary?: unknown; quiet?: unknown; themes?: unknown } | undefined;
  const noChangeBody = noChange?.body as
    { reasonCode?: unknown; portfolioView?: unknown; whatWouldChangeIt?: unknown } | undefined;
  return {
    overview: overviewBrief
      ? {
          at: new Date(overviewBrief.createdAt).toISOString(),
          summary: safe((overviewBrief.body as { summary?: unknown }).summary, runs),
          points: claimsOf((overviewBrief.body as { points?: unknown }).points, runs),
        }
      : null,
    themes:
      scanBrief && scanBody
        ? {
            at: new Date(scanBrief.createdAt).toISOString(),
            summary: safe(scanBody.summary, runs),
            quiet: scanBody.quiet === true,
            themes: Array.isArray(scanBody.themes)
              ? (
                  scanBody.themes as {
                    code?: unknown;
                    materiality?: unknown;
                    scope?: unknown;
                    symbol?: unknown;
                    whyNow?: unknown;
                  }[]
                ).map((t) => ({
                  code: String(t.code ?? ""),
                  materiality: String(t.materiality ?? "low"),
                  scope: String(t.scope ?? "MARKET"),
                  symbol: typeof t.symbol === "string" ? t.symbol : null,
                  whyNow: safe(t.whyNow, runs, 240),
                }))
              : [],
          }
        : null,
    planUnchanged:
      noChange && noChangeBody
        ? {
            at: new Date(noChange.createdAt).toISOString(),
            reasonCode: String(noChangeBody.reasonCode ?? "NO_MATERIAL_CHANGE"),
            portfolioView: safe(noChangeBody.portfolioView, runs, 400),
            whatWouldChangeIt: safe(noChangeBody.whatWouldChangeIt, runs, 240),
          }
        : null,
    cycles: rows,
    universe,
    snapshot: o
      ? {
          at: o.at.toISOString(),
          monUsd: priceText(o.monUsdE18),
          volatilityPct: o.volatility24hPct,
          mode: o.mode,
          navUsdcE6: o.navUsdcE6 === null ? null : o.navUsdcE6.toString(),
          navUsdc: o.navUsdcE6 === null ? null : formatUsdc(o.navUsdcE6),
          held: o.held.map((h) => ({
            symbol: h.symbol,
            priceUsd: priceText(h.priceE18),
            liquidityUsd: h.liquidityUsd,
            screen: h.screenVerdict,
            status: h.registryStatus,
          })),
        }
      : null,
  };
}
