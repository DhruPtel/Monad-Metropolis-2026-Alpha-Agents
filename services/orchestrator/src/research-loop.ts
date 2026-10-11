import { randomUUID } from "node:crypto";
import type { Db } from "@alpha-agents/db";
import {
  AGGRESSIVENESS_ENVELOPES,
  type Aggressiveness,
  RESEARCH_INTENSITY_FACTS,
  type ResearchIntensity,
} from "@alpha-agents/domain";
import type { CycleKind } from "./cycle/stages.ts";

/**
 * The autonomous loop after activation (P3-U10, D-283): the scheduler that
 * runs research cycles for activated agents at their intensity's cadence
 * under the day's research budget, and the watcher that starts a cycle when
 * something material changed, both deterministic and free. The decisions are
 * pure functions over records, so every cadence, trigger and spacing rule is
 * tested with a fast clock; the classes around them read the stores and
 * queue the work.
 */

export interface AgentRef {
  readonly chainId: number;
  readonly agentId: number;
}

/** A trigger the watcher looks for; its kind says which cycle it starts. */
export const TRIGGER_CODES = [
  "PRICE_MOVE",
  "VOLATILITY_CROSSED",
  "MODE_CHANGED",
  "FLOW_MOVED",
  "GOAL_CHANGED",
  "TRADE_BLOCKED_3X",
  "THESIS_RECHECK",
  "POSITION_PRICE_MOVE",
  "LIQUIDITY_DROP",
  "RESCREEN_FAILED",
] as const;
export type TriggerCode = (typeof TRIGGER_CODES)[number];

/** Which cycle a trigger starts: a Scan (TRIGGERED) for a market move, a review (the Zoom out alone) for the rest. */
export const TRIGGER_KIND: Readonly<Record<TriggerCode, "TRIGGERED" | "REVIEW">> = {
  PRICE_MOVE: "TRIGGERED",
  VOLATILITY_CROSSED: "TRIGGERED",
  THESIS_RECHECK: "TRIGGERED",
  POSITION_PRICE_MOVE: "TRIGGERED",
  MODE_CHANGED: "REVIEW",
  FLOW_MOVED: "REVIEW",
  GOAL_CHANGED: "REVIEW",
  TRADE_BLOCKED_3X: "REVIEW",
  LIQUIDITY_DROP: "REVIEW",
  RESCREEN_FAILED: "REVIEW",
};

export const TRIGGER_TEXT: Readonly<Record<TriggerCode, string>> = {
  PRICE_MOVE: "MON's price moved past the goal's trigger since the last Zoom out",
  VOLATILITY_CROSSED: "24-hour volatility crossed the plan's brake",
  MODE_CHANGED: "the account's mode changed",
  FLOW_MOVED: "a deposit or withdrawal moved the account's value by a fifth or more",
  GOAL_CHANGED: "the goal changed",
  TRADE_BLOCKED_3X: "the same trade was blocked three times in 24 hours",
  THESIS_RECHECK: "a thesis reached its recheck time",
  POSITION_PRICE_MOVE: "a held token moved past the level's review trigger",
  LIQUIDITY_DROP: "a held token's liquidity fell by half",
  RESCREEN_FAILED: "a held token failed its re-screen or went sell-only",
};

/** The MON price move that triggers a Scan, by aggressiveness (D-283: 5%, 7%, 10%). */
export const PRICE_TRIGGER_BPS: Readonly<Record<Aggressiveness, number>> = {
  CONSERVATIVE: 500,
  BALANCED: 700,
  AGGRESSIVE: 1_000,
};

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** The loop's clocks: the intensity's cadence, or minutes on the fork's fast cadence. */
export function cadence(intensity: ResearchIntensity, fast: boolean) {
  const f = RESEARCH_INTENSITY_FACTS[intensity];
  return fast
    ? {
        scanEveryMs: 2 * MINUTE,
        zoomOutEveryMs: 5 * MINUTE,
        overviewEveryMs: 10 * MINUTE,
        triggerSpacingMs: 1 * MINUTE,
        watchEveryMs: 30_000,
        divesPerDay: f.divesPerDay,
      }
    : {
        scanEveryMs: f.scanEveryHours * HOUR,
        zoomOutEveryMs: 24 * HOUR,
        overviewEveryMs: 7 * 24 * HOUR,
        triggerSpacingMs: 2 * HOUR,
        watchEveryMs: 5 * MINUTE,
        divesPerDay: f.divesPerDay,
      };
}

