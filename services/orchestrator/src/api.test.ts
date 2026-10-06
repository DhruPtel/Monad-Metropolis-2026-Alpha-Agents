import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "./api.ts";
import { MemoryGateway } from "./gateway-admin.ts";
import { LeaseManager } from "./leases.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { Provisioner } from "./provisioner.ts";
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

  it("has no write routes without dev actions (outside APP_ENV=local)", async () => {
    expect((await api(false).request("/v1/agents/1/reset", { method: "POST" })).status).toBe(404);
    expect((await api(false).request("/v1/agents/1/tasks/noop", { method: "POST" })).status).toBe(
      404,
    );
    expect((await api(false).request("/v1/runtimes")).status).toBe(200);
  });
});
