import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Baseline,
  type Observation,
  PRICE_TRIGGER_BPS,
  ResearchScheduler,
  ResearchStore,
  type ScheduleInput,
  type SchedulerDeps,
  TRIGGER_KIND,
  Watcher,
  type WatcherDeps,
  baselineFrom,
  cadence,
  decideWork,
  detectTriggers,
  nextDue,
} from "./research-loop.ts";
import { CHAIN, indexAgent } from "./testing.ts";

/**
 * The autonomous loop (P3-U10): the scheduler's decisions and the watcher's
 * triggers are pure functions over records and a clock, so every cadence,
 * priority, spacing and once-per-condition rule is proven here with fast
 * clocks; then the store, the scheduler and the watcher run over Postgres
 * with fakes for the platform's readers.
 */
const HOUR = 3_600_000;
const MIN = 60_000;
const T0 = new Date("2026-10-11T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

const base: ScheduleInput = {
  now: T0,
  intensity: "STANDARD",
  fast: false,
  paused: false,
  openCycle: false,
  lastScanAt: at(-1 * HOUR),
  lastZoomOutAt: at(-2 * HOUR),
  lastOverviewAt: at(-2 * HOUR),
  lastTriggerCycleAt: null,
  pending: [],
  refreshesOverview: true,
};
const trigger = (code: keyof typeof TRIGGER_KIND, firedAt = at(-MIN)) => ({
  triggerId: `trigger-${code}`,
  code,
  firedAt,
});

describe("the cadence by intensity", () => {
  it("scans every 12, 6 or 3 hours, reviews daily, refreshes the overview weekly, and spaces triggers two hours apart", () => {
    expect(cadence("LIGHT", false)).toMatchObject({ scanEveryMs: 12 * HOUR, divesPerDay: 1 });
    expect(cadence("STANDARD", false)).toMatchObject({ scanEveryMs: 6 * HOUR, divesPerDay: 2 });
    expect(cadence("DEEP", false)).toMatchObject({
      scanEveryMs: 3 * HOUR,
      zoomOutEveryMs: 24 * HOUR,
      overviewEveryMs: 7 * 24 * HOUR,
      triggerSpacingMs: 2 * HOUR,
      watchEveryMs: 5 * MIN,
      divesPerDay: 4,
    });
  });

  it("the fork's fast cadence runs in minutes, with the same Dives per day", () => {
    expect(cadence("STANDARD", true)).toMatchObject({
      scanEveryMs: 2 * MIN,
      zoomOutEveryMs: 5 * MIN,
      triggerSpacingMs: 1 * MIN,
      watchEveryMs: 30_000,
      divesPerDay: 2,
    });
  });
});

describe("what the scheduler decides", () => {
  it("does nothing while paused or while a cycle is open", () => {
    expect(decideWork({ ...base, paused: true, lastScanAt: null })).toBeNull();
    expect(decideWork({ ...base, openCycle: true, lastScanAt: null })).toBeNull();
  });

  it("runs the routine Scan once the intensity's interval has passed, and not before", () => {
    expect(decideWork(base)).toBeNull();
    expect(decideWork({ ...base, lastScanAt: at(-6 * HOUR) })).toMatchObject({
      kind: "ROUTINE",
      wantsOverview: false,
      triggers: [],
    });
    expect(decideWork({ ...base, intensity: "LIGHT", lastScanAt: at(-6 * HOUR) })).toBeNull();
    expect(decideWork({ ...base, lastScanAt: null })).toMatchObject({ kind: "ROUTINE" });
  });

  it("runs the daily review (the Zoom out alone) before a routine Scan that is also due", () => {
    const w = decideWork({ ...base, lastScanAt: at(-7 * HOUR), lastZoomOutAt: at(-25 * HOUR) });
    expect(w).toMatchObject({ kind: "REVIEW", wantsOverview: false, reason: "the daily review" });
  });

  it("refreshes the overview with the daily review after a week at Standard or Deep, never at Light", () => {
    const week = { ...base, lastZoomOutAt: at(-25 * HOUR), lastOverviewAt: at(-8 * 24 * HOUR) };
    expect(decideWork(week)).toMatchObject({ kind: "REVIEW", wantsOverview: true });
    expect(decideWork({ ...week, lastOverviewAt: null })).toMatchObject({ wantsOverview: true });
    expect(decideWork({ ...week, refreshesOverview: false })).toMatchObject({ wantsOverview: false });
    // A routine Scan due at the same time carries the wish too, so the Zoom out it ends with refreshes it.
    expect(decideWork({ ...week, lastZoomOutAt: at(-HOUR), lastScanAt: at(-7 * HOUR) })).toMatchObject({
      kind: "ROUTINE",
      wantsOverview: true,
    });
  });

  it("answers a trigger before the cadence's own work: a review for the free kinds, a Scan for a market move", () => {
    const review = decideWork({ ...base, pending: [trigger("MODE_CHANGED")] });
    expect(review).toMatchObject({ kind: "REVIEW", triggers: [{ code: "MODE_CHANGED" }] });
    const scan = decideWork({ ...base, pending: [trigger("PRICE_MOVE")] });
    expect(scan).toMatchObject({ kind: "TRIGGERED", triggers: [{ code: "PRICE_MOVE" }] });
    // Both kinds waiting: the review runs first and the Scan's trigger stays in the queue.
    const both = decideWork({ ...base, pending: [trigger("PRICE_MOVE"), trigger("GOAL_CHANGED")] });
    expect(both).toMatchObject({ kind: "REVIEW", triggers: [{ code: "GOAL_CHANGED" }] });
  });

  it("spaces triggered cycles: inside two hours of the last one the trigger waits, and the cadence's work still runs", () => {
    const spaced = { ...base, lastTriggerCycleAt: at(-HOUR), pending: [trigger("PRICE_MOVE")] };
    expect(decideWork(spaced)).toBeNull();
    expect(decideWork({ ...spaced, lastScanAt: at(-7 * HOUR) })).toMatchObject({ kind: "ROUTINE" });
    expect(decideWork({ ...spaced, lastTriggerCycleAt: at(-2 * HOUR) })).toMatchObject({
      kind: "TRIGGERED",
    });
    // The fast cadence spaces by a minute.
    expect(decideWork({ ...spaced, fast: true })).toMatchObject({ kind: "TRIGGERED" });
  });

  it("names when the next cadence work is due, and nothing while paused", () => {
    expect(nextDue(base)).toEqual(at(5 * HOUR));
    expect(nextDue({ ...base, lastZoomOutAt: at(-23 * HOUR) })).toEqual(at(HOUR));
    expect(nextDue({ ...base, lastScanAt: null })).toEqual(T0);
    expect(nextDue({ ...base, paused: true })).toBeNull();
  });
});

const WMON = "0x00000000000000000000000000000000000000aa";
const ALT = "0x00000000000000000000000000000000000000ab";
const observation = (over: Partial<Observation> = {}): Observation => ({
  at: T0,
  monUsdE18: 10n ** 18n,
  volatility24hPct: 100,
  mode: "NORMAL",
  navUsdcE6: 100_000_000n,
  goalEpoch: "3",
  blockedIn24h: {},
  settledSinceBaseline: 0,
  held: [
    {
      token: WMON,
      symbol: "WMON",
      priceE18: 10n ** 18n,
      liquidityUsd: 1_000_000,
      screenVerdict: "passed",
      registryStatus: "listed",
    },
  ],
  rechecks: [{ token: WMON, symbol: "WMON", at: at(24 * HOUR) }],
  ...over,
});
const BRAKE = 20_000;

describe("what the watcher fires", () => {
  const b = baselineFrom(observation(), BRAKE);
  const fire = (o: Observation, bl: Baseline = b) =>
    detectTriggers({ o, b: bl, aggressiveness: "BALANCED", brakeBps: BRAKE }).map((t) => t.code);

  it("takes the baseline from an observation", () => {
    expect(b).toMatchObject({
      takenAt: T0.toISOString(),
      monUsdE18: (10n ** 18n).toString(),
      volatilityAboveBrake: false,
      mode: "NORMAL",
      navUsdcE6: "100000000",
      goalEpoch: "3",
      prices: { [WMON]: (10n ** 18n).toString() },
      liquidityUsd: { [WMON]: 1_000_000 },
      screened: { [WMON]: "passed/listed" },
      rechecked: {},
    });
  });

  it("fires nothing while nothing changed", () => {
    expect(fire(observation({ at: at(5 * MIN) }))).toEqual([]);
  });

  it("MON's price move past the level's trigger: 5%, 7% or 10% by aggressiveness", () => {
    const up = observation({ monUsdE18: 10n ** 18n + 6n * 10n ** 16n });
    expect(fire(up)).toEqual([]);
    expect(detectTriggers({ o: up, b, aggressiveness: "CONSERVATIVE", brakeBps: BRAKE }).map((t) => t.code)).toEqual(["PRICE_MOVE"]);
    const down = observation({ monUsdE18: 92n * 10n ** 16n });
    expect(fire(down)).toEqual(["PRICE_MOVE"]);
    expect(PRICE_TRIGGER_BPS).toEqual({ CONSERVATIVE: 500, BALANCED: 700, AGGRESSIVE: 1_000 });
  });

  it("volatility crossing the plan's brake, either way, and never while unreadable", () => {
    expect(fire(observation({ volatility24hPct: 250 }))).toEqual(["VOLATILITY_CROSSED"]);
    expect(fire(observation({ volatility24hPct: null }))).toEqual([]);
    const above = baselineFrom(observation({ volatility24hPct: 250 }), BRAKE);
    expect(fire(observation({ volatility24hPct: 100 }), above)).toEqual(["VOLATILITY_CROSSED"]);
    expect(fire(observation({ volatility24hPct: 300 }), above)).toEqual([]);
  });

  it("the mode, the goal and a flow of a fifth without a trade; a trade's own value move is not a flow", () => {
    expect(fire(observation({ mode: "SELL_ONLY" }))).toEqual(["MODE_CHANGED"]);
    expect(fire(observation({ goalEpoch: "4" }))).toEqual(["GOAL_CHANGED"]);
    expect(fire(observation({ navUsdcE6: 79_000_000n }))).toEqual(["FLOW_MOVED"]);
    expect(fire(observation({ navUsdcE6: 85_000_000n }))).toEqual([]);
    expect(fire(observation({ navUsdcE6: 79_000_000n, settledSinceBaseline: 1 }))).toEqual([]);
  });

  it("the same trade blocked three times in 24 hours", () => {
    expect(fire(observation({ blockedIn24h: { COOLDOWN: 2 } }))).toEqual([]);
    expect(fire(observation({ blockedIn24h: { COOLDOWN: 3 } }))).toEqual(["TRADE_BLOCKED_3X"]);
  });

  it("a thesis at its recheck time, once", () => {
    const due = observation({ at: at(24 * HOUR) });
    expect(fire(due)).toEqual(["THESIS_RECHECK"]);
    expect(fire(due, { ...b, rechecked: { [WMON]: at(24 * HOUR).toISOString() } })).toEqual([]);
  });

  it("a held token's price past the level's review trigger, its liquidity halved, its re-screen failed or sell-only", () => {
    const held = (over: Partial<Observation["held"][number]>) =>
      observation({ held: [{ ...observation().held[0]!, ...over }] });
    expect(fire(held({ priceE18: 114n * 10n ** 16n }))).toEqual([]);
    expect(fire(held({ priceE18: 85n * 10n ** 16n }))).toEqual(["POSITION_PRICE_MOVE"]);
    expect(fire(held({ liquidityUsd: 600_000 }))).toEqual([]);
    expect(fire(held({ liquidityUsd: 500_000 }))).toEqual(["LIQUIDITY_DROP"]);
    expect(fire(held({ screenVerdict: "refused" }))).toEqual(["RESCREEN_FAILED"]);
    expect(fire(held({ registryStatus: "sell_only" }))).toEqual(["RESCREEN_FAILED"]);
    // A token the baseline never saw (bought since) fires nothing until the baseline is taken again.
    expect(fire(observation({ held: [{ ...observation().held[0]!, token: ALT, priceE18: 1n }] }))).toEqual([]);
  });
});

const dbUp = await databaseAvailable();
describe.skipIf(!dbUp)("the research loop over Postgres", () => {
  let t: TestDatabase;
  let research: ResearchStore;
  const ref = { chainId: CHAIN, agentId: 1 };
  const log: string[] = [];

  beforeAll(async () => {
    t = await createTestDatabase("research_loop");
    research = new ResearchStore(t.db);
    await indexAgent(t.db, 1, null);
    await indexAgent(t.db, 2, null);
    await t.db
      .insertInto("platform.agent_states")
      .values([
        { chain_id: CHAIN, agent_id: 1, state: "RUNNING" },
        { chain_id: CHAIN, agent_id: 2, state: "READY" },
      ])
      .execute();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    log.length = 0;
    await t.db.deleteFrom("platform.research_triggers").execute();
    await t.db.deleteFrom("platform.research_schedules").execute();
  });

  it("the loop runs for RUNNING agents only, and the schedule row starts empty", async () => {
    expect(await research.runningAgents(CHAIN)).toEqual([1]);
    expect(await research.schedule(ref)).toMatchObject({ paused: false, fastCadence: false, baseline: null });
    await research.update(ref, { paused: true, nextDueAt: T0 }, T0);
    expect(await research.schedule(ref)).toMatchObject({ paused: true, nextDueAt: T0, updatedAt: T0 });
    await research.update(ref, { fastCadence: true }, at(MIN));
    expect(await research.schedule(ref)).toMatchObject({ paused: true, fastCadence: true });
  });

  it("records triggers, lists the pending ones oldest first and marks them answered by a cycle", async () => {
    const a = await research.recordTrigger(ref, { code: "PRICE_MOVE", detail: { moveBps: 800 } }, at(-MIN), false);
    const b = await research.recordTrigger(ref, { code: "MODE_CHANGED", detail: {} }, at(-2 * MIN), true);
    expect((await research.pending(ref)).map((p) => p.triggerId)).toEqual([b, a]);
    await research.answered([a], "cycle-1");
    expect((await research.pending(ref)).map((p) => p.code)).toEqual(["MODE_CHANGED"]);
    expect(await research.recent(ref)).toMatchObject([
      { code: "PRICE_MOVE", cycleId: "cycle-1", spaced: false, detail: { moveBps: 800 } },
      { code: "MODE_CHANGED", cycleId: null, spaced: true },
    ]);
  });

  function scheduler(over: Partial<SchedulerDeps> = {}, clock: { now: Date } = { now: T0 }) {
    const queued: { kind: string; wantsOverview: boolean }[] = [];
    const deps: SchedulerDeps = {
      chainId: CHAIN,
      research,
      goalOf: async () => ({ intensity: "STANDARD", aggressiveness: "BALANCED", dailyBudgetUsdcE6: 2_000_000n }),
      openCycle: async () => false,
      budgetRoom: async () => ({ fits: true, reason: null }),
      enqueue: async (_ref, kind, wantsOverview) => {
        queued.push({ kind, wantsOverview });
        return { cycleId: `cycle-${queued.length}` };
      },
      lastStages: async () => ({ scanAt: null, zoomOutAt: null, overviewAt: null }),
      now: () => clock.now,
      log: (l) => log.push(l),
      ...over,
    };
    return { s: new ResearchScheduler(deps), queued };
  }

  it("queues the cadence's work for a running agent and records what is due next", async () => {
    const { s, queued } = scheduler({
      lastStages: async () => ({ scanAt: at(-HOUR), zoomOutAt: at(-25 * HOUR), overviewAt: at(-HOUR) }),
    });
    expect(await s.tick()).toEqual([{ agentId: 1, kind: "REVIEW", cycleId: "cycle-1" }]);
    expect(queued).toEqual([{ kind: "REVIEW", wantsOverview: false }]);
    expect(await research.schedule(ref)).toMatchObject({
      waitingReason: null,
      // The Scan falls due before tomorrow's review.
      nextDueAt: at(5 * HOUR),
      lastTriggerCycleAt: null,
    });
    expect(log).toEqual(["research scheduler: agent 1: queued REVIEW (the daily review)"]);
  });

  it("waits with the reason when the budget or the credits are short, and clears it once the work starts", async () => {
    const room = { fits: false, reason: "BUDGET_SHORT" as const };
    const { s, queued } = scheduler({ budgetRoom: async () => room });
    expect(await s.tick()).toEqual([]);
    expect(queued).toEqual([]);
    expect(await research.schedule(ref)).toMatchObject({ waitingReason: "BUDGET_SHORT", waitingSince: T0 });
    // The same reason keeps its start time on the next pass.
    const later = scheduler({ budgetRoom: async () => room }, { now: at(10 * MIN) });
    await later.s.tick();
    expect(await research.schedule(ref)).toMatchObject({ waitingReason: "BUDGET_SHORT", waitingSince: T0 });
    const ok = scheduler({}, { now: at(20 * MIN) });
    expect(await ok.s.tick()).toMatchObject([{ kind: "ROUTINE" }]);
    expect(await research.schedule(ref)).toMatchObject({ waitingReason: null, waitingSince: null });
  });

  it("answers pending triggers with a cycle, marks them, and spaces the next one", async () => {
    await research.recordTrigger(ref, { code: "PRICE_MOVE", detail: {} }, at(-MIN), false);
    const { s, queued } = scheduler({
      lastStages: async () => ({ scanAt: at(-HOUR), zoomOutAt: at(-HOUR), overviewAt: at(-HOUR) }),
    });
    expect(await s.tick()).toMatchObject([{ kind: "TRIGGERED" }]);
    expect(queued).toEqual([{ kind: "TRIGGERED", wantsOverview: false }]);
    expect(await research.pending(ref)).toEqual([]);
    expect((await research.recent(ref))[0]).toMatchObject({ code: "PRICE_MOVE", cycleId: "cycle-1" });
    expect(await research.schedule(ref)).toMatchObject({ lastTriggerCycleAt: T0 });
    // A trigger an hour later waits for the spacing.
    await research.recordTrigger(ref, { code: "GOAL_CHANGED", detail: {} }, at(HOUR), true);
    const soon = scheduler({ lastStages: async () => ({ scanAt: at(-HOUR), zoomOutAt: at(-HOUR), overviewAt: at(-HOUR) }) }, { now: at(HOUR) });
    expect(await soon.s.tick()).toEqual([]);
    const after = scheduler({ lastStages: async () => ({ scanAt: at(-HOUR), zoomOutAt: at(-HOUR), overviewAt: at(-HOUR) }) }, { now: at(2 * HOUR) });
    expect(await after.s.tick()).toMatchObject([{ kind: "REVIEW" }]);
  });

  it("does nothing for a paused agent, one with a cycle open or one whose start fails, and says why", async () => {
    await research.update(ref, { paused: true });
    const paused = scheduler({ lastStages: async () => ({ scanAt: null, zoomOutAt: null, overviewAt: null }) });
    expect(await paused.s.tick()).toEqual([]);
    await research.update(ref, { paused: false });
    const open = scheduler({ openCycle: async () => true });
    expect(await open.s.tick()).toEqual([]);
    const failing = scheduler({
      enqueue: async () => {
        throw new Error("Agent 1 has no credits left");
      },
    });
    expect(await failing.s.tick()).toEqual([]);
    expect(await research.schedule(ref)).toMatchObject({ waitingReason: "NO_CREDITS" });
    expect(log.at(-1)).toBe("research scheduler: agent 1: ROUTINE did not start: NO_CREDITS");
  });

  function watcher(obs: () => Observation | null, over: Partial<WatcherDeps> = {}, clock: { now: Date } = { now: T0 }) {
    const deps: WatcherDeps = {
      chainId: CHAIN,
      research,
      goalOf: async () => ({ intensity: "STANDARD", aggressiveness: "BALANCED", brakeBps: BRAKE }),
      observe: async () => obs(),
      lastZoomOutAt: async () => null,
      now: () => clock.now,
      log: (l) => log.push(l),
      ...over,
    };
    return new Watcher(deps);
  }

  it("takes the baseline on the first pass, fires each condition once, and takes it again after a Zoom out", async () => {
    const clock = { now: T0 };
    let seen = observation();
    const w = watcher(() => ({ ...seen, at: clock.now }), {}, clock);
    expect(await w.tick()).toEqual([]);
    expect((await research.schedule(ref)).baseline).toMatchObject({ takenAt: T0.toISOString() });
    // Within the watch interval nothing is looked at; forced, the same observation fires nothing.
    clock.now = at(MIN);
    expect(await w.tick()).toEqual([]);
    expect(await w.tick(true)).toEqual([]);
    // A 9% fall fires once; the next pass with the same price fires nothing more.
    seen = observation({ monUsdE18: 91n * 10n ** 16n });
    clock.now = at(6 * MIN);
    expect(await w.tick()).toEqual([{ agentId: 1, code: "PRICE_MOVE", spaced: false }]);
    expect((await research.pending(ref)).map((p) => p.code)).toEqual(["PRICE_MOVE"]);
    clock.now = at(12 * MIN);
    expect(await w.tick()).toEqual([]);
    // The baseline moved to the fired price, so a further 9% fall from there fires again once answered.
    expect((await research.schedule(ref)).baseline).toMatchObject({ monUsdE18: (91n * 10n ** 16n).toString() });
    // After a Zoom out the baseline is taken again from what the watcher sees then.
    const w2 = watcher(() => ({ ...observation({ monUsdE18: 50n * 10n ** 16n }), at: clock.now }), { lastZoomOutAt: async () => at(13 * MIN) }, clock);
    clock.now = at(20 * MIN);
    expect(await w2.tick()).toEqual([]);
    expect((await research.schedule(ref)).baseline).toMatchObject({
      takenAt: at(20 * MIN).toISOString(),
      monUsdE18: (50n * 10n ** 16n).toString(),
    });
    expect(log).toEqual(["watcher: agent 1: PRICE_MOVE"]);
  });

  it("marks a trigger spaced inside two hours of the last triggered cycle, and fires nothing while paused or unreadable", async () => {
    const clock = { now: T0 };
    await research.update(ref, { lastTriggerCycleAt: at(-30 * MIN) });
    let seen: Observation | null = observation();
    const w = watcher(() => (seen ? { ...seen, at: clock.now } : null), {}, clock);
    await w.tick();
    seen = observation({ mode: "SELL_ONLY" });
    clock.now = at(6 * MIN);
    expect(await w.tick()).toEqual([{ agentId: 1, code: "MODE_CHANGED", spaced: true }]);
    expect((await research.recent(ref))[0]).toMatchObject({ code: "MODE_CHANGED", spaced: true, detail: { from: "NORMAL", to: "SELL_ONLY" } });
    // The condition is pending: it is not fired again while its cycle has not run.
    clock.now = at(12 * MIN);
    expect(await w.tick()).toEqual([]);
    seen = null;
    clock.now = at(18 * MIN);
    expect(await w.tick()).toEqual([]);
    await research.update(ref, { paused: true });
    seen = observation({ mode: "PAUSED" });
    clock.now = at(24 * MIN);
    expect(await w.tick()).toEqual([]);
  });
});
