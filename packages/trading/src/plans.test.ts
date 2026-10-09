import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { DEFAULT_GOAL_INPUT } from "@alpha-agents/domain";
import { checkPlan, paramsHash, translateGoal } from "@alpha-agents/policy";
import type { Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DecisionStore } from "./decisions.ts";
import { GoalStore } from "./goals.ts";
import { PLAN_SET_REASON, PlanStore } from "./plans.ts";

const dbUp = await databaseAvailable();
const CHAIN = 143143;
const ALICE = "0x00000000000000000000000000000000000a11ce" as Hex;

const config = () => {
  const r = translateGoal(structuredClone(DEFAULT_GOAL_INPUT));
  if (!r.ok) throw new Error("goal");
  return r.config;
};

describe.skipIf(!dbUp)(
  "plans and runner decisions (P3-U3, needs Postgres)",
  { timeout: 60_000 },
  () => {
    let t: TestDatabase;
    let plans: PlanStore;
    let goals: GoalStore;
    let decisions: DecisionStore;

    beforeAll(async () => {
      t = await createTestDatabase("plans");
      plans = new PlanStore(t.db);
      goals = new GoalStore(t.db);
      decisions = new DecisionStore(t.db);
    });
    afterAll(async () => {
      await t?.drop();
    });
    beforeEach(async () => {
      for (const table of [
        "platform.runner_decisions",
        "platform.strategy_params",
        "platform.agent_goals",
        "platform.agent_state_changes",
        "platform.agent_states",
      ] as const)
        await t.db.deleteFrom(table).execute();
    });

    it("refuses a plan before the agent has a goal", async () => {
      await expect(
        plans.set({
          chainId: CHAIN,
          agentId: 1,
          params: config().template.params,
          setBy: "console",
        }),
      ).rejects.toThrow(/no goal/);
    });

    it("records the plan by hash at a new strategy epoch, keeps one active, and moves READY to RUNNING", async () => {
      await goals.save({
        chainId: CHAIN,
        agentId: 1,
        ownerEpoch: 1n,
        savedBy: ALICE,
        config: config(),
      });
      const params = config().template.params;
      const first = await plans.set({ chainId: CHAIN, agentId: 1, params, setBy: "console" });
      expect(first).toMatchObject({
        strategyEpoch: 2n,
        paramsHash: paramsHash("rebalance_bands@1", params),
        setBy: "console",
        params,
      });
      const view = await goals.view(CHAIN, 1, 1n);
      expect(view).toMatchObject({ state: "RUNNING", strategyEpoch: 2n });
      expect((await goals.stateChanges(CHAIN, 1)).at(-1)).toMatchObject({
        from: "READY",
        to: "RUNNING",
        reason: PLAN_SET_REASON,
      });
      const second = await plans.set({
        chainId: CHAIN,
        agentId: 1,
        params: { ...params, targetWmonBps: 1_500 },
        setBy: "owner",
        setByAddress: ALICE,
      });
      expect(second.strategyEpoch).toBe(3n);
      expect((await plans.active(CHAIN, 1))?.paramId).toBe(second.paramId);
      expect(await plans.activePlans(CHAIN)).toHaveLength(1);
      expect((await plans.history(CHAIN, 1)).map((p) => p.params.targetWmonBps)).toEqual([
        1_500, 2_000,
      ]);
    });

    it("checks a plan against the goal: target inside the range, leg and cost no looser than the owner's", () => {
      const c = config();
      expect(checkPlan(c.template.params, c)).toEqual([]);
      const fields = (over: Partial<typeof c.template.params>) =>
        checkPlan({ ...c.template.params, ...over }, c).map((e) => e.field);
      expect(fields({ targetWmonBps: c.targetRange.maxBps + 100 })).toEqual([
        "template.params.targetWmonBps",
      ]);
      expect(
        checkPlan(c.template.params, {
          ...c,
          ownerLimits: { ...c.ownerLimits, maxTradeBps: 500 },
        }).map((e) => e.field),
      ).toEqual(["template.params.maxLegBps"]);
      expect(
        checkPlan(c.template.params, {
          ...c,
          ownerLimits: { ...c.ownerLimits, maxSlippageBps: 20 },
        }).map((e) => e.field),
      ).toEqual(["template.params.costHurdleBps"]);
    });

    it("a decision is a new row only when it changes", async () => {
      const at = (m: number) => new Date(Date.UTC(2026, 9, 9, 0, m));
      const hold = (code: string, codes = [code]) => ({
        chainId: CHAIN,
        agentId: 1,
        paramId: "plan-1",
        strategyEpoch: 2n,
        outcome: "hold" as const,
        code,
        codes,
        leg: null,
        intentId: null,
        facts: {},
        block: 1n,
      });
      expect((await decisions.record(hold("IN_BAND"), at(0))).changed).toBe(true);
      expect((await decisions.record(hold("IN_BAND"), at(1))).changed).toBe(false);
      expect((await decisions.record(hold("TURNOVER_CAP"), at(2))).changed).toBe(true);
      expect(
        (await decisions.record(hold("TURNOVER_CAP", ["TURNOVER_CAP", "PAUSED"]), at(3))).changed,
      ).toBe(true);
      expect(
        (await decisions.record({ ...hold("IN_BAND"), paramId: "plan-2" }, at(4))).changed,
      ).toBe(true);
      const rows = await decisions.recent(CHAIN, 1);
      expect(rows.map((r) => [r.code, r.ticks])).toEqual([
        ["IN_BAND", 1],
        ["TURNOVER_CAP", 1],
        ["TURNOVER_CAP", 1],
        ["IN_BAND", 2],
      ]);
    });
  },
);
