import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { DEFAULT_GOAL_INPUT, type GoalInput } from "@alpha-agents/domain";
import { type GoalConfig, translateGoal } from "@alpha-agents/policy";
import type { Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GoalStore } from "./goals.ts";

const dbUp = await databaseAvailable();
const CHAIN = 143143;
const ALICE = "0x00000000000000000000000000000000000a11ce" as Hex;
const BOB = "0x0000000000000000000000000000000000000b0b" as Hex;

function config(over: Partial<GoalInput> = {}): GoalConfig {
  const r = translateGoal({ ...structuredClone(DEFAULT_GOAL_INPUT), ...over });
  if (!r.ok) throw new Error("the fixture goal was refused");
  return r.config;
}

describe.skipIf(!dbUp)("goals and agent state (P3-U1, needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let store: GoalStore;

  beforeAll(async () => {
    t = await createTestDatabase("goals");
    store = new GoalStore(t.db);
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.db.deleteFrom("platform.agent_goals").execute();
    await t.db.deleteFrom("platform.agent_state_changes").execute();
    await t.db.deleteFrom("platform.agent_states").execute();
  });

  it("an agent with no goal is UNCONFIGURED at strategy epoch 0", async () => {
    expect(await store.view(CHAIN, 1, 0n)).toEqual({
      goal: null,
      state: "UNCONFIGURED",
      strategyEpoch: 0n,
    });
    expect(await store.strategyEpoch(CHAIN, 1)).toBe(0n);
  });

  it("saving a goal moves the agent to READY, records the change and bumps the epoch", async () => {
    const c = config();
    const saved = await store.save({
      chainId: CHAIN,
      agentId: 1,
      ownerEpoch: 0n,
      savedBy: ALICE,
      config: c,
    });
    expect(saved).toMatchObject({ state: "READY", strategyEpoch: 1n });
    expect(saved.changed).toMatchObject({
      from: "UNCONFIGURED",
      to: "READY",
      reason: "goal_saved",
    });
    expect(saved.goal).toMatchObject({
      strategyEpoch: 1n,
      ownerEpoch: 0n,
      savedBy: "0x00000000000000000000000000000000000A11cE",
      goal: DEFAULT_GOAL_INPUT,
      policyHash: c.policyHash,
      soulBlock: c.soulBlock,
    });
    // The configuration round-trips with its bigints as decimal strings.
    expect(saved.goal?.config.research.dailyBudgetUsdcE6).toBe("1000000");
    expect(saved.goal?.config.template.params.targetWmonBps).toBe(2_000);
    const view = await store.view(CHAIN, 1, 0n);
    expect(view).toMatchObject({ state: "READY", strategyEpoch: 1n });
    expect(view.goal?.goalId).toBe(saved.goal?.goalId);
  });

  it("every save bumps the strategy epoch and keeps the history; the state changes once", async () => {
    for (const preset of ["CONSERVATIVE", "BALANCED", "AGGRESSIVE"] as const)
      await store.save({
        chainId: CHAIN,
        agentId: 2,
        ownerEpoch: 0n,
        savedBy: ALICE,
        config: config({ aggressiveness: preset }),
      });
    expect(await store.strategyEpoch(CHAIN, 2)).toBe(3n);
    const history = await store.history(CHAIN, 2);
    expect(history.map((g) => [g.strategyEpoch, g.goal.aggressiveness])).toEqual([
      [3n, "AGGRESSIVE"],
      [2n, "BALANCED"],
      [1n, "CONSERVATIVE"],
    ]);
    expect((await store.currentGoal(CHAIN, 2))?.goal.aggressiveness).toBe("AGGRESSIVE");
    const changes = await store.stateChanges(CHAIN, 2);
    expect(changes.map((c) => [c.from, c.to, c.strategyEpoch])).toEqual([
      ["UNCONFIGURED", "READY", 1n],
    ]);
    // Other agents are untouched.
    expect(await store.strategyEpoch(CHAIN, 1)).toBe(0n);
  });

  it("a goal binds only the owner who saved it; a new owner sees UNCONFIGURED until they save", async () => {
    await store.save({
      chainId: CHAIN,
      agentId: 3,
      ownerEpoch: 4n,
      savedBy: ALICE,
      config: config(),
    });
    expect(await store.view(CHAIN, 3, 5n)).toEqual({
      goal: null,
      state: "UNCONFIGURED",
      strategyEpoch: 1n,
    });
    const saved = await store.save({
      chainId: CHAIN,
      agentId: 3,
      ownerEpoch: 5n,
      savedBy: BOB,
      config: config({ aggressiveness: "AGGRESSIVE" }),
    });
    expect(saved).toMatchObject({ state: "READY", strategyEpoch: 2n });
    expect(saved.changed).toMatchObject({ from: "UNCONFIGURED", to: "READY", strategyEpoch: 2n });
    expect((await store.view(CHAIN, 3, 5n)).goal?.savedBy).toBe(
      "0x0000000000000000000000000000000000000B0b",
    );
  });

  it("concurrent saves never share an epoch", async () => {
    await Promise.all(
      Array.from({ length: 6 }, () =>
        store.save({
          chainId: CHAIN,
          agentId: 4,
          ownerEpoch: 0n,
          savedBy: ALICE,
          config: config(),
        }),
      ),
    );
    const epochs = (await store.history(CHAIN, 4)).map((g) => g.strategyEpoch);
    expect(epochs).toEqual([6n, 5n, 4n, 3n, 2n, 1n]);
    const current = await t.db
      .selectFrom("platform.agent_goals")
      .select("goal_id")
      .where("agent_id", "=", 4)
      .where("current", "=", true)
      .execute();
    expect(current).toHaveLength(1);
  });

  it("refuses a state the model does not know", async () => {
    await expect(
      t.db
        .insertInto("platform.agent_states")
        .values({ chain_id: CHAIN, agent_id: 9, state: "ARMED" as never })
        .execute(),
    ).rejects.toThrow(/check/);
  });

  it("reads a goal saved before F-U7 as Conservative with its settings carried over, and migration 0023 reshapes the row (D-345)", async () => {
    const legacy = {
      template: "rebalance_bands@1",
      riskPreset: "GROWTH",
      allowedAssets: { wmon: true },
      stricterLimits: {
        maxTradeBps: 500,
        maxWmonShareBps: 2_500,
        minUsdcShareBps: null,
        maxSlippageBps: null,
        maxTradesPer24h: 6,
      },
      reasoningModel: "DEEP",
      research: { intensity: "STANDARD", dailyBudgetUsdcE6: "2500000" },
      creditReserveUsdcE6: "2000000",
      planChanges: "APPLY_AND_TELL",
    };
    await t.db
      .insertInto("platform.agent_states")
      .values({ chain_id: CHAIN, agent_id: 9, state: "READY", strategy_epoch: "3" })
      .execute();
    await t.db
      .insertInto("platform.agent_goals")
      .values({
        goal_id: "goal-legacy",
        chain_id: CHAIN,
        agent_id: 9,
        strategy_epoch: "3",
        owner_epoch: "0",
        saved_by: ALICE.toLowerCase(),
        goal: JSON.stringify(legacy),
        config: JSON.stringify({ template: { id: "rebalance_bands@1" } }),
        policy_hash: `0x${"00".repeat(32)}`,
        soul_block: "old",
        current: true,
      })
      .execute();
    const expected = {
      aggressiveness: "CONSERVATIVE",
      modelTier: "HIGH",
      screenedOptIn: false,
      excludedTokens: [],
      stricterLimits: {
        maxTradeBps: 500,
        maxPositionBps: 2_500,
        minUsdcShareBps: null,
        maxSlippageBps: null,
        maxTradesPer24h: 6,
      },
      research: { intensity: "STANDARD", dailyBudgetUsdcE6: "2500000" },
      creditReserveUsdcE6: "2000000",
      planChanges: "APPLY_AND_TELL",
    };
    // Read before the migration: the store carries the goal over and translates it afresh.
    const before = await store.currentGoal(CHAIN, 9);
    expect(before?.goal).toEqual(expected);
    expect(before?.config.aggressiveness).toBe("CONSERVATIVE");
    expect(before?.config.model).toEqual({ choice: "HIGH", alias: "research-high" });
    expect(before?.config.ownerLimits.maxPositionBps).toBe(2_500);
    expect(before?.soulBlock).toContain("- Aggressiveness: Conservative");
    expect(before?.strategyEpoch).toBe(3n);
    // The migration reshapes the stored row the same way and leaves the epoch alone.
    const { up } = await import("../../db/src/migrations/0023_goal_v2.ts");
    await up(t.db as never);
    const row = await t.db
      .selectFrom("platform.agent_goals")
      .select(["goal", "strategy_epoch"])
      .where("goal_id", "=", "goal-legacy")
      .executeTakeFirstOrThrow();
    expect(row.goal).toEqual(expected);
    expect(String(row.strategy_epoch)).toBe("3");
    const after = await store.currentGoal(CHAIN, 9);
    expect(after?.goal).toEqual(expected);
    expect(after?.policyHash).toBe(before?.policyHash);
  });
});
