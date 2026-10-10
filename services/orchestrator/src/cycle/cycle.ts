import type { GoalStore, PlanStore } from "@alpha-agents/trading";
import { isBandsPlan, isPortfolioPlan } from "@alpha-agents/trading";
import type { CreditService } from "../credits/service.ts";
import { type GateLogEntry, modelFailure } from "../gate.ts";
import type { AgentConfig } from "../hermes/schema.ts";
import type { Narrator } from "../narrator.ts";
import { type AgentSandbox, type TaskContext, openAgentSandbox, skillsLoaded } from "../noop.ts";
import { errorText } from "../secrets.ts";
import { type AgentRef, LeaseHeldError } from "../store.ts";
import { cycleConfig, stagePrompt } from "./config.ts";
import type { CycleResearch } from "./research.ts";
import {
  type CycleKind,
  type ReasoningAlias,
  type ScanTheme,
  type Stage,
  divesFor,
  isReasoningAlias,
  stageCaps,
  stageCeilingUsdcE6,
  stageMayStart,
  stageModel,
  utcDayStart,
} from "./stages.ts";
import type { Cycle, CycleStore, StageRun, StageStatus } from "./store.ts";
import { portfolioEnvelope, testEnvelope } from "./test-stage.ts";

/**
 * The discovery loop engine (P3-U4, D-093): one research cycle in one sandbox
 * under one lease. In order: Scan; a Dive on each theme the Scan flags,
 * within the intensity's limits, one after another; the Challenge, which sees
 * only the Dives' briefs; the deterministic Test; the Zoom out. Each model
 * stage is its own Hermes run in a fresh session on its own model, with its
 * caps and ceiling; a stage starts only when the day's research budget and
 * the agent's credits cover its whole ceiling. A routine cycle stops after
 * the Scan when nothing earns a Dive. Every transition is recorded, every
 * stage gets the narrator's entry, and nothing in a cycle trades: a Zoom
 * out's proposal is a draft for P3-U6.
 */
export interface CycleContext extends TaskContext {
  readonly cycles: CycleStore;
  readonly research: CycleResearch;
  readonly goals: GoalStore;
  readonly plans: PlanStore;
  readonly credits: CreditService;
  readonly narrator: Narrator | null;
  /** How long to wait for metering to settle a stage's model calls (tests shorten it). */
  readonly settleMs?: number;
  /** How long a cycle waits for another task's lease on the agent to end (10 minutes). */
  readonly leaseWaitMs?: number;
  /** A stage's deadline; its caps' seconds unless a test shortens it. */
  readonly deadlineMs?: (run: StageRun) => number;
  readonly now?: () => Date;
}

/** The cycle's lease: every stage's deadline plus time to boot and settle. */
export function cycleLeaseMs(kind: CycleKind, dives: number): number {
  const s = (stage: Stage) => stageCaps(stage, kind).seconds * 1_000;
  return s("SCAN") + dives * s("DIVE") + s("CHALLENGE") + s("ZOOM_OUT") + 15 * 60_000;
}

/** The most a cycle can charge, shown before it starts: each stage's ceiling, Dives at their limit. */
export function cyclePlan(kind: CycleKind, reasoning: ReasoningAlias, divesLeft: number) {
  const dives = kind === "ACTIVATION" ? 2 : Math.max(0, divesLeft);
  const stages = [
    { stage: "SCAN" as const, count: 1 },
    { stage: "DIVE" as const, count: dives },
    { stage: "CHALLENGE" as const, count: dives > 0 ? 1 : 0 },
    { stage: "TEST" as const, count: 1 },
    { stage: "ZOOM_OUT" as const, count: 1 },
  ].map((x) => ({
    ...x,
    model: stageModel(x.stage, reasoning),
    caps: stageCaps(x.stage, kind),
    ceilingUsdcE6: stageCeilingUsdcE6(x.stage, kind, reasoning).toString(),
  }));
  const max = stages.reduce((sum, x) => sum + BigInt(x.ceilingUsdcE6) * BigInt(x.count), 0n);
  return { kind, reasoning, stages, maxUsdcE6: max.toString() };
}

