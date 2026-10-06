import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "./api.ts";
import { MemoryGateway } from "./gateway-admin.ts";
import { LeaseManager } from "./leases.ts";
import { CreditsExhaustedError, type Orchestrator, ScanOpenError } from "./orchestrator.ts";
import { Provisioner } from "./provisioner.ts";
import { RevealSteering } from "./reveal-steer.ts";
import { MemoryProvider } from "./sandbox.ts";
import { Redactor } from "./secrets.ts";
import { Store } from "./store.ts";
import { CHAIN, indexAgent } from "./testing.ts";

const dbUp = await databaseAvailable();

describe.skipIf(!dbUp)("the orchestrator's internal API (D-205)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let store: Store;
  let leases: LeaseManager;
  const queued: string[] = [];
  let scanRefusal: Error | null = null;
  const orchestrator = {
    runTag: "run-test",
    keeper: null,
    enqueueNoop: async (ref: { agentId: number }) => {
      queued.push(`noop ${ref.agentId}`);
      return "task-1";
    },
    enqueueReset: async (ref: { agentId: number }) => {
      queued.push(`reset ${ref.agentId}`);
    },
    enqueueScan: async (ref: { agentId: number }) => {
      if (scanRefusal) throw scanRefusal;
      queued.push(`scan ${ref.agentId}`);
      return "scan-1";
    },
  } as unknown as Orchestrator;

  beforeAll(async () => {
    t = await createTestDatabase("orch_api");
    store = new Store(t.db);
    const redactor = new Redactor();
    leases = new LeaseManager({
      store,
      provider: new MemoryProvider(),
      namespace: "unit",
      runTag: "r",
      redactor,
      log: () => undefined,
    });
    await indexAgent(t.db, 1, "pro");
    await indexAgent(t.db, 2, null);
    await new Provisioner({
      store,
      gateway: new MemoryGateway(),
      leases,
      namespace: "unit",
      secret: "test-orchestrator-secret-0123456789abcdef",
      redactor,
      log: () => undefined,
      startingBudgetUsd: 0.5,
    }).provision({ chainId: CHAIN, agentId: 1 });
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  const api = (devActions: boolean) =>
    createApi({ orchestrator, store, chainId: CHAIN, devActions });

  it("lists runtimes with tier, slots and playbook, and no key material", async () => {
    const res = await api(true).request("/v1/runtimes");
    const body = (await res.json()) as { devActions: boolean; runtimes: Record<string, unknown>[] };
    expect(body.devActions).toBe(true);
    expect(body.runtimes).toHaveLength(1);
    expect(body.runtimes[0]).toMatchObject({
      agentId: "1",
      status: "ready",
      tier: "pro",
      slots: 8,
      playbook: "tier-pro@0",
      keyAlias: "aa-unit-143143-1-g1",
      lease: null,
      latestTask: null,
    });
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/ciphertext|sk-aa-|v1\.[A-Za-z0-9_-]{8,}\./);
  });

  it("queues the no-op task for a provisioned agent only, and not while it holds a lease", async () => {
    const post = (id: string) =>
      api(true).request(`/v1/agents/${id}/tasks/noop`, { method: "POST" });
    expect((await post("2")).status).toBe(409);
    expect((await post("abc")).status).toBe(400);
    const ok = await post("1");
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ taskId: "task-1" });
    const held = await leases.acquire({ chainId: CHAIN, agentId: 1 }, "noop", 60_000);
    const refused = await post("1");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "lease_held" });
    await leases.release(held.lease.leaseId, "test");
    expect(queued).toEqual(["noop 1"]);
  });

  it("queues a reset", async () => {
    const res = await api(true).request("/v1/agents/1/reset", { method: "POST" });
    expect(res.status).toBe(202);
    expect(queued.at(-1)).toBe("reset 1");
  });

  it("queues a Scan, and names why one is refused", async () => {
    const post = () => api(true).request("/v1/agents/1/tasks/scan", { method: "POST" });
    const ok = await post();
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ taskId: "scan-1" });
    scanRefusal = new CreditsExhaustedError(1);
    const broke = await post();
    expect(broke.status).toBe(409);
    expect(await broke.json()).toMatchObject({ error: "credits_exhausted" });
    scanRefusal = new ScanOpenError(1);
    expect(await (await post()).json()).toMatchObject({ error: "scan_open" });
    scanRefusal = null;
    expect((await api(true).request("/v1/agents/2/tasks/scan", { method: "POST" })).status).toBe(
      409,
    );
    expect((await api(false).request("/v1/agents/1/tasks/scan", { method: "POST" })).status).toBe(
      404,
    );
  });

  it("lists tool calls with the query or host only, and activity entries", async () => {
    const call = (id: string, tool: string, input: unknown) =>
      t.db
        .insertInto("platform.tool_calls")
        .values({
          call_id: id,
          chain_id: CHAIN,
          agent_id: 1,
          lease_id: "L",
          server: "data",
          tool,
          input: JSON.stringify(input),
          status: "succeeded",
          charge_usdc_e6: "10000",
          summary: JSON.stringify({ results: 3 }),
        })
        .execute();
    await call("c1", "web_search", { query: "monad news" });
    await call("c2", "read_url", { url: "https://news.example/path?secret=1" });
    await t.db
      .insertInto("platform.activity_entries")
      .values({
        entry_id: "a1",
        chain_id: CHAIN,
        agent_id: 1,
        task_id: "scan-1",
        kind: "scan",
        text: "Agent #1 ran 1 web search.",
        rendered_by: "narrator",
        facts: "{}",
        rejections: "[]",
      })
      .execute();
    const calls = (await (await api(false).request("/v1/agents/1/tool-calls")).json()) as {
      calls: { tool: string; target: string; chargeUsdcE6: string; results: number }[];
    };
    expect(calls.calls.map((c) => [c.tool, c.target])).toEqual(
      expect.arrayContaining([
        ["web_search", "monad news"],
        ["read_url", "news.example"],
      ]),
    );
    expect(JSON.stringify(calls)).not.toContain("secret=1");
    const activity = (await (await api(false).request("/v1/agents/1/activity")).json()) as {
      entries: { text: string; renderedBy: string }[];
    };
    expect(activity.entries).toEqual([
      expect.objectContaining({ text: "Agent #1 ran 1 web search.", renderedBy: "narrator" }),
    ]);
    expect((await api(false).request("/v1/agents/x/activity")).status).toBe(400);
  });

  it("chooses the next local reveal only with steering and dev actions (D-221)", async () => {
    const post = (devActions: boolean, orch: Orchestrator, species: unknown) =>
      createApi({ orchestrator: orch, store, chainId: CHAIN, devActions }).request(
        "/v1/keeper/next-reveal",
        { method: "POST", body: JSON.stringify({ species }) },
      );
    // No steering (every environment but the local fork): nothing to set, and none shown.
    expect((await post(true, orchestrator, "bee")).status).toBe(404);
    expect(await (await api(true).request("/v1/keeper")).json()).toMatchObject({ steering: null });
    const steering = new RevealSteering(14);
    const local = {
      ...orchestrator,
      keeper: null,
      revealSteering: steering,
    } as unknown as Orchestrator;
    // Without dev actions the route does not exist, even with steering.
    expect((await post(false, local, "bee")).status).toBe(404);
    const set = await post(true, local, "praying-mantis");
    expect(await set.json()).toEqual({
      steering: { firstReveal: "bee", nextReveal: "praying-mantis" },
    });
    expect(steering.nextSpecies).toBe(15);
    expect((await post(true, local, "unicorn")).status).toBe(400);
    await post(true, local, null);
    expect(steering.nextSpecies).toBeNull();
  });

  it("has no write routes without dev actions (outside APP_ENV=local)", async () => {
    expect((await api(false).request("/v1/agents/1/reset", { method: "POST" })).status).toBe(404);
    expect((await api(false).request("/v1/agents/1/tasks/noop", { method: "POST" })).status).toBe(
      404,
    );
    expect((await api(false).request("/v1/runtimes")).status).toBe(200);
  });
});
