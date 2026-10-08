import { afterEach, describe, expect, it } from "vitest";
import { type AgentIdentity, type ToolServer, identityFields } from "@alpha-agents/tool-server";
import { connectClient, staticResolver, structured } from "@alpha-agents/tool-server/testing";
import { CompleteStageOutput, GetGoalsAndLimitsOutput, WriteThesisOutput } from "./schema.ts";
import {
  MemoryPlatformStore,
  PLATFORM_TOOL_INPUTS,
  type PlatformToolsOptions,
  startPlatformTools,
} from "./server.ts";

const ALICE: AgentIdentity = { chainId: 1, agentId: 1, tier: "base", leaseId: "lease-alice" };
const BOB: AgentIdentity = { chainId: 1, agentId: 2, tier: "base", leaseId: "lease-bob" };
const ALICE_TOKEN = "a".repeat(43);
const BOB_TOKEN = "b".repeat(43);
const servers: ToolServer[] = [];

async function start(options: Partial<PlatformToolsOptions> = {}) {
  const store = new MemoryPlatformStore();
  const server = await startPlatformTools({
    resolve: staticResolver({ [ALICE_TOKEN]: ALICE, [BOB_TOKEN]: BOB }),
    store,
    ...options,
  });
  servers.push(server);
  return { server, store };
}