const POLL_MS = 1_500;
/** Follow-up turns for a stage whose run ended before complete_stage. */
export const MAX_REPAIRS = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StageEnd {
  status: StageStatus;
  stopReason: string;
}

export async function runCycleTask(ctx: CycleContext, taskId: string): Promise<void> {
  const task = await ctx.store.task(taskId);
  if (!task || !(await ctx.store.startTask(taskId))) return;
  const cycle = await ctx.cycles.cycleForTask(taskId);
  if (!cycle) {
    await ctx.store.finishTask(taskId, { error: "no research cycle recorded for this task" });
    return;
  }
  const ref: AgentRef = { chainId: task.chainId, agentId: task.agentId };
  const started = Date.now();
  let leaseId: string | null = null;
  let opened: AgentSandbox | null = null;
  try {
    const goal = await ctx.goals.currentGoal(ref.chainId, ref.agentId);
    if (!goal) throw new Error("the agent has no goal: its owner sets one on the Goal page first");
    const reasoning = cycle.reasoningAlias;
    if (!isReasoningAlias(reasoning)) throw new Error(`unknown reasoning model ${reasoning}`);
    const { divesToday } = await ctx.cycles.diveHistory(ref, now(ctx), utcDayStart(now(ctx)));
    const divesLeft = Math.max(0, goal.config.research.divesPerDay - divesToday);
    const leaseMs = cycleLeaseMs(cycle.kind, cycle.kind === "ACTIVATION" ? 2 : divesLeft);

    // The Scan's ceiling must fit before anything starts, so no sandbox opens for nothing.
    const first = await budgetCheck(ctx, cycle, "SCAN", goal.config);
    if (!first.ok) {
      await ctx.cycles.addStage({
        cycle,
        seq: 1,
        stage: "SCAN",
        themeCode: null,
        modelAlias: stageModel("SCAN", reasoning),
        caps: stageCaps("SCAN", cycle.kind),
        ceilingUsdcE6: stageCeilingUsdcE6("SCAN", cycle.kind, reasoning),
        status: "skipped",
        stopReason: first.code,
      });
      await ctx.cycles.finishCycle(cycle.cycleId, "stopped", first.code);
      await ctx.store.finishTask(taskId, {
        error: first.message,
        result: await summary(ctx, cycle.cycleId),
      });
      ctx.log(`task ${taskId}: cycle ${cycle.cycleId} did not start: ${first.code}`);
      return;
    }

    // A scheduled Scan may hold the agent's one lease (D-216): the cycle waits for it to end.
    const waitUntil = Date.now() + (ctx.leaseWaitMs ?? 10 * 60_000);
    for (;;) {
      try {
        opened = await openAgentSandbox(
          ctx,
          taskId,
          ref,
          "cycle",
          leaseMs,
          (id) => {
            leaseId = id;
          },
          (stored: AgentConfig) =>
            cycleConfig(stored, {
              kind: cycle.kind,
              goalBlock: goal.soulBlock,
              canary: cycle.canary,
            }),
        );
        break;
      } catch (err) {
        if (!(err instanceof LeaseHeldError) || Date.now() >= waitUntil) throw err;
        await sleep(5_000);
      }
    }
    leaseId = opened.leaseId;
    await ctx.cycles.startCycle(cycle.cycleId, opened.leaseId);
    ctx.log(`task ${taskId}: cycle ${cycle.cycleId} (${cycle.kind}) started on ${reasoning}`);

    const engine = new Engine(ctx, cycle, opened, reasoning, goal.config);
    const stop = await engine.run();
    await ctx.leases.release(opened.leaseId, "cycle finished");
    leaseId = null;
    await engine.settleAll();
    await ctx.cycles.finishCycle(cycle.cycleId, stop.status, stop.reason);
    const result = await summary(ctx, cycle.cycleId, opened);
    if (stop.status === "failed")
      await ctx.store.finishTask(taskId, { error: stop.message ?? stop.reason, result });
    else await ctx.store.finishTask(taskId, { result });
    ctx.log(
      `task ${taskId}: cycle ${cycle.cycleId} ${stop.status} (${stop.reason}) in ${Date.now() - started} ms`,
    );
  } catch (err) {
    const message = errorText(err, ctx.redactor);
    if (leaseId) await ctx.leases.release(leaseId, "cycle failed");
    await ctx.cycles.finishCycle(cycle.cycleId, "failed", "FAILED");
    const result = await summary(ctx, cycle.cycleId, opened).catch(() => null);
    await ctx.store.finishTask(taskId, result ? { error: message, result } : { error: message });
    ctx.log(`task ${taskId}: cycle failed: ${message}`);
  }
}

