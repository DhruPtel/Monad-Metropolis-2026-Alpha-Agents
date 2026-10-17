import { TESTNET_CHAIN, TESTNET_CHAIN_IDS } from "@alpha-agents/config";
import { currentSoulBlock } from "@alpha-agents/policy";
import type { GoalStore, PlanStore } from "@alpha-agents/trading";
import { isBandsPlan, isPortfolioPlan } from "@alpha-agents/trading";
import type { CreditService } from "../credits/service.ts";
import { type GateLogEntry, modelFailure } from "../gate.ts";
import type { AgentConfig } from "../hermes/schema.ts";
import type { Narrator } from "../narrator.ts";
import {
  type AgentSandbox,
  type TaskContext,
  openAgentSandbox,
  ownerSkillsPrompt,
  skillsLoaded,
} from "../noop.ts";
import { errorText } from "../secrets.ts";
import { type AgentRef, LeaseHeldError } from "../store.ts";
import { cycleConfig, stagePrompt } from "./config.ts";
import { REPORT_CEILING_USDC_E6, REPORT_MODEL } from "./report.ts";
import type { ProposalService } from "./proposals.ts";
import type { CycleResearch } from "./research.ts";
import {
  type CycleKind,
  type ReasoningAlias,
  type ScanTheme,
  type Stage,
  type StageCaps,
  DIVES_PER_RUN,
  divesFor,
  isReasoningAlias,
  stageCaps,
  stageCeilingUsdcE6,
  stageMayStart,
  stageModel,
  utcDayStart,
} from "./stages.ts";
import type { Cycle, CycleStore, StageRun, StageStatus } from "./store.ts";
import type { SkillTextOverride } from "../hermes/materialize.ts";
import { type UniverseRow, type UniverseStore, themeDecisions } from "./universe.ts";
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
/**
 * F-U10: what runs around a cycle for the activation sweep. A cycle without
 * an activation is left alone by both.
 */
export interface CycleHooks {
  /**
   * After the Scan's brief is accepted and before any Dive: the activation's
   * deterministic "pools and prices" step. A refusal halts the cycle with
   * its reason.
   */
  readonly afterScan?: (
    cycle: Cycle,
    scan: StageRun,
  ) => Promise<{ ok: true } | { ok: false; reason: string; message: string }>;
  /** After the cycle's record is final, whatever its end. */
  readonly onEnd?: (cycle: Cycle) => Promise<void>;
}

export interface CycleContext extends TaskContext {
  readonly cycles: CycleStore;
  /** F-U10: the activation sweep's hooks; null or absent for a plain cycle. */
  readonly hooks?: CycleHooks | null;
  readonly research: CycleResearch;
  readonly goals: GoalStore;
  readonly plans: PlanStore;
  readonly credits: CreditService;
  readonly narrator: Narrator | null;
  /** F-U9: turns a Zoom out's decision into a stored proposal or a "no change"; null before it exists. */
  readonly proposals?: ProposalService | null;
  /** F-U12: the universe the cycle considers, recorded before its first stage; null without the market. */
  readonly universe?: {
    readonly store: UniverseStore;
    snapshot(cycle: Cycle): Promise<UniverseRow[]>;
  } | null;
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
  if (kind === "REVIEW") return s("ZOOM_OUT") + 15 * 60_000;
  return s("SCAN") + dives * s("DIVE") + s("CHALLENGE") + s("ZOOM_OUT") + 15 * 60_000;
}

