import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Gate } from "./gate.ts";
import { GATE_HEADER } from "./gate.ts";
import { MemoryGateway } from "./gateway-admin.ts";
import { LeaseManager } from "./leases.ts";
import { NOOP_PROMPT, type TaskContext, runNoopTask } from "./noop.ts";
import { Provisioner } from "./provisioner.ts";
import { MemoryProvider } from "./sandbox.ts";
import { Redactor, sha256Hex } from "./secrets.ts";
import { Store } from "./store.ts";
import { CHAIN, indexAgent, must } from "./testing.ts";

/**
 * The no-op task's orchestration, offline: a scripted sandbox answers the
 * curl calls to Hermes' API server as Hermes does. The live run against E2B,
 * LiteLLM and a real model is scripts/orchestrator-live.ts.
 */
const dbUp = await databaseAvailable();
const ref = { chainId: CHAIN, agentId: 1 };
const http = (status: number, body: unknown) => ({
  exitCode: 0,
  stdout: `HTTP/1.1 ${status} OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}`,
  stderr: "",
});

describe.skipIf(!dbUp)("the no-op task (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let store: Store;
  let provider: MemoryProvider;
  let leases: LeaseManager;
  let gateway: MemoryGateway;
  let ctx: TaskContext;
  const commands: string[] = [];
  const redactor = new Redactor();

  beforeAll(async () => {
    t = await createTestDatabase("orch_noop");
    store = new Store(t.db);
    gateway = new MemoryGateway();
    await indexAgent(t.db, 1, "medium");
    const prov = new Provisioner({
      store,
      gateway,
      leases: new LeaseManager({
        store,
        provider: new MemoryProvider(),
        namespace: "unit",
        runTag: "r",
        redactor,
        log: () => undefined,
      }),
      namespace: "unit",
      secret: "test-orchestrator-secret-0123456789abcdef",
      redactor,
      log: () => undefined,
      startingBudgetUsd: 0.5,
    });
    await prov.provision(ref);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  beforeEach(async () => {
    await t.db.deleteFrom("platform.sandbox_leases").execute();
    commands.length = 0;
    provider = new MemoryProvider();
    provider.onRun = (cmd) => {
      commands.push(cmd);
      if (cmd.includes("/health'")) return http(200, { status: "ok" });
      if (cmd.includes("-X POST") && cmd.includes("/v1/runs"))
        return http(202, { run_id: "run-1" });
      if (cmd.includes("/v1/runs/run-1"))
        return http(200, { status: "completed", output: "NOOP_OK" });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    leases = new LeaseManager({
      store,
      provider,
      namespace: "unit",
      runTag: "r",
      redactor,
      log: () => undefined,
    });
    const gate = {
      callsFor: () => [
        { at: "", leaseId: "x", method: "POST", path: "/v1/chat/completions", status: 200, ms: 5 },
      ],
    } as unknown as Gate;
    ctx = {
      store,
      leases,
      provider,
      template: "tmpl",
      tunnelHost: async () => "gate.example.test",
      gate,
      redactor,
      log: () => undefined,
    };
  });

  it("runs in a leased sandbox, returns a structured result and stops the sandbox", async () => {
    await store.insertTask("t1", ref, "noop");
    await runNoopTask(ctx, "t1");
    const task = must(await store.task("t1"));
    expect(task.status).toBe("succeeded");
    expect(task.result).toMatchObject({
      kind: "noop",
      agentId: 1,
      tier: "medium",
      slots: 5,
      playbook: "tier-medium@0",
      runStatus: "completed",
      replied: "NOOP_OK",
      answeredNoopOk: true,
      modelCalls: 1,
      modelCallsOk: 1,
      sandboxStopped: true,
    });
    const result = must(task.result) as { sandboxId: string; leaseId: string };
    expect(provider.killed).toEqual([result.sandboxId]);
    expect(must(await store.lease(result.leaseId)).status).toBe("ended");
    expect(
      commands.some(
        (c) => c.includes("/v1/runs") && c.includes("idempotency-key: 143143-1:noop:t1"),
      ),
    ).toBe(true);
  });

  it("injects only the lease's gate token and writes no key into the sandbox", async () => {
    let spec: { injectHeaders: Readonly<Record<string, string>>; allowHost: string } | undefined;
    let files: Map<string, string> | undefined;
    const create = provider.create.bind(provider);
    provider.create = async (s) => {
      const h = await create(s);
      spec = s;
      files = must(provider.sandboxes.get(h.id)).files;
      return h;
    };
    await store.insertTask("t2", ref, "noop");
    await runNoopTask(ctx, "t2");
    const s = must(spec);
    expect(Object.keys(s.injectHeaders)).toEqual([GATE_HEADER]);
    expect(s.allowHost).toBe("gate.example.test");
    const leaseId = must(must(await store.task("t2")).leaseId);
    expect(sha256Hex(must(s.injectHeaders[GATE_HEADER]))).toBe(
      must(await store.lease(leaseId)).gateTokenHash,
    );
    const key = must([...gateway.keys.values()][0]).key;
    const written = [...must(files).values()].join("\n");
    expect(written).toContain('"base_url": "https://gate.example.test/v1"');
    // The prompt reached Hermes' runs API as the request body.
    expect(written).toContain(
      JSON.stringify({ input: NOOP_PROMPT, session_id: "143143-1-noop-t2" }),
    );
    expect(written).not.toContain(key);
    expect(written).not.toContain(must(s.injectHeaders[GATE_HEADER]));
    expect([...must(files).keys()]).toContain(
      "/run/agent-skills/playbooks/playbook-wmon-dca/SKILL.md",
    );
  });

  it("is refused while the agent already holds a sandbox lease", async () => {
    await leases.acquire(ref, "noop", 60_000);
    await store.insertTask("t3", ref, "noop");
    await runNoopTask(ctx, "t3");
    expect(must(await store.task("t3"))).toMatchObject({
      status: "failed",
      error: "agent 1 already has an active sandbox lease",
    });
    expect(provider.sandboxes.size).toBe(0);
  });

  it("records a failure and still stops the sandbox", async () => {
    // The sandbox's setup commands fail, as when the template is broken.
    provider.onRun = () => ({ exitCode: 1, stdout: "", stderr: "" });
    await store.insertTask("t4", ref, "noop");
    await runNoopTask(ctx, "t4");
    const task = must(await store.task("t4"));
    expect(task.status).toBe("failed");
    expect(task.error).toMatch(/^sandbox setup failed \(1\)/);
    expect(provider.sandboxes.size).toBe(0);
    expect(await store.activeLease(ref)).toBeNull();
  });

  it("runs a task once even when its job is delivered twice", async () => {
    await store.insertTask("t5", ref, "noop");
    await Promise.all([runNoopTask(ctx, "t5"), runNoopTask(ctx, "t5")]);
    expect(provider.killed).toHaveLength(1);
    expect(must(await store.task("t5")).status).toBe("succeeded");
  });
});
