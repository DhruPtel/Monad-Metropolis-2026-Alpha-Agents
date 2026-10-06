import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LeaseManager } from "./leases.ts";
import { MemoryProvider } from "./sandbox.ts";
import { Redactor, sha256Hex } from "./secrets.ts";
import { LeaseHeldError, Store } from "./store.ts";
import { CHAIN, must } from "./testing.ts";

const dbUp = await databaseAvailable();
const ref = (agentId: number) => ({ chainId: CHAIN, agentId });

describe.skipIf(!dbUp)("sandbox leases (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let store: Store;
  let provider: MemoryProvider;
  let now: Date;
  let leases: LeaseManager;
  const redactor = new Redactor();

  beforeAll(async () => {
    t = await createTestDatabase("orch_lease");
    store = new Store(t.db);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    await t.db.deleteFrom("platform.sandbox_leases").execute();
    provider = new MemoryProvider();
    now = new Date();
    leases = new LeaseManager({
      store,
      provider,
      namespace: "unit",
      runTag: "run-1",
      redactor,
      log: () => undefined,
      now: () => now,
    });
  });

  const startSandbox = async (leaseId: string) => {
    const lease = must(await store.lease(leaseId));
    const sbx = await provider.create({
      template: "t",
      timeoutMs: leases.remainingMs(lease),
      metadata: leases.sandboxTags(lease),
      allowHost: "h",
      injectHeaders: {},
    });
    await leases.attachSandbox(leaseId, sbx.id);
    return sbx.id;
  };

  it("grants one active lease per agent and refuses a second", async () => {
    const a = await leases.acquire(ref(1), "noop", 60_000);
    await expect(leases.acquire(ref(1), "noop", 60_000)).rejects.toBeInstanceOf(LeaseHeldError);
    // Another agent is unaffected.
    await leases.acquire(ref(2), "noop", 60_000);
    expect(a.gateToken).toMatch(/^[0-9a-f]{64}$/);
    expect(a.lease.gateTokenHash).toBe(sha256Hex(a.gateToken));
    expect(redactor.redact(`token ${a.gateToken}`)).toBe("token <redacted>");
  });

  it("finds the lease by its token hash only while active and unexpired", async () => {
    const { lease, gateToken } = await leases.acquire(ref(1), "noop", 60_000);
    expect((await store.leaseByTokenHash(sha256Hex(gateToken), now))?.leaseId).toBe(lease.leaseId);
    expect(
      await store.leaseByTokenHash(sha256Hex(gateToken), new Date(now.getTime() + 61_000)),
    ).toBeNull();
    await leases.release(lease.leaseId, "done");
    expect(await store.leaseByTokenHash(sha256Hex(gateToken), now)).toBeNull();
  });

  it("release ends the lease and stops its sandbox, even one not yet attached", async () => {
    const { lease } = await leases.acquire(ref(1), "noop", 60_000);
    const attached = await startSandbox(lease.leaseId);
    // A second sandbox carrying the lease tag, as if created when the process stopped.
    const stray = await provider.create({
      template: "t",
      timeoutMs: 1,
      metadata: leases.sandboxTags(lease),
      allowHost: "h",
      injectHeaders: {},
    });
    await leases.release(lease.leaseId, "done");
    expect(provider.killed.sort()).toEqual([attached, stray.id].sort());
    expect(must(await store.lease(lease.leaseId))).toMatchObject({
      status: "ended",
      endReason: "done",
    });
    await leases.acquire(ref(1), "noop", 60_000);
  });

  it("sets the sandbox's own timeout to the lease's remaining time", async () => {
    const { lease } = await leases.acquire(ref(1), "noop", 90_000);
    const id = await startSandbox(lease.leaseId);
    expect(must(provider.sandboxes.get(id)).spec.timeoutMs).toBe(90_000);
    expect(must(provider.sandboxes.get(id)).spec.metadata).toMatchObject({
      app: "alpha-agents",
      namespace: "unit",
      runTag: "run-1",
      leaseId: lease.leaseId,
    });
  });

  it("times out: the reaper ends expired leases and an expired lease never blocks a new one", async () => {
    const a = await leases.acquire(ref(1), "noop", 10_000);
    const idA = await startSandbox(a.lease.leaseId);
    const b = await leases.acquire(ref(2), "noop", 60_000);
    now = new Date(now.getTime() + 11_000);
    expect(await leases.reapExpired()).toBe(1);
    expect(provider.killed).toEqual([idA]);
    expect(must(await store.lease(b.lease.leaseId)).status).toBe("active");

    await expect(leases.acquire(ref(2), "noop", 5_000)).rejects.toBeInstanceOf(LeaseHeldError);
    // Past agent 2's expiry, before any reaper pass, a new lease replaces the expired one.
    now = new Date(now.getTime() + 60_000);
    const c = await leases.acquire(ref(2), "noop", 5_000);
    expect(must(await store.lease(b.lease.leaseId))).toMatchObject({
      status: "ended",
      endReason: "expired",
    });
    expect((await store.activeLease(ref(2)))?.leaseId).toBe(c.lease.leaseId);
  });
});