/** The most a cycle can charge, shown before it starts: each stage's ceiling, Dives at their limit. */
export function cyclePlan(kind: CycleKind, reasoning: ReasoningAlias, divesLeft: number) {
  const perRun = DIVES_PER_RUN[reasoning];
  const dives =
    kind === "ACTIVATION"
      ? perRun
      : kind === "REVIEW"
        ? 0
        : Math.min(perRun, Math.max(0, divesLeft));
  const stages = (
    kind === "REVIEW"
      ? [
          { stage: "TEST" as const, count: 1 },
          { stage: "ZOOM_OUT" as const, count: 1 },
        ]
      : [
          { stage: "SCAN" as const, count: 1 },
          { stage: "DIVE" as const, count: dives },
          { stage: "CHALLENGE" as const, count: dives > 0 ? 1 : 0 },
          { stage: "TEST" as const, count: 1 },
          { stage: "ZOOM_OUT" as const, count: 1 },
        ]
  ).map((x) => ({
    ...x,
    model: stageModel(x.stage, reasoning),
    caps: stageCaps(x.stage, kind),
    ceilingUsdcE6: stageCeilingUsdcE6(x.stage, kind, reasoning).toString(),
  }));
  const max = stages.reduce((sum, x) => sum + BigInt(x.ceilingUsdcE6) * BigInt(x.count), 0n);
  // RP-U1: the report written at the end has its own ceiling, part of the cycle's shown maximum.
  const report = { model: REPORT_MODEL, ceilingUsdcE6: REPORT_CEILING_USDC_E6.toString() };
  return {
    kind,
    reasoning,
    stages,
    report,
    maxUsdcE6: (max + REPORT_CEILING_USDC_E6).toString(),
  };
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
    // UI-U2: a replay is one stored stage again, under that stage's own caps, ceiling and model.
    const replay = cycle.kind === "REPLAY" ? await replayPlan(ctx, cycle) : null;
    const leaseMs = replay
      ? replay.original.caps.seconds * 1_000 + 15 * 60_000
      : cycleLeaseMs(cycle.kind, cycle.kind === "ACTIVATION" ? 2 : divesLeft);
    const firstStage: Stage = replay
      ? replay.original.stage
      : cycle.kind === "REVIEW"
        ? "ZOOM_OUT"
        : "SCAN";

    // The Scan's ceiling must fit before anything starts, so no sandbox opens for nothing.
    const first = await budgetCheck(
      ctx,
      cycle,
      firstStage,
      goal.config,
      replay?.original.ceilingUsdcE6,
    );
    if (!first.ok) {
      await ctx.cycles.addStage({
        cycle,
        seq: 1,
        stage: firstStage,
        themeCode: replay?.original.themeCode ?? null,
        modelAlias: replay?.original.modelAlias ?? stageModel(firstStage, reasoning),
        caps: replay?.original.caps ?? stageCaps(firstStage, cycle.kind),
        ceilingUsdcE6:
          replay?.original.ceilingUsdcE6 ?? stageCeilingUsdcE6(firstStage, cycle.kind, reasoning),
        status: "skipped",
        stopReason: first.code,
      });
      await ctx.cycles.finishCycle(cycle.cycleId, "stopped", first.code);
      await ctx.store.finishTask(taskId, {
        error: first.message,
        result: await summary(ctx, cycle.cycleId),
      });
      ctx.log(`task ${taskId}: cycle ${cycle.cycleId} did not start: ${first.code}`);
      await ended(ctx, cycle);
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
          (stored: AgentConfig) => {
            const config = cycleConfig(stored, {
              kind: replay ? replay.cycle.kind : cycle.kind,
              goalBlock: currentSoulBlock(goal.soulBlock, goal.goal),
              canary: cycle.canary,
            });
            // A replay's sandbox gets the SOUL.md the original cycle had, with its own marker.
            return replay?.cycle.soul
              ? { ...config, soul: replay.cycle.soul.replaceAll(replay.cycle.canary, cycle.canary) }
              : config;
          },
          replay?.overrides ?? [],
        );
        break;
      } catch (err) {
        if (!(err instanceof LeaseHeldError) || Date.now() >= waitUntil) throw err;
        await sleep(5_000);
      }
    }
    leaseId = opened.leaseId;
    await ctx.cycles.startCycle(cycle.cycleId, opened.leaseId);
    // UI-U2: the SOUL.md this sandbox was given, so a replay of any of its stages mounts the same.
    await ctx.cycles.setSoul(cycle.cycleId, opened.config.soul);
    ctx.log(
      `task ${taskId}: cycle ${cycle.cycleId} (${cycle.kind}${replay ? ` of ${replay.original.stage} ${replay.original.stageRunId}` : ""}) started on ${reasoning}`,
    );

    const engine = new Engine(ctx, cycle, opened, reasoning, goal.config);
    const stop = replay ? await engine.replay(replay.original) : await engine.run();
    await ctx.leases.release(opened.leaseId, "cycle finished");
    leaseId = null;
    await engine.settleAll();
    await ctx.cycles.finishCycle(cycle.cycleId, stop.status, stop.reason);
    const result = await summary(ctx, cycle.cycleId, opened);
    if (stop.status === "failed" || stop.reason === "TASK_CAP")
      await ctx.store.finishTask(taskId, { error: stop.message ?? stop.reason, result });
    else await ctx.store.finishTask(taskId, { result });
    ctx.log(
      `task ${taskId}: cycle ${cycle.cycleId} ${stop.status} (${stop.reason}) in ${Date.now() - started} ms`,
    );
    await ended(ctx, cycle);
  } catch (err) {
    const message = errorText(err, ctx.redactor);
    if (leaseId) await ctx.leases.release(leaseId, "cycle failed");
    await ctx.cycles.finishCycle(cycle.cycleId, "failed", "FAILED");
    const result = await summary(ctx, cycle.cycleId, opened).catch(() => null);
    await ctx.store.finishTask(taskId, result ? { error: message, result } : { error: message });
    ctx.log(`task ${taskId}: cycle failed: ${message}`);
    await ended(ctx, cycle);
  }
}