/** Why the scheduler is not starting the work that is due. */
export type WaitReason = "BUDGET_SHORT" | "CREDITS_SHORT" | "NO_CREDITS" | "CANNOT_START";

export interface PendingTrigger {
  readonly triggerId: string;
  readonly code: TriggerCode;
  readonly firedAt: Date;
}

export interface ScheduleInput {
  readonly now: Date;
  readonly intensity: ResearchIntensity;
  readonly fast: boolean;
  readonly paused: boolean;
  readonly openCycle: boolean;
  readonly lastScanAt: Date | null;
  readonly lastZoomOutAt: Date | null;
  readonly lastOverviewAt: Date | null;
  readonly lastTriggerCycleAt: Date | null;
  readonly pending: readonly PendingTrigger[];
  /** The overview refresh: weekly at Standard and Deep, never at Light. */
  readonly refreshesOverview: boolean;
}

export type Work = {
  readonly kind: Extract<CycleKind, "TRIGGERED" | "REVIEW" | "ROUTINE">;
  readonly wantsOverview: boolean;
  /** The triggers this cycle answers, or none for the cadence's own work. */
  readonly triggers: readonly PendingTrigger[];
  readonly reason: string;
} | null;

/**
 * What to run now, by priority: a triggered review (cheapest, the Zoom out
 * alone), a triggered Scan, the daily review, then the routine Scan. A
 * trigger never starts work within the spacing of the last triggered cycle;
 * a spaced trigger waits in the queue until the spacing has passed.
 */
export function decideWork(i: ScheduleInput): Work {
  if (i.paused || i.openCycle) return null;
  const c = cadence(i.intensity, i.fast);
  const since = (at: Date | null) =>
    at ? i.now.getTime() - at.getTime() : Number.POSITIVE_INFINITY;
  const overviewDue = i.refreshesOverview && since(i.lastOverviewAt) >= c.overviewEveryMs;
  const spaced = since(i.lastTriggerCycleAt) < c.triggerSpacingMs;
  if (i.pending.length > 0 && !spaced) {
    const reviews = i.pending.filter((t) => TRIGGER_KIND[t.code] === "REVIEW");
    const scans = i.pending.filter((t) => TRIGGER_KIND[t.code] === "TRIGGERED");
    if (reviews.length > 0)
      return {
        kind: "REVIEW",
        wantsOverview: false,
        triggers: reviews,
        reason: `review after ${reviews.map((t) => t.code).join(", ")}`,
      };
    return {
      kind: "TRIGGERED",
      wantsOverview: false,
      triggers: scans,
      reason: `scan after ${scans.map((t) => t.code).join(", ")}`,
    };
  }
  // A review needs research to review: an agent that never scanned starts with the Scan.
  if (i.lastScanAt !== null && since(i.lastZoomOutAt) >= c.zoomOutEveryMs)
    return {
      kind: "REVIEW",
      wantsOverview: overviewDue,
      triggers: [],
      reason: overviewDue ? "the daily review, with the overview refreshed" : "the daily review",
    };
  if (since(i.lastScanAt) >= c.scanEveryMs)
    return {
      kind: "ROUTINE",
      wantsOverview: overviewDue,
      triggers: [],
      reason: "the routine Scan",
    };
  return null;
}

/** When the next cadence work falls due, for the Research page. */
export function nextDue(i: Omit<ScheduleInput, "pending" | "openCycle">): Date | null {
  if (i.paused) return null;
  const c = cadence(i.intensity, i.fast);
  const at = (last: Date | null, every: number) =>
    last ? new Date(last.getTime() + every) : i.now;
  const scan = at(i.lastScanAt, c.scanEveryMs);
  const zoom = at(i.lastZoomOutAt, c.zoomOutEveryMs);
  return scan.getTime() <= zoom.getTime() ? scan : zoom;
}

