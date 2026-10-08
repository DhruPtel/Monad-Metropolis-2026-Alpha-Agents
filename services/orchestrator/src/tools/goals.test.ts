import type { AgentState, ChainReader, MarketState } from "@alpha-agents/chain-tools";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { DEFAULT_GOAL_INPUT } from "@alpha-agents/domain";
import { LAUNCH_EXECUTOR_POLICY, translateGoal } from "@alpha-agents/policy";
import { GoalStore } from "@alpha-agents/trading";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CHAIN } from "../testing.ts";
import { goalsReader } from "./goals.ts";

const dbUp = await databaseAvailable();
const IDENTITY = { chainId: CHAIN, agentId: 7, tier: "base", leaseId: "lease-7" };

/** A chain where agent 7 is at ownership epoch 5 and the Executor's policy is tighter on slippage. */
function chain(over: { mode?: AgentState["mode"]; account?: boolean } = {}): ChainReader {
  return {
    chainId: CHAIN,
    market: async () =>
      ({
        policy: { ...LAUNCH_EXECUTOR_POLICY, maxSlippageBps: 40 },
        paused: false,
      }) as unknown as MarketState,
    agent: async (agentId: number) =>
      agentId === 7
        ? ({
            block: 109_670_100n,
            timestamp: 1_790_000_000n,
            ownerEpoch: 5n,
            account: over.account === false ? null : "0x00000000000000000000000000000000000ac007",
            mode: over.mode ?? "NORMAL",
          } as unknown as AgentState)
        : null,
    quote: async () => {
      throw new Error("not used");
    },
    tokenOf: () => "0x0000000000000000000000000000000000000001",
  };
}

describe.skipIf(!dbUp)("get_goals_and_limits' reader (P3-U1, needs Postgres)", () => {
  let t: TestDatabase;
  let goals: GoalStore;
  const save = (ownerEpoch: bigint, maxTradeBps: number | null) => {
    const r = translateGoal({
      ...structuredClone(DEFAULT_GOAL_INPUT),
      stricterLimits: { ...DEFAULT_GOAL_INPUT.stricterLimits, maxTradeBps },
    });
    if (!r.ok) throw new Error("fixture goal refused");
    return goals.save({
      chainId: CHAIN,
      agentId: 7,
      ownerEpoch,
      savedBy: "0x00000000000000000000000000000000000a11ce",
      config: r.config,
    });
  };

  beforeAll(async () => {
    t = await createTestDatabase("orch_goals");
    goals = new GoalStore(t.db);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    await t.db.deleteFrom("platform.agent_goals").execute();
    await t.db.deleteFrom("platform.agent_state_changes").execute();
    await t.db.deleteFrom("platform.agent_states").execute();
  });

  it("gives the tightest of the hard, owner and live limits, with the mode, as of the read", async () => {
    await save(5n, 500);
    const out = await goalsReader(t.db, chain({ mode: "REDUCE_ONLY" })).read(IDENTITY);
    expect(out).toMatchObject({
      state: "READY",
      configured: true,
      limits: {
        hard: { maxTradeBps: 1_000, maxSlippageBps: 50 },
        owner: { maxTradeBps: 500, maxSlippageBps: 50 },
        live: { maxTradeBps: 1_000, maxSlippageBps: 40 },
        effective: { maxTradeBps: 500, maxSlippageBps: 40, minUsdcShareBps: 1_000 },
      },
      account: { mode: "REDUCE_ONLY", executorPaused: false },
      asOf: { block: "109670100", timestamp: "1790000000" },
    });
  });

  it("does not apply a goal another owner saved: the agent reads UNCONFIGURED", async () => {
    await save(4n, 500);
    const out = await goalsReader(t.db, chain()).read(IDENTITY);
    expect(out).toMatchObject({
      state: "UNCONFIGURED",
      configured: false,
      goal: null,
      plan: null,
      limits: { owner: null, effective: { maxTradeBps: 1_000, maxSlippageBps: 40 } },
    });
  });

  it("reports no mode before the agent has an account", async () => {
    const out = await goalsReader(t.db, chain({ account: false })).read(IDENTITY);
    expect(out).toMatchObject({ state: "UNCONFIGURED", account: { mode: null } });
  });
});