/** The end hook, after the cycle's record is final; a failure in it never fails the task. */
async function ended(ctx: CycleContext, cycle: Cycle): Promise<void> {
  try {
    await ctx.hooks?.onEnd?.(cycle);
  } catch (err) {
    ctx.log(`cycle ${cycle.cycleId}: the end hook failed: ${errorText(err, ctx.redactor)}`);
  }
}

const now = (ctx: CycleContext) => ctx.now?.() ?? new Date();

type GoalConfig = NonNullable<Awaited<ReturnType<GoalStore["currentGoal"]>>>["config"];

/**
 * UI-U2: what a REPLAY cycle runs: the original stage with its stored
 * prompt, the cycle it belonged to (its kind, SOUL.md and marker), and the
 * edited texts to mount. A stage without a stored prompt cannot be replayed.
 */
export interface ReplayPlan {
  readonly original: StageRun & { readonly prompt: string };
  readonly cycle: Cycle;
  readonly overrides: readonly SkillTextOverride[];
}

export async function replayPlan(ctx: CycleContext, replay: Cycle): Promise<ReplayPlan> {
  if (!replay.replayOf) throw new Error("the replay names no stage");
  const original = await ctx.cycles.stageRun(replay.replayOf);
  if (!original) throw new Error(`the replayed stage ${replay.replayOf} does not exist`);
  if (!original.modelAlias)
    throw new Error("the Test stage is deterministic and free; only model stages replay");
  if (!original.prompt)
    throw new Error(
      "this stage ran before replays existed and has no stored prompt; run a new cycle and replay one of its stages",
    );
  const cycle = await ctx.cycles.cycle(original.cycleId);
  if (!cycle) throw new Error(`the replayed stage's cycle ${original.cycleId} does not exist`);
  return {
    original: { ...original, prompt: original.prompt },
    cycle,
    overrides: replay.replayOverrides.map((o) => ({
      kind: o.kind,
      hermesName: o.name,
      skillMd: o.skillMd,
    })),
  };
}

