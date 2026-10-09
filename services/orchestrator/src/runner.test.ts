import type { AgentState, ChainReader, MarketState } from "@alpha-agents/chain-tools";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { DEFAULT_GOAL_INPUT } from "@alpha-agents/domain";
import { LAUNCH_EXECUTOR_POLICY, LAUNCH_POLICY_HASH, translateGoal } from "@alpha-agents/policy";
import { DecisionStore, GoalStore, PlanStore, TradeStore } from "@alpha-agents/trading";
import { type Hex, getAddress } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunnerFacts, templateRunnerEntry, validateNarration } from "./narrator.ts";
import { TemplateRunner } from "./runner.ts";
import { Store } from "./store.ts";
import { CHAIN } from "./testing.ts";
import { PgIntentStore } from "./tools/chain-store.ts";

/**
 * The template runner (P3-U3) against Postgres with the real plan, decision,
 * goal, trade and intent stores and a chain the tests change field by field:
 * every hold reason, legs sized and split by the rule, the strategy epoch,
 * decisions stored only on change over a day of ticks, narration, and no
 * model call anywhere.
 */
const dbUp = await databaseAvailable();
const NOW = 1_790_000_000n;
const PX = 25_000_000_000_000_000n;
const OWNER = getAddress("0x00000000000000000000000000000000000a11ce");
const KEY = getAddress("0x00000000000000000000000000000000000000ee");
const wmonWorth = (usdcE6: bigint) => (usdcE6 * 10n ** 30n) / PX;

class FakeChain implements ChainReader {
  readonly chainId = CHAIN;
  agentState: AgentState = FakeChain.agent();
  quoteBps = 9_988n;
  priceE18 = PX;
  block = 500n;

  static agent(over: Partial<AgentState> = {}): AgentState {
    return {
      block: 500n,
      timestamp: NOW,
      owner: OWNER,
      ownerEpoch: 1n,
      configEpoch: 0n,
      account: "0x00000000000000000000000000000000000ac001",
      usdc: 100_000_000n,
      wmon: 0n,
      mode: "NORMAL",
      breaker: { nav: 100_000_000n, perUnit: 10n ** 18n, peak: 10n ** 18n, drawdownBps: 0n },
      peak7d: 10n ** 18n,
      grant: { key: KEY, ownerEpoch: 1n, configEpoch: 0n, validUntil: NOW + 20n * 86_400n },
      trades: [],
      tradesLeft: 20,
      nextSlotFreesAt: 0n,
      turnoverUsed: 0n,
      venueAllowed: { buy: true, sell: true },
      ...over,
    };
  }
  set(over: Partial<AgentState>) {
    this.agentState = { ...this.agentState, ...over };
  }
  async market(): Promise<MarketState> {
    return {
      chainId: CHAIN,
      block: this.block,
      timestamp: NOW,
      policy: { ...LAUNCH_EXECUTOR_POLICY },
      policyHash: LAUNCH_POLICY_HASH,
      paused: false,
      wmonBuyable: true,
      monUsd: { priceE18: this.priceE18, updatedAt: NOW - 20n, reason: "OK" },
      usdcUsd: { priceE18: 10n ** 18n, updatedAt: NOW - 600n, reason: "OK" },
      pool: { priceE18: this.priceE18, reason: "OK" },
      deviationBps: 0n,
      tradableReason: "OK",
      venue: {
        adapterId: `0x${"ad".repeat(32)}`,
        adapter: "0x00000000000000000000000000000000000000ad",
        feeBps: 5,
        poolKey: {
          currency0: "0x0000000000000000000000000000000000000000",
          currency1: "0x00000000000000000000000000000000000000c1",
          fee: 500,
          tickSpacing: 10,
          hooks: "0x0000000000000000000000000000000000000000",
        },
      },
    };
  }
  async agent(): Promise<AgentState> {
    return { ...this.agentState, block: this.block };
  }
  async quote(sell: "USDC" | "WMON", amountIn: bigint) {
    const implied =
      sell === "USDC"
        ? (amountIn * 10n ** 30n) / this.priceE18
        : (amountIn * this.priceE18) / 10n ** 30n;
    return { block: this.block, amountOut: (implied * this.quoteBps) / 10_000n };
  }
  tokenOf(asset: "USDC" | "WMON"): Hex {
    return asset === "USDC"
      ? "0x00000000000000000000000000000000000000c1"
      : "0x00000000000000000000000000000000000000c2";
  }
}