const now = (ctx: CycleContext) => ctx.now?.() ?? new Date();

type GoalConfig = NonNullable<Awaited<ReturnType<GoalStore["currentGoal"]>>>["config"];

async function budgetCheck(ctx: CycleContext, cycle: Cycle, stage: Stage, goal: GoalConfig) {
  const ref = { chainId: cycle.chainId, agentId: cycle.agentId };
  const credits = await ctx.credits.creditsOf(cycle.agentId);
  return stageMayStart({
    ceilingUsdcE6: stageCeilingUsdcE6(stage, cycle.kind, cycle.reasoningAlias as ReasoningAlias),
    dailyBudgetUsdcE6: BigInt(goal.research.dailyBudgetUsdcE6),
    usedTodayUsdcE6: await ctx.cycles.usedToday(ref, utcDayStart(now(ctx))),
    spendableUsdcE6: credits.spendable,
    creditReserveUsdcE6: BigInt(goal.creditReserveUsdcE6),
  });
}

/** One cycle's stages, run in order inside its open sandbox. */
class Engine {
  private seq = 0;
  private readonly ctx: CycleContext;
  private readonly cycle: Cycle;
  private readonly sbx: AgentSandbox;
  private readonly reasoning: ReasoningAlias;
  private readonly goal: GoalConfig;

  constructor(
    ctx: CycleContext,
    cycle: Cycle,
    sbx: AgentSandbox,
    reasoning: ReasoningAlias,
    goal: GoalConfig,
  ) {
    this.ctx = ctx;
    this.cycle = cycle;
    this.sbx = sbx;
    this.reasoning = reasoning;
    this.goal = goal;
  }

  private ref(): AgentRef {
    return { chainId: this.cycle.chainId, agentId: this.cycle.agentId };
  }

  async run(): Promise<{
    status: "completed" | "stopped" | "failed";
    reason: string;
    message?: string;
  }> {
    const kind = this.cycle.kind;
    const scan = await this.modelStage("SCAN", null);
    if (
      scan.end.status === "stopped" ||
      scan.end.status === "failed" ||
      scan.end.status === "skipped"
    )
      return this.halt(scan.end);
    const hasScanBrief = await this.hasBrief(scan.run, "SCAN");
    // A Scan stopped at a cap before its brief ends the cycle with that cap.
    if (scan.end.status === "capped" && !hasScanBrief)
      return { status: "stopped", reason: scan.end.stopReason };
    const themes = await this.scanThemes(scan.run);
    const now = this.ctx.now?.() ?? new Date();
    const history = await this.ctx.cycles.diveHistory(this.ref(), now, utcDayStart(now));
    const dives = divesFor({
      kind,
      themes,
      divesPerDay: this.goal.research.divesPerDay,
      divesToday: history.divesToday,
      recentlyDived: history.recentlyDived,
    });
    if (dives.length === 0 && kind !== "ACTIVATION")
      return { status: "completed", reason: "NOTHING_MATERIAL" };

    const dived: string[] = [];
    for (const theme of dives) {
      const dive = await this.modelStage("DIVE", theme.code, [], theme);
      if (
        dive.end.status === "stopped" ||
        dive.end.status === "failed" ||
        dive.end.status === "skipped"
      )
        return this.halt(dive.end);
      if (await this.hasBrief(dive.run, "THEME")) dived.push(theme.code);
    }
    if (dived.length > 0) {
      const challenge = await this.modelStage("CHALLENGE", null, dived);
      if (
        challenge.end.status === "stopped" ||
        challenge.end.status === "failed" ||
        challenge.end.status === "skipped"
      )
        return this.halt(challenge.end);
    } else if (dives.length > 0) await this.skip("CHALLENGE", "NOTHING_MATERIAL");

    await this.testStage();
    const zoom = await this.modelStage("ZOOM_OUT", null);
    if (
      zoom.end.status === "stopped" ||
      zoom.end.status === "failed" ||
      zoom.end.status === "skipped"
    )
      return this.halt(zoom.end);
    return {
      status: "completed",
      reason: zoom.end.status === "capped" ? zoom.end.stopReason : "COMPLETED",
    };
  }

