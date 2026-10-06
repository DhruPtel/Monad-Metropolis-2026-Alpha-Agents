import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryGateway } from "./gateway-admin.ts";
import { LeaseManager } from "./leases.ts";
import { Provisioner } from "./provisioner.ts";
import { MemoryProvider } from "./sandbox.ts";
import { Redactor } from "./secrets.ts";
import { Store } from "./store.ts";
import { startupSweep } from "./sweep.ts";
import { CHAIN, indexAgent, must } from "./testing.ts";
import { tunnelPidFile } from "./tunnel.ts";

const dbUp = await databaseAvailable();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!dbUp)("the startup sweep after a hard kill (L-19)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let dir: string;
  beforeAll(async () => {
    t = await createTestDatabase("orch_sweep");
    dir = mkdtempSync(join(tmpdir(), "aa-sweep-"));
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("removes the tagged tunnel, sandboxes, leases, gate tokens and orphan keys", async () => {
    const store = new Store(t.db);
    const gateway = new MemoryGateway();
    const provider = new MemoryProvider();
    const redactor = new Redactor();
    const log = () => undefined;

    // The run that is "killed": it provisioned two agents, deprovisioned one, and held a lease.
    const dead = new LeaseManager({
      store,
      provider,
      namespace: "unit",
      runTag: "dead",
      redactor,
      log,
    });
    const provisioner = new Provisioner({
      store,
      gateway,
      leases: dead,
      namespace: "unit",
      secret: "test-orchestrator-secret-0123456789abcdef",
      redactor,
      log,
      startingBudgetUsd: 0.5,
    });
    await indexAgent(t.db, 1, "base");
    await indexAgent(t.db, 2, "pro");
    await provisioner.provision({ chainId: CHAIN, agentId: 1 });
    await provisioner.provision({ chainId: CHAIN, agentId: 2 });
    const { lease } = await dead.acquire({ chainId: CHAIN, agentId: 1 }, "noop", 600_000);
    const sbx = await provider.create({
      template: "t",
      timeoutMs: 600_000,
      metadata: dead.sandboxTags(lease),
      allowHost: "h",
      injectHeaders: {},
    });
    await dead.attachSandbox(lease.leaseId, sbx.id);
    await store.insertTask("task-1", { chainId: CHAIN, agentId: 1 }, "noop");
    await store.startTask("task-1");
    // A key created just before the kill, never recorded, and another namespace's sandbox and key.
    gateway.keys.set("aa-unit-143143-9-g1", {
      key: "k",
      alias: "aa-unit-143143-9-g1",
      models: [],
      maxBudgetUsd: 1,
      metadata: {},
    });
    gateway.keys.set("aa-other-143143-1-g1", {
      key: "k",
      alias: "aa-other-143143-1-g1",
      models: [],
      maxBudgetUsd: 1,
      metadata: {},
    });
    const other = await provider.create({
      template: "t",
      timeoutMs: 1,
      metadata: { app: "alpha-agents", namespace: "other" },
      allowHost: "h",
      injectHeaders: {},
    });
    // Its tunnel: a process named cloudflared, orphaned, with the PID file the run wrote.
    const tunnel = spawn("bash", ["-c", "exec -a cloudflared sleep 120"], { stdio: "ignore" });
    const pidFile = tunnelPidFile(dir, "unit");
    writeFileSync(pidFile, String(tunnel.pid));

    const report = await startupSweep({
      store,
      provider,
      gateway,
      namespace: "unit",
      tunnelPidFile: pidFile,
      redactor,
      log,
    });
    expect(report).toMatchObject({
      tunnel: tunnel.pid,
      sandboxes: [sbx.id],
      leases: 1,
      tasks: 1,
      keys: ["aa-unit-143143-9-g1"],
      errors: [],
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(must(tunnel.pid))).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
    expect([...provider.sandboxes.keys()]).toEqual([other.id]);
    expect(must(await store.lease(lease.leaseId))).toMatchObject({
      status: "ended",
      endReason: "swept at startup",
    });
    expect(await store.leaseByTokenHash(lease.gateTokenHash)).toBeNull();
    expect(must(await store.task("task-1")).status).toBe("failed");
    // Live runtimes keep their keys; other namespaces are untouched.
    expect([...gateway.keys.keys()].sort()).toEqual([
      "aa-other-143143-1-g1",
      "aa-unit-143143-1-g1",
      "aa-unit-143143-2-g1",
    ]);
    // A second sweep finds nothing.
    const again = await startupSweep({
      store,
      provider,
      gateway,
      namespace: "unit",
      tunnelPidFile: pidFile,
      redactor,
      log,
    });
    expect(again).toMatchObject({ tunnel: null, sandboxes: [], leases: 0, tasks: 0, keys: [] });
  });

  it("never stops a process that is not cloudflared", async () => {
    const other = spawn("sleep", ["30"], { stdio: "ignore" });
    const pidFile = tunnelPidFile(dir, "unit2");
    writeFileSync(pidFile, String(other.pid));
    const report = await startupSweep({
      store: new Store(t.db),
      provider: new MemoryProvider(),
      gateway: new MemoryGateway(),
      namespace: "unit2",
      tunnelPidFile: pidFile,
      redactor: new Redactor(),
      log: () => undefined,
    });
    expect(report.tunnel).toBeNull();
    expect(alive(must(other.pid))).toBe(true);
    other.kill();
  });
});