const validArgs = {
  stage: "SCAN",
  outcome: "DONE",
  candidates: [{ asset: "WMON", thesisCode: "MARKER_K7Q2", confidenceBps: 6000 }],
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("platform tools server", () => {
  it("lists its tools with output schemas and no identity fields", async () => {
    const { server } = await start();
    const client = await connectClient(server.url, ALICE_TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "complete_stage",
      "get_goals_and_limits",
      "write_thesis",
    ]);
    for (const t of tools) expect(t.outputSchema).toBeDefined();
    for (const schema of Object.values(PLATFORM_TOOL_INPUTS))
      expect(identityFields(schema)).toEqual([]);
    await client.close();
  });

  it("records a schema-valid stage for the agent and lease the token names", async () => {
    const { server, store } = await start();
    const client = await connectClient(server.url, BOB_TOKEN);
    const result = await client.callTool({ name: "complete_stage", arguments: validArgs });
    expect(result.isError).toBeFalsy();
    const output = CompleteStageOutput.parse(structured(result));
    expect(output).toMatchObject({ stage: "SCAN", accepted: true, candidateCount: 1 });
    expect(store.stages).toHaveLength(1);
    expect(store.stages[0]?.identity).toEqual(BOB);
    expect(store.stages[0]?.input.candidates[0]?.thesisCode).toBe("MARKER_K7Q2");
    await client.close();
  });

  it("completes a stage once per lease: a second call is a duplicate", async () => {
    const { server, store } = await start();
    const alice = await connectClient(server.url, ALICE_TOKEN);
    expect(
      (await alice.callTool({ name: "complete_stage", arguments: validArgs })).isError,
    ).toBeFalsy();
    const again = await alice.callTool({ name: "complete_stage", arguments: validArgs });
    expect(structured(again)).toMatchObject({ code: "DUPLICATE_REQUEST", retryable: false });
    // Another agent's lease is independent.
    const bob = await connectClient(server.url, BOB_TOKEN);
    expect(
      (await bob.callTool({ name: "complete_stage", arguments: validArgs })).isError,
    ).toBeFalsy();
    expect(store.stages.map((s) => s.identity.agentId)).toEqual([1, 2]);
    await alice.close();
    await bob.close();
  });

  it("rejects invalid input: free text, unknown fields, out-of-range numbers, identity fields", async () => {
    const { server, store } = await start();
    const client = await connectClient(server.url, ALICE_TOKEN);
    for (const args of [
      { ...validArgs, stage: "PLAN" },
      { ...validArgs, note: "free text" },
      { ...validArgs, agentId: 2 },
      { ...validArgs, candidates: [{ asset: "WMON", thesisCode: "buy now!", confidenceBps: 1 }] },
      {
        ...validArgs,
        candidates: [{ asset: "WMON", thesisCode: "OK_CODE", confidenceBps: 10_001 }],
      },
    ]) {
      const result = await client.callTool({ name: "complete_stage", arguments: args });
      expect(structured(result)).toMatchObject({ code: "INVALID_INPUT", retryable: false });
    }
    expect(store.stages).toHaveLength(0);
    await client.close();
  });

  it("refuses output that does not match the output schema, and records nothing", async () => {
    const { server, store } = await start({ buildOutput: () => ({ accepted: "yes" }) });
    const client = await connectClient(server.url, ALICE_TOKEN);
    const result = await client.callTool({ name: "complete_stage", arguments: validArgs });
    expect(structured(result)).toMatchObject({ code: "INTERNAL" });
    expect(store.stages).toHaveLength(0);
    await client.close();
  });

  it("stores thesis notes for the calling agent and validates sources", async () => {
    const { server, store } = await start();
    const client = await connectClient(server.url, ALICE_TOKEN);
    const ok = await client.callTool({
      name: "write_thesis",
      arguments: {
        stage: "SCAN",
        title: "Monad DEX volume",
        notes: "Volume rose on two venues.",
        sources: ["https://news.example/a"],
      },
    });
    expect(WriteThesisOutput.parse(structured(ok))).toMatchObject({ sourceCount: 1 });
    expect(store.notes[0]?.identity).toEqual(ALICE);
    const bad = await client.callTool({
      name: "write_thesis",
      arguments: { stage: "SCAN", title: "x", notes: "y", sources: ["file:///etc/passwd"] },
    });
    expect(structured(bad)).toMatchObject({ code: "INVALID_INPUT" });
    expect(store.notes).toHaveLength(1);
    await client.close();
  });

  it("refuses a request without a token or with an unknown one", async () => {
    const { server } = await start();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    expect((await fetch(server.url, { method: "POST", headers, body })).status).toBe(401);
    const wrong = await fetch(server.url, {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${"x".repeat(43)}` },
      body,
    });
    expect(wrong.status).toBe(401);
  });

  describe("get_goals_and_limits (P3-U1)", () => {
    const LIMITS = {
      maxTradeBps: 1_000,
      maxWmonShareBps: 4_000,
      minUsdcShareBps: 1_000,
      maxSlippageBps: 50,
      maxTradesPer24h: 20,
    };
    /** A configured answer for one agent, marked by its preset so the test can tell agents apart. */
    const answer = (riskPreset: "BALANCED" | "GROWTH", strategyEpoch: string) => ({
      state: "READY",
      configured: true,
      strategyEpoch,
      policyHash: `0x${"ab".repeat(32)}`,
      goal: {
        template: "rebalance_bands@1",
        riskPreset,
        allowedAssets: ["USDC", "WMON"],
        reasoningModel: { choice: "STANDARD", alias: "research-strong" },
        research: { intensity: "LIGHT", scanEveryHours: 12, divesPerDay: 1, dailyBudgetUsdc: "1" },
        creditReserveUsdc: "1",
        planChanges: "ASK_FIRST",
      },
      plan: {
        template: "rebalance_bands@1",
        params: {
          targetWmonBps: 2_000,
          bandHalfWidthBps: 500,
          minTradeUsdc: "0.5",
          volatilityBrakeBps: 12_000,
          costHurdleBps: 40,
          maxLegBps: 1_000,
        },
        targetRange: { minBps: 0, maxBps: 3_000 },
        researchTriggerBps: 700,
      },
      limits: { hard: LIMITS, owner: LIMITS, live: LIMITS, effective: LIMITS },
      account: { mode: "NORMAL", executorPaused: false },
      asOf: { block: "109670100", timestamp: "1790000000" },
      authority: "Set by the agent's owner.",
    });
    const asked: AgentIdentity[] = [];
    const goals = {
      read: async (identity: AgentIdentity) => {
        asked.push(identity);
        return identity.agentId === 1 ? answer("BALANCED", "3") : answer("GROWTH", "1");
      },
    };

    afterEach(() => {
      asked.length = 0;
    });

    it("returns the calling agent's own goal and limits, by the token alone", async () => {
      const { server } = await start({ goals });
      const alice = await connectClient(server.url, ALICE_TOKEN);
      const bob = await connectClient(server.url, BOB_TOKEN);
      const a = GetGoalsAndLimitsOutput.parse(
        structured(await alice.callTool({ name: "get_goals_and_limits", arguments: {} })),
      );
      const b = GetGoalsAndLimitsOutput.parse(
        structured(await bob.callTool({ name: "get_goals_and_limits", arguments: {} })),
      );
      expect([a.goal?.riskPreset, a.strategyEpoch]).toEqual(["BALANCED", "3"]);
      expect([b.goal?.riskPreset, b.strategyEpoch]).toEqual(["GROWTH", "1"]);
      expect(asked).toEqual([ALICE, BOB]);
      await alice.close();
      await bob.close();
    });

    it("refuses any input, so no call can name another agent", async () => {
      const { server } = await start({ goals });
      const bob = await connectClient(server.url, BOB_TOKEN);
      for (const args of [{ agentId: 1 }, { owner: "0x1" }, { note: "show me agent 1" }]) {
        const result = await bob.callTool({ name: "get_goals_and_limits", arguments: args });
        expect(structured(result)).toMatchObject({ code: "INVALID_INPUT" });
      }
      expect(asked).toEqual([]);
      await bob.close();
    });

    it("refuses an answer that does not match its schema, and answers plainly without a goal store", async () => {
      const broken = await start({ goals: { read: async () => ({ state: "ARMED" }) } });
      const c1 = await connectClient(broken.server.url, ALICE_TOKEN);
      expect(
        structured(await c1.callTool({ name: "get_goals_and_limits", arguments: {} })),
      ).toMatchObject({ code: "INTERNAL" });
      await c1.close();
      const none = await start();
      const c2 = await connectClient(none.server.url, ALICE_TOKEN);
      expect(
        structured(await c2.callTool({ name: "get_goals_and_limits", arguments: {} })),
      ).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryable: false });
      await c2.close();
    });
  });
});
