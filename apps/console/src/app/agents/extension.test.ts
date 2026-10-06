import { describe, expect, it } from "vitest";
import { noopFields } from "./task-fields";
import { apiAgentsSource, orchestratorSource } from "./extension";

const reply = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const AGENTS = {
  watermark: { block: 109670005, hash: "0xabc", updatedAt: "2026-10-05T00:00:00.000Z" },
  agents: [
    { agentId: "1", owner: "0x683eE842A16f85e69883F433745263BFe8D55f76", species: 14 },
    { agentId: "2", owner: "0x00000000000000000000000000000000000E2e01", species: 0 },
  ],
};

/** Answers by URL: the control API's agents and the orchestrator's runtimes. */
const routes = (table: Record<string, [number, unknown]>, calls: string[] = []) =>
  (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const hit = Object.entries(table).find(([k]) => url.endsWith(k));
    if (!hit) throw new Error("connection refused");
    return new Response(JSON.stringify(hit[1][1]), { status: hit[1][0] });
  }) as unknown as typeof fetch;

describe("the agents panel's source (P1-U4)", () => {
  it("lists agents from the control API with tier, species, owner and the watermark", async () => {
    const source = apiAgentsSource("http://127.0.0.1:4100", reply(200, AGENTS));
    const list = await source.listAgents();
    expect(list.watermark).toEqual({ block: 109670005, updatedAt: "2026-10-05T00:00:00.000Z" });
    expect(list.agents.map((a) => [a.agentId, a.name, a.tier, a.speciesName, a.state])).toEqual([
      [1n, "Alpha Agent #1", "pro", "Bee", "UNCONFIGURED"],
      [2n, "Alpha Agent #2", null, null, "UNCONFIGURED"],
    ]);
    expect(list.agents[0]?.spendUsdcE6).toBe(0n);
    expect(list.orchestrator).toBe(false);
  });

  it("fails when the API does", async () => {
    await expect(apiAgentsSource("http://x", reply(500, {})).listAgents()).rejects.toThrow(/500/);
  });
});