  private halt(end: StageEnd) {
    const failed = end.status === "failed";
    return {
      status: failed ? ("failed" as const) : ("stopped" as const),
      reason: end.stopReason,
      ...(failed ? { message: `a stage failed: ${end.stopReason}` } : {}),
    };
  }

  private async skip(stage: Stage, reason: string): Promise<void> {
    this.seq += 1;
    const run = await this.ctx.cycles.addStage({
      cycle: this.cycle,
      seq: this.seq,
      stage,
      themeCode: null,
      modelAlias: stageModel(stage, this.reasoning),
      caps: stageCaps(stage, this.cycle.kind),
      ceilingUsdcE6: stageCeilingUsdcE6(stage, this.cycle.kind, this.reasoning),
      status: "skipped",
      stopReason: reason,
    });
    await this.narrate(run);
  }

  /** The deterministic Test (D-282): the envelope the Zoom out may change the plan within. */
  private async testStage(): Promise<void> {
    this.seq += 1;
    const run = await this.ctx.cycles.addStage({
      cycle: this.cycle,
      seq: this.seq,
      stage: "TEST",
      themeCode: null,
      modelAlias: null,
      caps: stageCaps("TEST", this.cycle.kind),
      ceilingUsdcE6: 0n,
    });
    await this.ctx.cycles.beginStage(run.stageRunId, null);
    try {
      const inputs = await this.ctx.research.testInputs(this.cycle);
      const plan = await this.ctx.plans.active(this.cycle.chainId, this.cycle.agentId);
      const envelope = testEnvelope(plan && isBandsPlan(plan) ? plan.params : null, inputs);
      // F-U6: on the fund agent's set the Zoom out may draft a target portfolio within this.
      const inputsV2 = await this.ctx.research.portfolioTestInputs(this.cycle);
      const portfolio = inputsV2
        ? portfolioEnvelope(plan && isPortfolioPlan(plan) ? plan.params : null, inputsV2)
        : null;
      await this.ctx.cycles.endStage(run.stageRunId, null, {
        status: "completed",
        stopReason: "COMPLETED",
        outcome: { envelope, ...(portfolio ? { portfolio } : {}), checked: [] },
      });
    } catch (err) {
      await this.ctx.cycles.endStage(run.stageRunId, null, {
        status: "failed",
        stopReason: "FAILED",
        outcome: { error: errorText(err, this.ctx.redactor) },
      });
    }
    await this.narrate((await this.ctx.cycles.stageRun(run.stageRunId)) as StageRun);
  }