/** What the watcher observes each pass, read through the platform's readers; null where unreadable. */
export interface Observation {
  readonly at: Date;
  readonly monUsdE18: bigint | null;
  readonly volatility24hPct: number | null;
  readonly mode: string | null;
  readonly navUsdcE6: bigint | null;
  /** The goal's strategy epoch (a save bumps it). */
  readonly goalEpoch: string;
  /** Intents the trade flow rejected in the last 24 hours, by their first reason code. */
  readonly blockedIn24h: Readonly<Record<string, number>>;
  /** Trades settled since the baseline was taken; a value move with none is a deposit or a withdrawal. */
  readonly settledSinceBaseline: number;
  readonly held: readonly {
    readonly token: string;
    readonly symbol: string;
    readonly priceE18: bigint | null;
    readonly liquidityUsd: number | null;
    readonly screenVerdict: string | null;
    readonly registryStatus: string | null;
  }[];
  /** The plan's positions with their recheck times. */
  readonly rechecks: readonly {
    readonly token: string;
    readonly symbol: string;
    readonly at: Date;
  }[];
}

/** The watcher's baselines, taken at the last Zoom out (or the first pass) and kept in the schedule row. */
export interface Baseline {
  readonly takenAt: string;
  readonly monUsdE18: string | null;
  readonly volatilityAboveBrake: boolean | null;
  readonly mode: string | null;
  readonly navUsdcE6: string | null;
  readonly goalEpoch: string;
  readonly prices: Readonly<Record<string, string>>;
  readonly liquidityUsd: Readonly<Record<string, number>>;
  readonly screened: Readonly<Record<string, string | null>>;
  /** Recheck times already answered, by token. */
  readonly rechecked: Readonly<Record<string, string>>;
}

export function baselineFrom(o: Observation, brakeBps: number | null): Baseline {
  return {
    takenAt: o.at.toISOString(),
    monUsdE18: o.monUsdE18 === null ? null : o.monUsdE18.toString(),
    volatilityAboveBrake:
      o.volatility24hPct === null || brakeBps === null ? null : o.volatility24hPct * 100 > brakeBps,
    mode: o.mode,
    navUsdcE6: o.navUsdcE6 === null ? null : o.navUsdcE6.toString(),
    goalEpoch: o.goalEpoch,
    prices: Object.fromEntries(
      o.held
        .filter((h) => h.priceE18 !== null)
        .map((h) => [h.token.toLowerCase(), String(h.priceE18)]),
    ),
    liquidityUsd: Object.fromEntries(
      o.held
        .filter((h) => h.liquidityUsd !== null)
        .map((h) => [h.token.toLowerCase(), h.liquidityUsd as number]),
    ),
    screened: Object.fromEntries(o.held.map((h) => [h.token.toLowerCase(), screenKey(h)])),
    rechecked: {},
  };
}

export interface TriggerFound {
  readonly code: TriggerCode;
  readonly detail: Record<string, unknown>;
}

/** A held token's screen and registry standing as one key, so a change in either is seen. */
const screenKey = (h: { screenVerdict: string | null; registryStatus: string | null }) =>
  `${h.screenVerdict ?? "-"}/${h.registryStatus ?? "-"}`;

const moveBps = (now: bigint, then: bigint) =>
  then === 0n ? 0 : Number(((now > then ? now - then : then - now) * 10_000n) / then);

/**
 * Every trigger the observation fires against the baseline, each once per
 * condition: a condition that held at the baseline fires nothing until the
 * baseline is taken again.
 */