describe("runtimes and tasks from the orchestrator (P1-U5)", () => {
  it("adds each agent's runtime and latest task, and whether actions are offered", async () => {
    const task = { taskId: "t1", agentId: "1", status: "succeeded", result: null, error: null };
    const fetchFn = routes({
      "/v1/agents": [200, AGENTS],
      "/v1/credits": [200, { enabled: true, agents: [] }],
      "/v1/runtimes": [
        200,
        { devActions: true, runtimes: [{ agentId: "1", status: "ready", latestTask: task }] },
      ],
    });
    const list = await apiAgentsSource("http://api", fetchFn, "http://orch").listAgents();
    expect(list).toMatchObject({ orchestrator: true, devActions: true });
    expect(list.agents.map((a) => a.runtime)).toEqual(["ready", "not_provisioned"]);
    expect(list.agents[0]?.latestTask).toEqual(task);
  });

  it("adds credits, 24-hour spend and RESTRICTED for a provisioned agent with none (P1-U6)", async () => {
    const credit = (agentId: string, spendable: string, held = "0") => ({
      agentId,
      fundingAddress: `0x${agentId.padStart(40, "f")}`,
      creditsUsdcE6: spendable,
      spendableUsdcE6: spendable,
      heldUsdcE6: held,
      restricted: spendable === "0",
      spent24hUsdcE6: "5600",
    });
    const fetchFn = routes({
      "/v1/agents": [200, AGENTS],
      "/v1/runtimes": [
        200,
        {
          devActions: true,
          runtimes: [
            { agentId: "1", status: "ready", latestTask: null },
            { agentId: "2", status: "ready", latestTask: null },
          ],
        },
      ],
      "/v1/credits": [
        200,
        { enabled: true, agents: [credit("1", "4994400", "2000000"), credit("2", "0")] },
      ],
    });
    const list = await apiAgentsSource("http://api", fetchFn, "http://orch").listAgents();
    expect(
      list.agents.map((a) => [a.state, a.spendUsdcE6, a.credits?.spendable, a.credits?.held]),
    ).toEqual([
      ["UNCONFIGURED", 5600n, 4994400n, 2000000n],
      ["RESTRICTED", 5600n, 0n, 0n],
    ]);
    expect(list.agents[0]?.credits?.fundingAddress).toBe(`0x${"1".padStart(40, "f")}`);
  });

  it("asks the orchestrator for a refund and reads its status", async () => {
    const calls: string[] = [];
    const orch = orchestratorSource(
      "http://orch",
      routes(
        {
          "/v1/agents/1/refund": [202, { refundId: "r1" }],
          "/v1/agents/2/refund": [
            409,
            { error: "refund_open", message: "agent 2 already has a refund in progress" },
          ],
          "/v1/refunds/r1": [
            200,
            { refundId: "r1", status: "sent", creditsUsdcE6: "4994400", heldUsdcE6: "0" },
          ],
        },
        calls,
      ),
    );
    expect(await orch.refund(1n as never)).toBe("r1");
    await expect(orch.refund(2n as never)).rejects.toThrow(
      "agent 2 already has a refund in progress",
    );
    expect((await orch.refundStatus("r1")).status).toBe("sent");
    expect(calls[0]).toBe("POST http://orch/v1/agents/1/refund");
  });

  it("still lists agents when the orchestrator is down, with actions off", async () => {
    const fetchFn = routes({ "/v1/agents": [200, AGENTS] });
    const list = await apiAgentsSource("http://api", fetchFn, "http://orch").listAgents();
    expect(list).toMatchObject({ orchestrator: false, devActions: false });
    expect(list.agents.map((a) => a.runtime)).toEqual(["not_provisioned", "not_provisioned"]);
    expect(list.agents.map((a) => a.credits)).toEqual([null, null]);
  });

  it("queues the no-op task and a reset, reads a task, and passes the orchestrator's words on", async () => {
    const calls: string[] = [];
    const orch = orchestratorSource(
      "http://orch",
      routes(
        {
          "/v1/agents/1/tasks/noop": [202, { taskId: "t9" }],
          "/v1/agents/2/tasks/noop": [
            409,
            { error: "lease_held", message: "Agent 2 already has a sandbox running." },
          ],
          "/v1/agents/1/reset": [202, { queued: true }],
          "/v1/tasks/t9": [200, { taskId: "t9", status: "running" }],
        },
        calls,
      ),
    );
    expect(await orch.triggerTask(1n as never, "noop")).toBe("t9");
    await expect(orch.triggerTask(2n as never, "noop")).rejects.toThrow(
      "Agent 2 already has a sandbox running.",
    );
    await orch.resetAgent(1n as never);
    expect((await orch.task("t9")).status).toBe("running");
    expect(calls).toEqual([
      "POST http://orch/v1/agents/1/tasks/noop",
      "POST http://orch/v1/agents/2/tasks/noop",
      "POST http://orch/v1/agents/1/reset",
      "GET http://orch/v1/tasks/t9",
    ]);
  });

  it("puts a no-op result into plain rows", () => {
    expect(
      noopFields({
        replied: "NOOP_OK",
        tier: "medium",
        slots: 5,
        playbook: "tier-medium@0",
        modelCalls: 2,
        modelCallsOk: 2,
        sandboxStopped: true,
        timingsMs: { sandbox: 824, hermesBoot: 13667, run: 10159 },
        configHash: "92f01aabdc6097af43a687eb",
      }).map((f) => [f.label, f.value]),
    ).toEqual([
      ["Reply", "NOOP_OK"],
      ["Tier", "Medium, 5 slots, tier-medium@0"],
      ["Model calls", "2 of 2 succeeded"],
      ["Sandbox", "Stopped"],
      ["Time", "Sandbox 0.8 s, Hermes 13.7 s, run 10.2 s"],
      ["Config", "92f01aabdc60"],
    ]);
    expect(noopFields(null)).toEqual([]);
  });
});