  /** One model stage: budget, run on its model with its caps, then its end and charge. */
  private async modelStage(
    stage: Exclude<Stage, "TEST">,
    themeCode: string | null,
    diveThemes: readonly string[] = [],
    theme: ScanTheme | null = null,
  ): Promise<{ run: StageRun; end: StageEnd }> {
    this.seq += 1;
    const kind = this.cycle.kind;
    const caps = stageCaps(stage, kind);
    const ceiling = stageCeilingUsdcE6(stage, kind, this.reasoning);
    const model = stageModel(stage, this.reasoning) as string;
    const check = await budgetCheck(this.ctx, this.cycle, stage, this.goal);
    if (!check.ok) {
      const run = await this.ctx.cycles.addStage({
        cycle: this.cycle,
        seq: this.seq,
        stage,
        themeCode,
        modelAlias: model,
        caps,
        ceilingUsdcE6: ceiling,
        status: "skipped",
        stopReason: check.code,
      });
      await this.narrate(run);
      return { run, end: { status: "skipped", stopReason: check.code } };
    }
    const run = await this.ctx.cycles.addStage({
      cycle: this.cycle,
      seq: this.seq,
      stage,
      themeCode,
      modelAlias: model,
      caps,
      ceilingUsdcE6: ceiling,
    });
    const agent = `${this.cycle.chainId}-${this.cycle.agentId}`;
    const sessionId = `${agent}-${this.cycle.cycleId.slice(6, 14)}-${stage.toLowerCase()}-${this.seq}`;
    const lease = this.sbx.leaseId;
    await this.ctx.cycles.beginStage(run.stageRunId, lease, { sessionId });
    const prompt = stagePrompt({
      stage,
      kind,
      themeCode,
      token: theme?.token ? { address: theme.token, symbol: theme.symbol } : null,
      caps,
      ceilingUsdcE6: ceiling,
      diveThemes,
    });
    let end: StageEnd;
    try {
      const deadline = Date.now() + (this.ctx.deadlineMs?.(run) ?? run.caps.seconds * 1_000);
      const started = await this.sbx.runs.start(run.idempotencyKey, prompt, sessionId, model);
      await this.ctx.cycles.setRunId(run.stageRunId, started.runId);
      end = await this.watch(run, started.runId, deadline);
      // A run that ended before its terminal call gets a follow-up turn in the same session
      // saying what is missing (a refused brief's reasons), inside the same caps and deadline.
      for (
        let n = 1;
        n <= MAX_REPAIRS && end.stopReason === "NO_STAGE_RECORD" && Date.now() < deadline;
        n += 1
      ) {
        const repair = await this.repairPrompt(run);
        this.ctx.log(
          `cycle ${this.cycle.cycleId}: ${stage} ended without complete_stage; follow-up turn ${n}`,
        );
        const again = await this.sbx.runs.start(
          `${run.idempotencyKey}:repair:${n}`,
          repair,
          sessionId,
          model,
        );
        await this.ctx.cycles.setRunId(run.stageRunId, again.runId);
        end = await this.watch(run, again.runId, deadline);
      }
    } catch (err) {
      this.ctx.log(
        `cycle ${this.cycle.cycleId}: ${stage} failed: ${errorText(err, this.ctx.redactor)}`,
      );
      end = { status: "failed", stopReason: "FAILED" };
    }
    const loaded = await skillsLoaded(this.sbx.sbx).catch(() => []);
    const record = await this.ctx.store.db
      .selectFrom("platform.stage_records")
      .select(["outcome", "candidates", "decision"])
      .where("stage_run_id", "=", run.stageRunId)
      .executeTakeFirst();
    const callCap = await this.ctx.store.db
      .selectFrom("platform.tool_calls")
      .select("call_id")
      .where("stage_run_id", "=", run.stageRunId)
      .where("error_code", "in", ["STAGE_CALL_CAP", "STAGE_CEILING"])
      .executeTakeFirst();
    await this.ctx.cycles.endStage(run.stageRunId, lease, {
      ...end,
      outcome: {
        stageRecord: record
          ? { outcome: record.outcome, candidates: record.candidates, decision: record.decision }
          : null,
        skillsLoaded: loaded,
        capsHit: callCap ? ["CALL_CAP"] : [],
      },
    });
    await this.settle(run.stageRunId);
    const final = (await this.ctx.cycles.stageRun(run.stageRunId)) as StageRun;
    await this.narrate(final);
    this.ctx.log(
      `cycle ${this.cycle.cycleId}: ${stage}${themeCode ? ` ${themeCode}` : ""} ${end.status} (${end.stopReason}) on ${model}`,
    );
    return { run: final, end };
  }