export function detectTriggers(i: {
  readonly o: Observation;
  readonly b: Baseline;
  readonly aggressiveness: Aggressiveness;
  readonly brakeBps: number | null;
}): TriggerFound[] {
  const { o, b } = i;
  const out: TriggerFound[] = [];
  const env = AGGRESSIVENESS_ENVELOPES[i.aggressiveness];
  if (o.monUsdE18 !== null && b.monUsdE18 !== null) {
    const bps = moveBps(o.monUsdE18, BigInt(b.monUsdE18));
    if (bps >= PRICE_TRIGGER_BPS[i.aggressiveness])
      out.push({
        code: "PRICE_MOVE",
        detail: { moveBps: bps, triggerBps: PRICE_TRIGGER_BPS[i.aggressiveness] },
      });
  }
  if (o.volatility24hPct !== null && i.brakeBps !== null && b.volatilityAboveBrake !== null) {
    const above = o.volatility24hPct * 100 > i.brakeBps;
    if (above !== b.volatilityAboveBrake)
      out.push({
        code: "VOLATILITY_CROSSED",
        detail: { volatilityPct: o.volatility24hPct, brakeBps: i.brakeBps, above },
      });
  }
  if (o.mode !== null && b.mode !== null && o.mode !== b.mode)
    out.push({ code: "MODE_CHANGED", detail: { from: b.mode, to: o.mode } });
  if (o.navUsdcE6 !== null && b.navUsdcE6 !== null && o.settledSinceBaseline === 0) {
    const bps = moveBps(o.navUsdcE6, BigInt(b.navUsdcE6));
    if (bps >= 2_000)
      out.push({
        code: "FLOW_MOVED",
        detail: { moveBps: bps, fromUsdcE6: b.navUsdcE6, toUsdcE6: o.navUsdcE6.toString() },
      });
  }
  if (o.goalEpoch !== b.goalEpoch)
    out.push({ code: "GOAL_CHANGED", detail: { from: b.goalEpoch, to: o.goalEpoch } });
  for (const [code, count] of Object.entries(o.blockedIn24h))
    if (count >= 3) out.push({ code: "TRADE_BLOCKED_3X", detail: { reason: code, count } });
  for (const r of o.rechecks) {
    const key = r.token.toLowerCase();
    if (r.at.getTime() <= o.at.getTime() && b.rechecked[key] !== r.at.toISOString())
      out.push({
        code: "THESIS_RECHECK",
        detail: { token: r.token, symbol: r.symbol, recheckAt: r.at.toISOString() },
      });
  }
  for (const h of o.held) {
    const key = h.token.toLowerCase();
    const then = b.prices[key];
    if (h.priceE18 !== null && then !== undefined) {
      const bps = moveBps(h.priceE18, BigInt(then));
      if (bps >= env.reviewTriggerBps)
        out.push({
          code: "POSITION_PRICE_MOVE",
          detail: {
            token: h.token,
            symbol: h.symbol,
            moveBps: bps,
            triggerBps: env.reviewTriggerBps,
          },
        });
    }
    const liq = b.liquidityUsd[key];
    if (h.liquidityUsd !== null && liq !== undefined && liq > 0 && h.liquidityUsd <= liq / 2)
      out.push({
        code: "LIQUIDITY_DROP",
        detail: { token: h.token, symbol: h.symbol, fromUsd: liq, toUsd: h.liquidityUsd },
      });
    const failed =
      h.screenVerdict === "refused" ||
      h.registryStatus === "sell_only" ||
      h.registryStatus === "delisted";
    if (failed && b.screened[key] !== screenKey(h))
      out.push({
        code: "RESCREEN_FAILED",
        detail: {
          token: h.token,
          symbol: h.symbol,
          verdict: h.screenVerdict,
          status: h.registryStatus,
        },
      });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The stores

export interface ScheduleRow {
  readonly paused: boolean;
  readonly fastCadence: boolean;
  readonly lastScanAt: Date | null;
  readonly lastZoomOutAt: Date | null;
  readonly lastOverviewAt: Date | null;
  readonly lastTriggerCycleAt: Date | null;
  readonly waitingReason: string | null;
  readonly waitingSince: Date | null;
  readonly nextDueAt: Date | null;
  readonly baseline: Baseline | null;
  readonly updatedAt: Date;
}

export interface TriggerRow {
  readonly triggerId: string;
  readonly code: TriggerCode;
  readonly detail: Record<string, unknown>;
  readonly firedAt: Date;
  readonly cycleId: string | null;
  readonly spaced: boolean;
}

const EMPTY: ScheduleRow = {
  paused: false,
  fastCadence: false,
  lastScanAt: null,
  lastZoomOutAt: null,
  lastOverviewAt: null,
  lastTriggerCycleAt: null,
  waitingReason: null,
  waitingSince: null,
  nextDueAt: null,
  baseline: null,
  updatedAt: new Date(0),
};

export class ResearchStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async schedule(ref: AgentRef): Promise<ScheduleRow> {
    const r = await this.db
      .selectFrom("platform.research_schedules")
      .selectAll()
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .executeTakeFirst();
    if (!r) return EMPTY;
    return {
      paused: r.paused,
      fastCadence: r.fast_cadence,
      lastScanAt: r.last_scan_at ? new Date(r.last_scan_at) : null,
      lastZoomOutAt: r.last_zoom_out_at ? new Date(r.last_zoom_out_at) : null,
      lastOverviewAt: r.last_overview_at ? new Date(r.last_overview_at) : null,
      lastTriggerCycleAt: r.last_trigger_cycle_at ? new Date(r.last_trigger_cycle_at) : null,
      waitingReason: r.waiting_reason,
      waitingSince: r.waiting_since ? new Date(r.waiting_since) : null,
      nextDueAt: r.next_due_at ? new Date(r.next_due_at) : null,
      baseline: (r.baseline as Baseline | null) ?? null,
      updatedAt: new Date(r.updated_at),
    };
  }

  async update(
    ref: AgentRef,
    patch: Partial<{
      paused: boolean;
      fastCadence: boolean;
      lastScanAt: Date | null;
      lastZoomOutAt: Date | null;
      lastOverviewAt: Date | null;
      lastTriggerCycleAt: Date | null;
      waitingReason: string | null;
      waitingSince: Date | null;
      nextDueAt: Date | null;
      baseline: Baseline | null;
    }>,
    now: Date = new Date(),
  ): Promise<void> {
    const values = {
      ...(patch.paused !== undefined ? { paused: patch.paused } : {}),
      ...(patch.fastCadence !== undefined ? { fast_cadence: patch.fastCadence } : {}),
      ...(patch.lastScanAt !== undefined ? { last_scan_at: patch.lastScanAt } : {}),
      ...(patch.lastZoomOutAt !== undefined ? { last_zoom_out_at: patch.lastZoomOutAt } : {}),
      ...(patch.lastOverviewAt !== undefined ? { last_overview_at: patch.lastOverviewAt } : {}),
      ...(patch.lastTriggerCycleAt !== undefined
        ? { last_trigger_cycle_at: patch.lastTriggerCycleAt }
        : {}),
      ...(patch.waitingReason !== undefined ? { waiting_reason: patch.waitingReason } : {}),
      ...(patch.waitingSince !== undefined ? { waiting_since: patch.waitingSince } : {}),
      ...(patch.nextDueAt !== undefined ? { next_due_at: patch.nextDueAt } : {}),
      ...(patch.baseline !== undefined
        ? { baseline: patch.baseline === null ? null : JSON.stringify(patch.baseline) }
        : {}),
      updated_at: now,
    };
    await this.db
      .insertInto("platform.research_schedules")
      .values({ chain_id: ref.chainId, agent_id: ref.agentId, ...values })
      .onConflict((oc) => oc.columns(["chain_id", "agent_id"]).doUpdateSet(values))
      .execute();
  }

  async recordTrigger(
    ref: AgentRef,
    t: TriggerFound,
    firedAt: Date,
    spaced: boolean,
  ): Promise<string> {
    const triggerId = `trigger-${randomUUID()}`;
    await this.db
      .insertInto("platform.research_triggers")
      .values({
        trigger_id: triggerId,
        chain_id: ref.chainId,
        agent_id: ref.agentId,
        code: t.code,
        detail: JSON.stringify(t.detail),
        fired_at: firedAt,
        spaced,
      })
      .execute();
    return triggerId;
  }

  /** Triggers fired and not yet answered by a cycle. */
  async pending(ref: AgentRef): Promise<PendingTrigger[]> {
    const rows = await this.db
      .selectFrom("platform.research_triggers")
      .select(["trigger_id", "code", "fired_at"])
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .where("cycle_id", "is", null)
      .orderBy("fired_at", "asc")
      .execute();
    return rows.map((r) => ({
      triggerId: r.trigger_id,
      code: r.code as TriggerCode,
      firedAt: new Date(r.fired_at),
    }));
  }

  async answered(triggerIds: readonly string[], cycleId: string): Promise<void> {
    if (triggerIds.length === 0) return;
    await this.db
      .updateTable("platform.research_triggers")
      .set({ cycle_id: cycleId })
      .where("trigger_id", "in", [...triggerIds])
      .execute();
  }

  async recent(ref: AgentRef, limit = 20): Promise<TriggerRow[]> {
    const rows = await this.db
      .selectFrom("platform.research_triggers")
      .selectAll()
      .where("chain_id", "=", ref.chainId)
      .where("agent_id", "=", ref.agentId)
      .orderBy("fired_at", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      triggerId: r.trigger_id,
      code: r.code as TriggerCode,
      detail: r.detail,
      firedAt: new Date(r.fired_at),
      cycleId: r.cycle_id,
      spaced: r.spaced,
    }));
  }

  /** The agents whose research the loop runs: RUNNING (an approved plan, armed). */
  async runningAgents(chainId: number): Promise<number[]> {
    const rows = await this.db
      .selectFrom("platform.agent_states")
      .select("agent_id")
      .where("chain_id", "=", chainId)
      .where("state", "=", "RUNNING")
      .orderBy("agent_id")
      .execute();
    return rows.map((r) => r.agent_id);
  }
}