async function budgetCheck(
  ctx: CycleContext,
  cycle: Cycle,
  stage: Stage,
  goal: GoalConfig,
  /** UI-U2: a replay's ceiling is the original stage's, not the kind's. */
  ceilingUsdcE6?: bigint,
) {
  const ref = { chainId: cycle.chainId, agentId: cycle.agentId };
  const credits = await ctx.credits.creditsOf(cycle.agentId);
  // P-SWEEP (A-101): the activation sweep runs within the ceiling its owner saw and accepted
  // when turning automatic trading on (A-51, up to 4.00 USDC); the goal's daily research
  // budget (D-293, 1.00 USDC at Light) governs routine research. Checked against the day's
  // budget, every sweep stopped after its Scan (BUDGET_SHORT) and never built a plan.
  const activation = cycle.kind === "ACTIVATION";
  return stageMayStart({
    ceilingUsdcE6:
      ceilingUsdcE6 ??
      stageCeilingUsdcE6(stage, cycle.kind, cycle.reasoningAlias as ReasoningAlias),
    dailyBudgetUsdcE6: activation
      ? BigInt(cyclePlan("ACTIVATION", cycle.reasoningAlias as ReasoningAlias, 0).maxUsdcE6)
      : BigInt(goal.research.dailyBudgetUsdcE6),
    usedTodayUsdcE6: activation
      ? await ctx.cycles.usedInCycle(cycle.cycleId)
      : await ctx.cycles.usedToday(ref, utcDayStart(now(ctx))),
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

  /** F-U12: the universe the cycle considers; a failure to record it is logged, never fatal. */
  private async recordUniverse(): Promise<void> {
    const u = this.ctx.universe;
    if (!u) return;
    try {
      const rows = await u.snapshot(this.cycle);
      await u.store.record(this.cycle, rows, this.ctx.now?.() ?? new Date());
    } catch (err) {
      this.ctx.log(
        `cycle ${this.cycle.cycleId}: the universe was not recorded: ${errorText(err, this.ctx.redactor)}`,
      );
    }
  }

  private async markThemes(decisions: ReturnType<typeof themeDecisions>): Promise<void> {
    const u = this.ctx.universe;
    if (!u) return;
    try {
      await u.store.markThemes(this.cycle, decisions, this.ctx.now?.() ?? new Date());
    } catch (err) {
      this.ctx.log(
        `cycle ${this.cycle.cycleId}: the themes' decisions were not recorded: ${errorText(err, this.ctx.redactor)}`,
      );
    }
  }

  /**
   * UI-U2: the replay of one stored stage: the same stage, theme, caps,
   * ceiling, model and prompt, in a sandbox whose tools answer from the
   * stored results. Nothing else of a cycle runs: no universe, no Dives
   * after a Scan, no proposal from a Zoom out, no narration.
   */
  async replay(original: StageRun & { readonly prompt: string }): Promise<{
    status: "completed" | "stopped" | "failed";
    reason: string;
    message?: string;
  }> {
    const stage = original.stage;
    if (stage === "TEST") return { status: "failed", reason: "FAILED", message: "no model stage" };
    const run = await this.modelStage(stage, original.themeCode, [], null, {
      caps: original.caps,
      ceilingUsdcE6: original.ceilingUsdcE6,
      model: original.modelAlias ?? (stageModel(stage, this.reasoning) as string),
      prompt: original.prompt,
    });
    if (
      run.end.status === "stopped" ||
      run.end.status === "failed" ||
      run.end.status === "skipped" ||
      run.end.stopReason === "TASK_CAP"
    )
      return this.halt(run.end);
    return {
      status: "completed",
      reason: run.end.status === "capped" ? run.end.stopReason : "COMPLETED",
    };
  }

  async run(): Promise<{
    status: "completed" | "stopped" | "failed";
    reason: string;
    message?: string;
  }> {
    const kind = this.cycle.kind;
    if (kind === "REPLAY") throw new Error("a replay runs through Engine.replay");
    // F-U12: what the agent can see, and what this account may buy, before the first stage.
    await this.recordUniverse();
    // P3-U10: a review is the Zoom out alone, weighing the briefs on record and the portfolio now.
    if (kind === "REVIEW") return this.zoomOut();
    const scan = await this.modelStage("SCAN", null);
    if (
      scan.end.status === "stopped" ||
      scan.end.status === "failed" ||
      scan.end.status === "skipped" ||
      scan.end.stopReason === "TASK_CAP"
    )
      return this.halt(scan.end);
    const hasScanBrief = await this.hasBrief(scan.run, "SCAN");
    // A Scan stopped at a cap before its brief ends the cycle with that cap.
    if (scan.end.status === "capped" && !hasScanBrief)
      return { status: "stopped", reason: scan.end.stopReason };
    // F-U10: the activation's deterministic read of pools, prices and screens, after the Scan.
    if (this.ctx.hooks?.afterScan) {
      const after = await this.ctx.hooks.afterScan(this.cycle, scan.run).catch((err: unknown) => ({
        ok: false as const,
        reason: "MARKET_UNAVAILABLE",
        message: errorText(err, this.ctx.redactor),
      }));
      if (!after.ok) return { status: "failed", reason: after.reason, message: after.message };
    }
    const themes = await this.scanThemes(scan.run);
    const now = this.ctx.now?.() ?? new Date();
    const history = await this.ctx.cycles.diveHistory(this.ref(), now, utcDayStart(now));
    const dives = divesFor({
      kind,
      reasoning: this.cycle.reasoningAlias as ReasoningAlias,
      themes,
      divesPerDay: this.goal.research.divesPerDay,
      divesToday: history.divesToday,
      recentlyDived: history.recentlyDived,
    });
    // F-U12: why each theme was or was not chosen for a Dive, on the universe's record.
    await this.markThemes(
      themeDecisions({
        kind,
        themes,
        chosen: dives,
        divesPerDay: this.goal.research.divesPerDay,
        divesToday: history.divesToday,
        recentlyDived: history.recentlyDived,
      }),
    );
    if (dives.length === 0 && kind !== "ACTIVATION")
      return { status: "completed", reason: "NOTHING_MATERIAL" };

    const dived: string[] = [];
    for (const theme of dives) {
      const dive = await this.modelStage("DIVE", theme.code, [], theme);
      if (
        dive.end.status === "stopped" ||
        dive.end.status === "failed" ||
        dive.end.status === "skipped" ||
        dive.end.stopReason === "TASK_CAP"
      )
        return this.halt(dive.end);
      if (await this.hasBrief(dive.run, "THEME")) dived.push(theme.code);
    }
    if (dived.length > 0) {
      const challenge = await this.modelStage("CHALLENGE", null, dived);
      if (
        challenge.end.status === "stopped" ||
        challenge.end.status === "failed" ||
        challenge.end.status === "skipped" ||
        challenge.end.stopReason === "TASK_CAP"
      )
        return this.halt(challenge.end);
    } else if (dives.length > 0) await this.skip("CHALLENGE", "NOTHING_MATERIAL");
    void dived;
    return this.zoomOut();
  }

  /** The Test's record and the Zoom out: every cycle ends here, a review starts here. */
  private async zoomOut(): Promise<{
    status: "completed" | "stopped" | "failed";
    reason: string;
    message?: string;
  }> {
    await this.testStage();
    const zoom = await this.modelStage("ZOOM_OUT", null);
    if (
      zoom.end.status === "stopped" ||
      zoom.end.status === "failed" ||
      zoom.end.status === "skipped" ||
      zoom.end.stopReason === "TASK_CAP"
    )
      return this.halt(zoom.end);
    // F-U9: the Zoom out's decision becomes a stored proposal (evaluated) or a stored "no change".
    // 2026-10-17: also when the step reached a cap after it decided: a recorded decision stands
    // (fromZoomOut reads the stage's record and stores nothing when the step left none).
    if (this.ctx.proposals && (zoom.end.status === "completed" || zoom.end.status === "capped")) {
      try {
        const p = await this.ctx.proposals.fromZoomOut(this.cycle, zoom.run);
        if (p) this.ctx.log(`cycle ${this.cycle.cycleId}: ${p.kind} ${p.proposalId} ${p.status}`);
      } catch (err) {
        this.ctx.log(
          `cycle ${this.cycle.cycleId}: the proposal could not be recorded: ${errorText(err, this.ctx.redactor)}`,
        );
      }
    }
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
      ...(failed
        ? { message: `a stage failed: ${end.stopReason}` }
        : end.stopReason === "TASK_CAP"
          ? { message: "the task reached its model spend cap (D-369); the stages before it stand" }
          : {}),
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
  /** 2026-10-16: the deployed contracts' limits the Test read, told to the Zoom out up front. */
  private contractFacts: string | null = null;

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
      this.contractFacts = portfolio?.contractFacts ?? null;
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
    /** UI-U2: a replay fixes the stage's caps, ceiling, model and prompt to the original's. */
    fixed: {
      readonly caps: StageCaps;
      readonly ceilingUsdcE6: bigint;
      readonly model: string;
      readonly prompt: string;
    } | null = null,
  ): Promise<{ run: StageRun; end: StageEnd }> {
    this.seq += 1;
    const kind = this.cycle.kind;
    const caps = fixed?.caps ?? stageCaps(stage, kind);
    const ceiling = fixed?.ceilingUsdcE6 ?? stageCeilingUsdcE6(stage, kind, this.reasoning);
    const model = fixed?.model ?? (stageModel(stage, this.reasoning) as string);
    const check = await budgetCheck(this.ctx, this.cycle, stage, this.goal, fixed?.ceilingUsdcE6);
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
    // SK-U1: the owner's own skills are named in every stage's prompt, as the playbooks are.
    // UI-U2: a replay sends the stored prompt word for word; every stage's prompt is stored.
    const prompt =
      fixed?.prompt ??
      `${stagePrompt({
        stage,
        kind,
        overview: this.cycle.wantsOverview,
        themeCode,
        token: theme?.token ? { address: theme.token, symbol: theme.symbol } : null,
        caps,
        ceilingUsdcE6: ceiling,
        diveThemes,
        contractFacts: stage === "ZOOM_OUT" ? this.contractFacts : null,
        standIns: TESTNET_CHAIN_IDS.includes(this.cycle.chainId) && TESTNET_CHAIN.standIns,
      })}${ownerSkillsPrompt(this.sbx.ownerSkills)}`;
    await this.ctx.cycles.setPrompt(run.stageRunId, prompt);
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
      (e.reason === "TURN_CAP" ||
        e.reason === "TOKEN_CAP" ||
        e.reason === "CEILING" ||
        e.reason === "TASK_CAP")
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
    // UI-U2: a replay is the owner's experiment, not the agent's activity: nothing is narrated.
    if (this.cycle.kind === "REPLAY") return;
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