  /**
   * Waits for the run: complete_stage ends it; a cap the gate enforced, the
   * deadline, or credits running out stop it, with that reason.
   */
  /** What a stage that ended early still has to do, from its own records. */
  private async repairPrompt(run: StageRun): Promise<string> {
    const briefs = await this.ctx.cycles.briefs({ stageRunId: run.stageRunId });
    const accepted = briefs.some((b) => b.status === "accepted");
    const refused = briefs.find((b) => b.status === "refused");
    const finish = `then call mcp__platform__complete_stage with stage ${run.stage}${run.stage === "ZOOM_OUT" ? " and your decision" : ""}. Do not research further.`;
    if (accepted)
      return `Your ${run.stage} brief was accepted but the stage is not finished: ${finish}`;
    if (refused)
      return `Your ${run.stage} brief was refused and the stage is not finished. Fix every point and call mcp__platform__write_research_brief again: ${refused.reasons.join("; ")}. Write each figure exactly as a tool returned it, or leave it out; ${finish}`;
    return `The ${run.stage} stage is not finished: write its brief with mcp__platform__write_research_brief now from what you have found, ${finish}`;
  }

  private async watch(run: StageRun, runId: string, deadline: number): Promise<StageEnd> {
    const capOf = (e: GateLogEntry) =>
      e.stageRunId === run.stageRunId &&
      (e.reason === "TURN_CAP" || e.reason === "TOKEN_CAP" || e.reason === "CEILING")
        ? e.reason
        : null;
    for (;;) {
      const state = await this.sbx.runs.get(runId).catch(() => null);
      const gated = this.ctx.gate.log.filter((e) => e.stageRunId === run.stageRunId);
      const cap = gated.map(capOf).find((r) => r !== null) ?? null;
      const recorded = await this.recorded(run);
      const terminal = state && TERMINAL.has(state.status);
      if (terminal || cap || Date.now() >= deadline) {
        if (!terminal) await this.sbx.runs.stop(runId).catch(() => undefined);
        if (recorded) return { status: "completed", stopReason: "COMPLETED" };
        if (cap) return { status: "capped", stopReason: cap };
        if (!terminal) return { status: "capped", stopReason: "DEADLINE" };
        const calls = this.ctx.gate
          .callsFor(this.sbx.leaseId)
          .filter((e) => e.stageRunId === run.stageRunId);
        if (calls.some((c) => c.status === 402 && !c.reason))
          return { status: "stopped", stopReason: "BILLING" };
        if ((await this.ctx.credits.creditsOf(this.cycle.agentId)).restricted)
          return { status: "stopped", stopReason: "BILLING" };
        const failure = modelFailure(calls);
        if (failure) this.ctx.log(`cycle ${this.cycle.cycleId}: ${run.stage}: ${failure}`);
        return {
          status: "failed",
          stopReason: failure?.includes("provider") ? "PROVIDER_OUT_OF_CREDIT" : "NO_STAGE_RECORD",
        };
      }
      await sleep(POLL_MS);
    }
  }

  private async recorded(run: StageRun): Promise<boolean> {
    const r = await this.ctx.store.db
      .selectFrom("platform.stage_records")
      .select("stage_id")
      .where("stage_run_id", "=", run.stageRunId)
      .executeTakeFirst();
    return r !== undefined;
  }

  private async hasBrief(run: StageRun, kind: string): Promise<boolean> {
    return (await this.ctx.cycles.briefs({ stageRunId: run.stageRunId, status: "accepted" })).some(
      (b) => b.kind === kind,
    );
  }