// ---------------------------------------------------------------------------
// The scheduler

export interface SchedulerDeps {
  readonly chainId: number;
  readonly research: ResearchStore;
  /** The goal's research settings, or null without a goal. */
  readonly goalOf: (ref: AgentRef) => Promise<{
    intensity: ResearchIntensity;
    aggressiveness: Aggressiveness;
    dailyBudgetUsdcE6: bigint;
  } | null>;
  readonly openCycle: (ref: AgentRef) => Promise<boolean>;
  /** The day's research spend so far and the ceiling of the work's first stage, for the budget state. */
  readonly budgetRoom: (
    ref: AgentRef,
    kind: CycleKind,
  ) => Promise<{ fits: boolean; reason: WaitReason | null }>;
  /** Queues a cycle; throws when credits are exhausted or the agent cannot run. */
  readonly enqueue: (
    ref: AgentRef,
    kind: CycleKind,
    wantsOverview: boolean,
  ) => Promise<{ cycleId: string }>;
  /** When the agent's last Scan, Zoom out and overview completed, from the cycle records. */
  readonly lastStages: (ref: AgentRef) => Promise<{
    scanAt: Date | null;
    zoomOutAt: Date | null;
    overviewAt: Date | null;
  }>;
  readonly now?: () => Date;
  readonly log: (line: string) => void;
}