describe.skipIf(!dbUp)("the template runner (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let store: Store;
  let plans: PlanStore;
  let decisions: DecisionStore;
  let goals: GoalStore;
  let trades: TradeStore;
  let chain: FakeChain;
  let volatility: number | null;
  let gasBalance: bigint | null;
  let now: Date;
  let narrated: { key: string; facts: RunnerFacts }[];

  const runner = () =>
    new TemplateRunner({
      chainId: CHAIN,
      reader: chain,
      plans,
      decisions,
      goals,
      trades,
      intents: new PgIntentStore(store),
      sessionKeyOf: async () => KEY,
      volatility24hPct: async () => volatility,
      gas:
        gasBalance === null
          ? null
          : { balance: async () => gasBalance ?? 0n, swapCost: async () => 10n ** 16n },
      narrator: {
        narrateEvent: async (_c, _a, key, facts) => {
          narrated.push({ key, facts });
        },
      },
      now: () => now,
      log: () => undefined,
    });

  const goal = () => {
    const r = translateGoal(DEFAULT_GOAL_INPUT);
    if (!r.ok) throw new Error("goal");
    return r.config;
  };
  const saveGoal = () =>
    goals.save({ chainId: CHAIN, agentId: 1, ownerEpoch: 1n, savedBy: OWNER, config: goal() });
  const setPlan = (over: Partial<ReturnType<typeof goal>["template"]["params"]> = {}) =>
    plans.set({
      chainId: CHAIN,
      agentId: 1,
      params: { ...goal().template.params, ...over },
      setBy: "console",
    });
  async function arm() {
    const { record } = await trades.startArming({
      chainId: CHAIN,
      agentId: 1,
      owner: OWNER,
      ownerEpoch: 1n,
      configEpoch: 0n,
      sessionKey: KEY,
      validUntil: NOW + 20n * 86_400n,
    });
    await trades.markArmed(record.armingId, "intent-first");
  }
  const intents = () => trades.intents(CHAIN, 1, 50);
  const setStatus = (id: string, status: string) =>
    t.db
      .updateTable("platform.intents")
      .set({ status: status as never })
      .where("intent_id", "=", id)
      .execute();

  beforeAll(async () => {
    t = await createTestDatabase("orch_runner");
    store = new Store(t.db);
    plans = new PlanStore(t.db);
    decisions = new DecisionStore(t.db);
    goals = new GoalStore(t.db);
    trades = new TradeStore(t.db);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    for (const table of [
      "platform.intents",
      "platform.arming",
      "platform.runner_decisions",
      "platform.strategy_params",
      "platform.agent_goals",
      "platform.agent_state_changes",
      "platform.agent_states",
    ] as const)
      await t.db.deleteFrom(table).execute();
    chain = new FakeChain();
    volatility = 110;
    gasBalance = null;
    // The stores expire intents on the real clock, so the runner runs on it too.
    now = new Date();
    narrated = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs only agents with a plan, and holds an unarmed agent's plan with NOT_ARMED", async () => {
    await saveGoal();
    expect(await runner().tick()).toEqual([]);
    const plan = await setPlan();
    expect((await goals.view(CHAIN, 1, 1n)).state).toBe("RUNNING");
    const [d] = await runner().tick();
    expect(d).toMatchObject({ outcome: "hold", code: "NOT_ARMED", paramId: plan.paramId });
    expect(await intents()).toEqual([]);
  });

  it("from 0% WMON to a 20% target: a capped leg as a template intent at the plan's epoch, then LEG_PENDING, then the next leg, then IN_BAND", async () => {
    await saveGoal();
    const plan = await setPlan();
    await arm();
    const [first] = await runner().tick();
    expect(first).toMatchObject({
      outcome: "leg",
      leg: { sell: "USDC", buy: "WMON", amountIn: "9950000" },
      strategyEpoch: plan.strategyEpoch,
    });
    const [i1] = await intents();
    expect(i1).toMatchObject({
      intentId: first?.intentId,
      source: "template",
      status: "awaiting_approval",
      strategyEpoch: plan.strategyEpoch,
      amountIn: 9_950_000n,
    });
    // The same tick again proposes nothing new: the leg is on its way.
    expect((await runner().tick())[0]).toMatchObject({ outcome: "hold", code: "LEG_PENDING" });
    expect(await intents()).toHaveLength(1);
    // It settles: the account is now at about 10%, still outside the band, so a second leg.
    await setStatus(i1?.intentId ?? "", "reconciled");
    chain.set({ usdc: 90_050_000n, wmon: wmonWorth(9_950_000n) });
    chain.block = 501n;
    const [second] = await runner().tick();
    expect(second).toMatchObject({ outcome: "leg", leg: { sell: "USDC" } });
    expect(BigInt(second?.leg?.amountIn ?? 0)).toBeLessThanOrEqual(9_950_000n);
    const all = await intents();
    expect(all).toHaveLength(2);
    await setStatus(second?.intentId ?? "", "reconciled");
    chain.set({ usdc: 80_000_000n, wmon: wmonWorth(20_000_000n) });
    chain.block = 502n;
    expect((await runner().tick())[0]).toMatchObject({ outcome: "hold", code: "IN_BAND" });
    // The narrator was asked for both legs and for "back in band", each held to the validator.
    expect(narrated.map((n) => n.facts.event)).toEqual(["leg", "leg", "in_band"]);
    for (const n of narrated)
      expect(validateNarration(templateRunnerEntry(n.facts), n.facts)).toEqual({ ok: true });
  });

  it("a day of ticks in band is one decision row (lesson 17: the block is fixed)", async () => {
    await saveGoal();
    await setPlan();
    await arm();
    chain.set({ usdc: 80_000_000n, wmon: wmonWorth(20_000_000n) });
    const r = runner();
    const start = Date.now();
    for (let i = 0; i < 1_440; i += 1) {
      now = new Date(start + i * 60_000);
      await r.tick();
    }
    const rows = await decisions.recent(CHAIN, 1, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: "IN_BAND", ticks: 1_440 });
    expect((rows[0]?.lastAt.getTime() ?? 0) - (rows[0]?.firstAt.getTime() ?? 0)).toBe(
      1_439 * 60_000,
    );
  });

  it("a plan set before the goal changed never trades: STRATEGY_EPOCH_STALE until a new plan", async () => {
    await saveGoal();
    await setPlan();
    await arm();
    await saveGoal();
    expect((await runner().tick())[0]).toMatchObject({
      outcome: "hold",
      code: "STRATEGY_EPOCH_STALE",
    });
    expect(await intents()).toEqual([]);
    await setPlan();
    expect((await runner().tick())[0]).toMatchObject({ outcome: "leg" });
  });

  it("holds buys at the volatility brake and when volatility is unknown, while sales go through", async () => {
    await saveGoal();
    await setPlan();
    await arm();
    volatility = 250;
    expect((await runner().tick())[0]).toMatchObject({ code: "VOLATILITY_BRAKE" });
    volatility = null;
    expect((await runner().tick())[0]).toMatchObject({ code: "VOLATILITY_UNAVAILABLE" });
    volatility = 250;
    chain.set({ usdc: 65_000_000n, wmon: wmonWorth(35_000_000n) });
    expect((await runner().tick())[0]).toMatchObject({ outcome: "leg", leg: { sell: "WMON" } });
    expect(narrated.map((n) => [n.facts.event, n.facts.reason?.code ?? null])).toEqual([
      ["hold", "VOLATILITY_BRAKE"],
      ["hold", "VOLATILITY_UNAVAILABLE"],
      ["leg", null],
    ]);
  });

  it("holds COST_HURDLE when the quote costs more than the plan allows", async () => {
    await saveGoal();
    await setPlan();
    await arm();
    chain.quoteBps = 9_940n;
    const [d] = await runner().tick();
    expect(d).toMatchObject({ outcome: "hold", code: "COST_HURDLE" });
    expect(d?.facts).toMatchObject({ costBps: 60 });
  });

  it("records the Executor's reasons when its rules would refuse the leg, and proposes nothing", async () => {
    await saveGoal();
    await setPlan();
    await arm();
    // Two trades of 50 USDC in the last day use the whole 100% turnover (the Executor's window).
    chain.set({
      trades: [
        { at: NOW - 600n, valueUsdcE6: 50_000_000n },
        { at: NOW - 1_200n, valueUsdcE6: 50_000_000n },
      ],
    });
    const [d] = await runner().tick();
    expect(d).toMatchObject({ outcome: "hold", code: "TURNOVER_CAP" });
    chain.set({ trades: [], mode: "PAUSED" });
    expect((await runner().tick())[0]?.codes).toContain("PAUSED");
    chain.set({ mode: "NORMAL" });
    chain.priceE18 = 0n;
    expect((await runner().tick())[0]).toMatchObject({ code: "ORACLE_STALE" });
    expect(await intents()).toEqual([]);
  });

  it("holds OWNER_TRADE_LIMIT at the owner's trades per day, and GAS_UNFUNDED off the fork", async () => {
    await saveGoal();
    await setPlan();
    await arm();
    const limit = goal().ownerLimits.maxTradesPer24h;
    chain.set({
      trades: Array.from({ length: limit }, (_, i) => ({
        at: NOW - 60n * BigInt(i + 1),
        valueUsdcE6: 1_000_000n,
      })),
    });
    expect((await runner().tick())[0]).toMatchObject({ code: "OWNER_TRADE_LIMIT" });
    chain.set({ trades: [] });
    gasBalance = 0n;
    expect((await runner().tick())[0]).toMatchObject({ code: "GAS_UNFUNDED" });
    gasBalance = 10n ** 18n;
    expect((await runner().tick())[0]).toMatchObject({ outcome: "leg" });
  });

  it("a leg refused at submission is recorded with its reasons and tried again only once they can clear", async () => {
    await saveGoal();
    await setPlan();
    await arm();
    const [leg] = await runner().tick();
    const refuse = (blockers: unknown[]) =>
      t.db
        .updateTable("platform.intents")
        .set({ status: "rejected", blockers: JSON.stringify(blockers), updated_at: now })
        .where("intent_id", "=", leg?.intentId ?? "")
        .execute();
    // A reason that clears by waiting: held with it until it can have cleared, then tried again.
    await refuse([
      { code: "TURNOVER_CAP", message: "m", clears: "by_waiting", clearsAt: null, hint: "" },
    ]);
    expect((await runner().tick())[0]).toMatchObject({ outcome: "hold", code: "TURNOVER_CAP" });
    now = new Date(now.getTime() + 11 * 60_000);
    expect((await runner().tick())[0]).toMatchObject({ outcome: "leg" });
    // A reason only the owner clears holds until the plan changes.
    const latest = (await intents())[0];
    await t.db
      .updateTable("platform.intents")
      .set({
        status: "failed",
        blockers: JSON.stringify([
          {
            code: "SESSION_EXPIRED",
            message: "m",
            clears: "by_the_owner",
            clearsAt: null,
            hint: "",
          },
        ]),
        updated_at: now,
      })
      .where("intent_id", "=", latest?.intentId ?? "")
      .execute();
    now = new Date(now.getTime() + 60 * 60_000);
    expect((await runner().tick())[0]).toMatchObject({ outcome: "hold", code: "SESSION_EXPIRED" });
    await setPlan({ targetWmonBps: 1_500 });
    expect((await runner().tick())[0]).toMatchObject({ outcome: "leg" });
  });

  it("stores a decision only when it changes, and never calls a model or any network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await saveGoal();
    await setPlan();
    await arm();
    chain.set({ usdc: 80_000_000n, wmon: wmonWorth(20_000_000n) });
    const r = runner();
    await r.tick();
    await r.tick();
    volatility = 250;
    chain.set({ usdc: 90_000_000n, wmon: wmonWorth(10_000_000n) });
    await r.tick();
    await r.tick();
    const rows = (await decisions.recent(CHAIN, 1, 10)).reverse();
    expect(rows.map((x) => [x.code, x.ticks])).toEqual([
      ["IN_BAND", 2],
      ["VOLATILITY_BRAKE", 2],
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