  /** The themes of the Scan's accepted brief, with any candidate complete_stage named. */
  private async scanThemes(run: StageRun): Promise<ScanTheme[]> {
    const briefs = await this.ctx.cycles.briefs({ stageRunId: run.stageRunId, status: "accepted" });
    const scan = briefs.find((b) => b.kind === "SCAN");
    const themes = ((scan?.body as { themes?: ScanTheme[] } | undefined)?.themes ?? []).map(
      (t) => ({
        code: t.code,
        materiality: t.materiality,
        scope: t.scope ?? "MARKET",
        token: t.token ?? null,
        symbol: t.symbol ?? null,
      }),
    );
    return themes;
  }

  /**
   * Waits for metering to settle the stage's model calls (L-17: spend logs
   * arrive in batches), then records the stage's charge. Until then the
   * stage counts at its gate estimate, capped at its ceiling.
   */
  private async settle(stageRunId: string): Promise<void> {
    const run = (await this.ctx.cycles.stageRun(stageRunId)) as StageRun;
    const estimate = (await this.ctx.cycles.gateStage(run)).used.chargeUsdcE6;
    await this.ctx.cycles.db
      .updateTable("platform.stage_runs")
      .set({
        charged_usdc_e6: (estimate < run.ceilingUsdcE6 ? estimate : run.ceilingUsdcE6).toString(),
      })
      .where("stage_run_id", "=", stageRunId)
      .execute();
    const until = Date.now() + (this.ctx.settleMs ?? 90_000);
    for (;;) {
      const calls = await this.ctx.cycles.modelCalls(stageRunId);
      const metered =
        calls.length === 0
          ? []
          : await this.ctx.store.db
              .selectFrom("platform.usage_receipts")
              .select("request_id")
              .where(
                "request_id",
                "in",
                calls.map((c) => c.request_id),
              )
              .execute();
      if (metered.length >= calls.length || Date.now() >= until) break;
      await this.ctx.credits.meter(this.cycle.agentId).catch(() => 0);
      await sleep(2_000);
    }
    await this.ctx.cycles.settleStage(stageRunId);
  }

  /** Settles every stage again at the end, for calls metered after their stage's wait. */
  async settleAll(): Promise<void> {
    for (const s of await this.ctx.cycles.stages(this.cycle.cycleId))
      if (s.modelAlias && s.status !== "skipped") await this.ctx.cycles.settleStage(s.stageRunId);
  }

  private async narrate(run: StageRun): Promise<void> {
    try {
      await this.ctx.narrator?.narrateStage(run.stageRunId);
    } catch (err) {
      this.ctx.log(
        `stage ${run.stageRunId}: narration failed: ${errorText(err, this.ctx.redactor)}`,
      );
    }
  }
}

const TERMINAL = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "interrupted",
  "stopped",
  "expired",
]);

/** The task's result: the cycle, each stage with its model, caps, cost against its ceiling. */
async function summary(ctx: CycleContext, cycleId: string, opened: AgentSandbox | null = null) {
  const cycle = await ctx.cycles.cycle(cycleId);
  const stages = await ctx.cycles.stages(cycleId);
  return {
    kind: "cycle",
    cycleId,
    cycleKind: cycle?.kind ?? null,
    status: cycle?.status ?? null,
    stopReason: cycle?.stopReason ?? null,
    reasoning: cycle?.reasoningAlias ?? null,
    leaseId: cycle?.leaseId ?? null,
    sandboxId: opened?.sbx.id ?? null,
    chargedUsdcE6: (cycle?.chargedUsdcE6 ?? 0n).toString(),
    absorbedUsdcE6: (cycle?.absorbedUsdcE6 ?? 0n).toString(),
    stages: stages.map((s) => ({
      seq: s.seq,
      stage: s.stage,
      themeCode: s.themeCode,
      model: s.modelAlias,
      status: s.status,
      stopReason: s.stopReason,
      modelCalls: s.modelCalls,
      cacheReadTokens: s.cacheReadTokens,
      chargedUsdcE6: s.chargedUsdcE6.toString(),
      ceilingUsdcE6: s.ceilingUsdcE6.toString(),
    })),
  } as Record<string, unknown>;
}