export class ResearchScheduler {
  private readonly d: SchedulerDeps;
  constructor(d: SchedulerDeps) {
    this.d = d;
  }

  /** One pass over the running agents; returns the cycles it queued, by agent. */
  async tick(): Promise<{ agentId: number; kind: CycleKind; cycleId: string }[]> {
    const now = this.d.now?.() ?? new Date();
    const queued: { agentId: number; kind: CycleKind; cycleId: string }[] = [];
    for (const agentId of await this.d.research.runningAgents(this.d.chainId)) {
      const ref = { chainId: this.d.chainId, agentId };
      try {
        const q = await this.tickAgent(ref, now);
        if (q) queued.push({ agentId, ...q });
      } catch (err) {
        this.d.log(
          `research scheduler: agent ${agentId}: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
        );
      }
    }
    return queued;
  }

  async tickAgent(ref: AgentRef, now: Date): Promise<{ kind: CycleKind; cycleId: string } | null> {
    const goal = await this.d.goalOf(ref);
    if (!goal) return null;
    const row = await this.d.research.schedule(ref);
    // The cycle records are the truth for what ran; the row remembers them for the page.
    const last = await this.d.lastStages(ref);
    const input: ScheduleInput = {
      now,
      intensity: goal.intensity,
      fast: row.fastCadence,
      paused: row.paused,
      openCycle: await this.d.openCycle(ref),
      lastScanAt: last.scanAt ?? row.lastScanAt,
      lastZoomOutAt: last.zoomOutAt ?? row.lastZoomOutAt,
      lastOverviewAt: last.overviewAt ?? row.lastOverviewAt,
      lastTriggerCycleAt: row.lastTriggerCycleAt,
      pending: await this.d.research.pending(ref),
      refreshesOverview: goal.intensity !== "LIGHT",
    };
    const work = decideWork(input);
    // What falls due next, once the work queued now has run.
    const due = nextDue({
      ...input,
      lastScanAt: work && work.kind !== "REVIEW" ? now : input.lastScanAt,
      lastZoomOutAt: work ? now : input.lastZoomOutAt,
    });
    if (!work) {
      await this.d.research.update(
        ref,
        {
          lastScanAt: input.lastScanAt,
          lastZoomOutAt: input.lastZoomOutAt,
          lastOverviewAt: input.lastOverviewAt,
          nextDueAt: due,
          ...(input.openCycle || row.paused ? {} : { waitingReason: null, waitingSince: null }),
        },
        now,
      );
      return null;
    }
    const room = await this.d.budgetRoom(ref, work.kind);
    if (!room.fits) {
      await this.d.research.update(
        ref,
        {
          waitingReason: room.reason,
          waitingSince: row.waitingReason === room.reason ? (row.waitingSince ?? now) : now,
          nextDueAt: due,
        },
        now,
      );
      return null;
    }
    let cycleId: string;
    try {
      ({ cycleId } = await this.d.enqueue(ref, work.kind, work.wantsOverview));
    } catch (err) {
      const reason: WaitReason = /credits/i.test(err instanceof Error ? err.message : "")
        ? "NO_CREDITS"
        : "CANNOT_START";
      await this.d.research.update(
        ref,
        { waitingReason: reason, waitingSince: now, nextDueAt: due },
        now,
      );
      this.d.log(`research scheduler: agent ${ref.agentId}: ${work.kind} did not start: ${reason}`);
      return null;
    }
    await this.d.research.answered(
      work.triggers.map((t) => t.triggerId),
      cycleId,
    );
    await this.d.research.update(
      ref,
      {
        waitingReason: null,
        waitingSince: null,
        nextDueAt: due,
        ...(work.triggers.length > 0 ? { lastTriggerCycleAt: now } : {}),
      },
      now,
    );
    this.d.log(`research scheduler: agent ${ref.agentId}: queued ${work.kind} (${work.reason})`);
    return { kind: work.kind, cycleId };
  }
}

// ---------------------------------------------------------------------------
// The watcher

export interface WatcherDeps {
  readonly chainId: number;
  readonly research: ResearchStore;
  readonly goalOf: (ref: AgentRef) => Promise<{
    intensity: ResearchIntensity;
    aggressiveness: Aggressiveness;
    brakeBps: number | null;
  } | null>;
  /** One observation of the agent's market, account, plan and blocked trades (since the baseline's time, for the flows); null where unreadable. */
  readonly observe: (ref: AgentRef, now: Date, since: Date | null) => Promise<Observation | null>;
  /** The last Zoom out's end, after which the baseline is taken again. */
  readonly lastZoomOutAt: (ref: AgentRef) => Promise<Date | null>;
  readonly now?: () => Date;
  readonly log: (line: string) => void;
}

export class Watcher {
  private readonly d: WatcherDeps;
  private readonly lastWatch = new Map<number, number>();
  constructor(d: WatcherDeps) {
    this.d = d;
  }

  /** One pass: every running agent due a look (every agent when forced), each trigger recorded once; returns what fired. */
  async tick(force = false): Promise<{ agentId: number; code: TriggerCode; spaced: boolean }[]> {
    const now = this.d.now?.() ?? new Date();
    const fired: { agentId: number; code: TriggerCode; spaced: boolean }[] = [];
    for (const agentId of await this.d.research.runningAgents(this.d.chainId)) {
      const ref = { chainId: this.d.chainId, agentId };
      try {
        for (const f of await this.watchAgent(ref, now, force)) fired.push({ agentId, ...f });
      } catch (err) {
        this.d.log(
          `watcher: agent ${agentId}: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
        );
      }
    }
    return fired;
  }

