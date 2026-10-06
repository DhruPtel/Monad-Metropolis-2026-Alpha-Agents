import { randomBytes } from "node:crypto";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GatewayError, MemoryGateway } from "./gateway-admin.ts";
import { LeaseManager } from "./leases.ts";
import { Provisioner, keyAliasFor } from "./provisioner.ts";
import { OrchestratorQueue } from "./queue.ts";
import { reconcileOnce } from "./reconciler.ts";
import { MemoryProvider } from "./sandbox.ts";
import { Redactor, decryptSecret } from "./secrets.ts";
import { Store } from "./store.ts";
import { CHAIN, must, indexAgent, redisAvailable, redisUrl, unindexAgent } from "./testing.ts";

const dbUp = await databaseAvailable();
const redisUp = dbUp && (await redisAvailable());
const SECRET = "test-orchestrator-secret-0123456789abcdef";
const ref = (agentId: number) => ({ chainId: CHAIN, agentId });

describe.skipIf(!dbUp)("provisioning on reveal (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let store: Store;
  let gateway: MemoryGateway;
  let provider: MemoryProvider;
  let leases: LeaseManager;
  let provisioner: Provisioner;
  const lines: string[] = [];
  const redactor = new Redactor();

  beforeAll(async () => {
    t = await createTestDatabase("orch_prov");
    store = new Store(t.db);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  beforeEach(async () => {
    await t.db.deleteFrom("platform.sandbox_leases").execute();
    await t.db.deleteFrom("platform.agent_runtimes").execute();
    await t.db.deleteFrom("indexer.agents").execute();
    gateway = new MemoryGateway();
    provider = new MemoryProvider();
    const log = (line: string) => lines.push(redactor.redact(line));
    leases = new LeaseManager({ store, provider, namespace: "unit", runTag: "r1", redactor, log });
    provisioner = new Provisioner({
      store,
      gateway,
      leases,
      namespace: "unit",
      secret: SECRET,
      redactor,
      log,
      startingBudgetUsd: 0.5,
    });
  });

  it("renders the config, creates one key with a budget, and records both", async () => {
    await indexAgent(t.db, 1, "medium");
    const out = await provisioner.provision(ref(1));
    expect(out.status).toBe("provisioned");
    const rt = must(await store.runtime(ref(1)));
    expect(rt).toMatchObject({ status: "ready", generation: 1, tier: 2, budgetUsd: "0.500000" });
    expect(rt.keyAlias).toBe("aa-unit-143143-1-g1");
    expect(rt.config).toMatchObject({ tier: { name: "medium", slots: 5 } });
    expect(rt.configHash).toMatch(/^[0-9a-f]{64}$/);
    const key = must(gateway.keys.get(rt.keyAlias));
    expect(key).toMatchObject({ models: ["scan-cheap"], maxBudgetUsd: 0.5 });
    expect(key.metadata).toMatchObject({ namespace: "unit", agent_id: 1, generation: 1 });
    // The stored key is encrypted, and decrypts to the key LiteLLM holds.
    expect(rt.keyCiphertext).not.toContain(key.key);
    expect(decryptSecret(must(rt.keyCiphertext), SECRET)).toBe(key.key);
    expect(lines.join("\n")).not.toContain(key.key);
  });

  it("matches each agent's rendered config to its tier", async () => {
    await indexAgent(t.db, 1, "base");
    await indexAgent(t.db, 2, "pro");
    await provisioner.provision(ref(1));
    await provisioner.provision(ref(2));
    const slots = async (id: number) =>
      (must(await store.runtime(ref(id))).config as { tier: { slots: number } }).tier.slots;
    expect([await slots(1), await slots(2)]).toEqual([3, 8]);
  });

  it("never provisions twice: repeated and concurrent calls make one key", async () => {
    await indexAgent(t.db, 1, "base");
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => provisioner.provision(ref(1))),
    );
    expect(outcomes.filter((o) => o.status === "provisioned")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "already")).toHaveLength(4);
    expect(await provisioner.provision(ref(1))).toMatchObject({ status: "already" });
    expect(gateway.calls.filter((c) => c.startsWith("create"))).toEqual([
      "create aa-unit-143143-1-g1",
    ]);
  });

  it("resumes an attempt that failed before LiteLLM answered, with the same key", async () => {
    await indexAgent(t.db, 1, "base");
    const original = gateway.createKey.bind(gateway);
    let fail = true;
    gateway.createKey = async (r) => {
      if (fail) {
        fail = false;
        throw new Error("connection refused");
      }
      return original(r);
    };
    await expect(provisioner.provision(ref(1))).rejects.toThrow(/connection refused/);
    const failed = must(await store.runtime(ref(1)));
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toBe("connection refused");
    await provisioner.provision(ref(1));
    const rt = must(await store.runtime(ref(1)));
    expect(rt).toMatchObject({ status: "ready", generation: 1 });
    expect(decryptSecret(must(rt.keyCiphertext), SECRET)).toBe(
      decryptSecret(must(failed.keyCiphertext), SECRET),
    );
    expect(gateway.keys.size).toBe(1);
  });

  it("treats a create whose reply was lost as done when the alias exists", async () => {
    await indexAgent(t.db, 1, "base");
    gateway.failAfterCreate = true;
    expect((await provisioner.provision(ref(1))).status).toBe("provisioned");
    expect(gateway.keys.size).toBe(1);
  });

  it("fails without retrying blindly when LiteLLM refuses for another reason", async () => {
    await indexAgent(t.db, 1, "base");
    gateway.createKey = async () => {
      throw new GatewayError("LiteLLM /key/generate returned 500", 500);
    };
    await expect(provisioner.provision(ref(1))).rejects.toThrow(/500/);
    expect(must(await store.runtime(ref(1))).status).toBe("failed");
  });

  it("skips an unrevealed or unknown agent", async () => {
    await indexAgent(t.db, 3, null);
    expect(await provisioner.provision(ref(3))).toEqual({
      status: "skipped",
      reason: "not revealed",
    });
    expect(await provisioner.provision(ref(99))).toEqual({
      status: "skipped",
      reason: "not revealed",
    });
    expect(gateway.keys.size).toBe(0);
  });

  it("deprovisions: ends the lease, stops the sandbox, deletes the key and clears it", async () => {
    await indexAgent(t.db, 1, "base");
    await provisioner.provision(ref(1));
    const { lease } = await leases.acquire(ref(1), "noop", 60_000);
    const sbx = await provider.create({
      template: "t",
      timeoutMs: 60_000,
      metadata: leases.sandboxTags(lease),
      allowHost: "h",
      injectHeaders: {},
    });
    await leases.attachSandbox(lease.leaseId, sbx.id);
    expect(await provisioner.deprovision(ref(1), "test")).toBe(true);
    expect(gateway.keys.size).toBe(0);
    expect(provider.killed).toEqual([sbx.id]);
    expect(await store.activeLease(ref(1))).toBeNull();
    const rt = must(await store.runtime(ref(1)));
    expect(rt).toMatchObject({ status: "deprovisioned", keyCiphertext: null });
    expect(provisioner.virtualKey(rt)).toBeNull();
    expect(await provisioner.deprovision(ref(1), "again")).toBe(false);
  });

  it("resets to a new generation with a new key, and deletes the old one", async () => {
    await indexAgent(t.db, 1, "pro");
    await provisioner.provision(ref(1));
    const out = await provisioner.reset(ref(1));
    expect(out.status).toBe("provisioned");
    expect([...gateway.keys.keys()]).toEqual([keyAliasFor("unit", ref(1), 2)]);
    expect(gateway.calls).toEqual([
      "create aa-unit-143143-1-g1",
      "delete aa-unit-143143-1-g1",
      "create aa-unit-143143-1-g2",
    ]);
  });

  it("reprovisions when a reorg changed the agent's reveal", async () => {
    await indexAgent(t.db, 1, "base");
    await provisioner.provision(ref(1));
    await indexAgent(t.db, 1, "pro");
    expect(await store.agentsToProvision(CHAIN)).toEqual([ref(1)]);
    await provisioner.provision(ref(1));
    const rt = must(await store.runtime(ref(1)));
    expect(rt).toMatchObject({ generation: 2, tier: 3 });
    expect([...gateway.keys.keys()]).toEqual(["aa-unit-143143-1-g2"]);
  });

  it("finds what to provision and deprovision from the index", async () => {
    await indexAgent(t.db, 1, "base");
    await indexAgent(t.db, 2, null);
    expect(await store.agentsToProvision(CHAIN)).toEqual([ref(1)]);
    await provisioner.provision(ref(1));
    expect(await store.agentsToProvision(CHAIN)).toEqual([]);
    await unindexAgent(t.db, 1);
    expect(await store.runtimesToDeprovision(CHAIN)).toEqual([ref(1)]);
  });

  describe.skipIf(!redisUp)("through the Redis queue (needs Redis)", () => {
    let queue: OrchestratorQueue;
    const namespace = `unit-${randomBytes(3).toString("hex")}`;

    beforeEach(async () => {
      queue = new OrchestratorQueue({
        redisUrl: redisUrl(),
        namespace,
        log: () => undefined,
        redactor,
      });
      await queue.obliterate();
    });

    it("a repeated reveal event enqueues one job and provisions once", async () => {
      await indexAgent(t.db, 1, "base");
      await indexAgent(t.db, 2, "medium");
      const first = await reconcileOnce(store, queue, CHAIN);
      const again = await reconcileOnce(store, queue, CHAIN);
      expect(first).toEqual({ provision: 2, deprovision: 0 });
      expect(again).toEqual({ provision: 2, deprovision: 0 });
      expect(await queue.pending()).toBe(2);
      queue.start(async (job) => {
        if (job.kind === "provision") return provisioner.provision(job.ref);
        if (job.kind === "deprovision") return provisioner.deprovision(job.ref, job.reason);
      });
      await queue.drain(20_000);
      expect(await reconcileOnce(store, queue, CHAIN)).toEqual({ provision: 0, deprovision: 0 });
      expect(gateway.calls.filter((c) => c.startsWith("create")).sort()).toEqual([
        "create aa-unit-143143-1-g1",
        "create aa-unit-143143-2-g1",
      ]);

      // A reorg removes agent 2: its key is deleted.
      await unindexAgent(t.db, 2);
      expect(await reconcileOnce(store, queue, CHAIN)).toEqual({ provision: 0, deprovision: 1 });
      await queue.drain(20_000);
      expect([...gateway.keys.keys()]).toEqual(["aa-unit-143143-1-g1"]);
      expect(must(await store.runtime(ref(2))).status).toBe("deprovisioned");
      await queue.obliterate();
      await queue.close();
    });
  });
});