  async watchAgent(
    ref: AgentRef,
    now: Date,
    force = false,
  ): Promise<{ code: TriggerCode; spaced: boolean }[]> {
    const goal = await this.d.goalOf(ref);
    if (!goal) return [];
    const row = await this.d.research.schedule(ref);
    if (row.paused) return [];
    const c = cadence(goal.intensity, row.fastCadence);
    const last = this.lastWatch.get(ref.agentId) ?? 0;
    if (!force && now.getTime() - last < c.watchEveryMs) return [];
    this.lastWatch.set(ref.agentId, now.getTime());
    const o = await this.d.observe(ref, now, row.baseline ? new Date(row.baseline.takenAt) : null);
    if (!o) return [];
    const zoomOutAt = await this.d.lastZoomOutAt(ref);
    const stale =
      !row.baseline || (zoomOutAt !== null && new Date(row.baseline.takenAt) < zoomOutAt);
    if (stale) {
      await this.d.research.update(ref, { baseline: baselineFrom(o, goal.brakeBps) }, now);
      return [];
    }
    const found = detectTriggers({
      o,
      b: row.baseline as Baseline,
      aggressiveness: goal.aggressiveness,
      brakeBps: goal.brakeBps,
    });
    if (found.length === 0) return [];
    const pending = await this.d.research.pending(ref);
    const spaced =
      row.lastTriggerCycleAt !== null &&
      now.getTime() - row.lastTriggerCycleAt.getTime() < c.triggerSpacingMs;
    const out: { code: TriggerCode; spaced: boolean }[] = [];
    const b = row.baseline as Baseline;
    const rechecked: Record<string, string> = { ...b.rechecked };
    for (const t of found) {
      // Once per condition: a trigger already waiting for its cycle is not fired again.
      if (pending.some((p) => p.code === t.code)) continue;
      await this.d.research.recordTrigger(ref, t, now, spaced);
      if (t.code === "THESIS_RECHECK")
        rechecked[String(t.detail.token).toLowerCase()] = String(t.detail.recheckAt);
      out.push({ code: t.code, spaced });
      this.d.log(`watcher: agent ${ref.agentId}: ${t.code}${spaced ? " (spaced)" : ""}`);
    }
    // A fired condition becomes the new baseline for its own kind, so it fires once.
    const next: Baseline = {
      ...b,
      monUsdE18: found.some((t) => t.code === "PRICE_MOVE")
        ? o.monUsdE18 === null
          ? b.monUsdE18
          : o.monUsdE18.toString()
        : b.monUsdE18,
      volatilityAboveBrake: found.some((t) => t.code === "VOLATILITY_CROSSED")
        ? o.volatility24hPct !== null && goal.brakeBps !== null
          ? o.volatility24hPct * 100 > goal.brakeBps
          : b.volatilityAboveBrake
        : b.volatilityAboveBrake,
      mode: found.some((t) => t.code === "MODE_CHANGED") ? o.mode : b.mode,
      navUsdcE6: found.some((t) => t.code === "FLOW_MOVED")
        ? o.navUsdcE6 === null
          ? b.navUsdcE6
          : o.navUsdcE6.toString()
        : b.navUsdcE6,
      goalEpoch: found.some((t) => t.code === "GOAL_CHANGED") ? o.goalEpoch : b.goalEpoch,
      prices: {
        ...b.prices,
        ...Object.fromEntries(
          found
            .filter((t) => t.code === "POSITION_PRICE_MOVE")
            .map((t) => [
              String(t.detail.token).toLowerCase(),
              String(
                o.held.find((h) => h.token.toLowerCase() === String(t.detail.token).toLowerCase())
                  ?.priceE18 ?? b.prices[String(t.detail.token).toLowerCase()],
              ),
            ]),
        ),
      },
      liquidityUsd: {
        ...b.liquidityUsd,
        ...Object.fromEntries(
          found
            .filter((t) => t.code === "LIQUIDITY_DROP")
            .map((t) => [String(t.detail.token).toLowerCase(), Number(t.detail.toUsd)]),
        ),
      },
      screened: {
        ...b.screened,
        ...Object.fromEntries(
          found
            .filter((t) => t.code === "RESCREEN_FAILED")
            .map((t) => [
              String(t.detail.token).toLowerCase(),
              screenKey({
                screenVerdict: (t.detail.verdict as string | null) ?? null,
                registryStatus: (t.detail.status as string | null) ?? null,
              }),
            ]),
        ),
      },
      rechecked,
    };
    await this.d.research.update(ref, { baseline: next }, now);
    return out;
  }
}
