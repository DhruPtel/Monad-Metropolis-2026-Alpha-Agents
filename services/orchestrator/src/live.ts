/**
 * P1-U5 live end-to-end check: `pnpm test:orchestrator:live`. Real everything,
 * on its own stack, so the playtest fork and the dev database are never touched:
 *
 * 1. A test fork on port 8550 with AgentNFT deployed, a throwaway database, the
 *    indexer in this process, and the orchestrator as a child process in its
 *    own namespace (its queue, tags and key aliases), on port 4250.
 * 2. A mint, then no manual step: the keeper reveals, the indexer indexes and
 *    the orchestrator provisions. Checks the key exists in LiteLLM and the
 *    rendered config matches the tier on chain.
 * 3. The no-op task through the console's route: E2B, the gate, LiteLLM and a
 *    real model; a structured result; the sandbox stopped.
 * 4. A hard kill: a second task, SIGKILL while its sandbox runs, then a fresh
 *    orchestrator whose startup sweep must remove the sandbox, the tunnel, the
 *    lease and the task.
 * 5. A reset deletes the old key; teardown deletes every key of the namespace.
 * 6. No secret in any orchestrator log line or API reply.
 *
 * Needs MONAD_RPC_URL, E2B_API_KEY, LITELLM_MASTER_KEY, REVEAL_KEEPER_PRIVATE_KEY,
 * cloudflared and LiteLLM running (pnpm dev:litellm). Spends a few cents of model
 * credit. Writes a redacted report to evidence/p1-u5/.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Secret, loadConfig } from "@alpha-agents/config";
import { createTestDatabase } from "@alpha-agents/db/testing";
import { localPaths, secretFragments, startTestFork } from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import { Indexer, RpcLogSource } from "@alpha-agents/indexer";
import { type Hex, createPublicClient, http, parseAbi } from "viem";
import { LiteLLMAdmin } from "./gateway-admin.ts";
import { aliasPrefix } from "./provisioner.ts";
import { OrchestratorQueue } from "./queue.ts";
import { E2BProvider } from "./sandbox.ts";
import { Redactor, decryptSecret } from "./secrets.ts";
import { Store } from "./store.ts";
import { tunnelPidFile } from "./tunnel.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const FORK_PORT = 8550;
const API_PORT = 4250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

process.loadEnvFile(join(ROOT, ".env"));
process.env.LOCAL_FORK_PORT = String(FORK_PORT);
const config = loadConfig({
  name: "orchestrator live check",
  requires: [
    "E2B_API_KEY",
    "LITELLM_MASTER_KEY",
    "REVEAL_KEEPER_PRIVATE_KEY",
    "ORCHESTRATOR_SECRET",
  ],
});
const reveal = (n: keyof typeof config.values) => (config.values[n] as Secret).reveal();
const namespace = `live-${randomBytes(3).toString("hex")}`;
const runTag = new Date().toISOString().replaceAll(":", "-");
const checks: Record<string, boolean> = {};
const report: Record<string, unknown> = { unit: "P1-U5", namespace, runTag, checks };
const secrets: string[] = [];
for (const v of Object.values(config.values))
  if (v instanceof Secret)
    for (const f of secretFragments(v.reveal()))
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(f)) secrets.push(f);
const redactor = new Redactor();
redactor.add(...secrets);
const step = (s: string) => console.log(`\n== ${s}`);
const check = (name: string, ok: boolean, detail = "") => {
  checks[name] = ok;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${redactor.redact(detail)})` : ""}`);
};

const devDir = localPaths().devDir;
mkdirSync(devDir, { recursive: true });
const logPath = join(devDir, `orchestrator-${namespace}.log`);
const logStream = createWriteStream(logPath);
const logLines: string[] = [];
const cleanup: (() => Promise<unknown>)[] = [];

async function main(): Promise<number> {
  const litellmUrl = String(config.values.LITELLM_BASE_URL);
  const gateway = new LiteLLMAdmin(litellmUrl, reveal("LITELLM_MASTER_KEY"));
  if (!(await gateway.ready())) throw new Error("LiteLLM is not running: pnpm dev:litellm");
  const provider = new E2BProvider(reveal("E2B_API_KEY"));

  step("stack: test fork, AgentNFT, database, indexer");
  const fork = await startTestFork({ port: FORK_PORT });
  cleanup.push(() => fork.stop());
  const { deployLocal } = await import("../../../scripts/lib/agent-nft.js");
  const { mintLocal } = (await import("../../../scripts/lib/agent-mint.js")) as {
    mintLocal: (nft: Hex) => Promise<{ agentId: bigint }>;
  };
  const nft = (await deployLocal({ quiet: true })) as Hex;
  const entry = addressEntry("local", "agent_nft");
  if (entry.status !== "verified") throw new Error("address book: agent_nft");
  const t = await createTestDatabase("orch_live");
  cleanup.push(() => t.drop());
  const store = new Store(t.db);
  const indexer = new Indexer({
    db: t.db,
    source: new RpcLogSource({ url: fork.url }),
    target: {
      chainId: 143143,
      agentNft: nft,
      usdc: null,
      startBlock: entry.verification.block + 1,
    },
    maxRange: 2_000,
    confirmations: 0,
    log: () => undefined,
  });
  const stopIndexer = new AbortController();
  const indexing = indexer.run(stopIndexer.signal, 500);
  cleanup.push(async () => {
    stopIndexer.abort();
    await indexing;
  });
  cleanup.push(async () => {
    const q = new OrchestratorQueue({
      redisUrl: reveal("REDIS_URL"),
      namespace,
      log: () => undefined,
      redactor,
    });
    await q.obliterate();
    await q.close();
  });
  // Last resort for anything this run tagged.
  cleanup.push(async () => {
    for (const s of await provider.list({ app: "alpha-agents", namespace }))
      await provider.kill(s.id);
    await gateway.deleteAliases(await gateway.listAliases(aliasPrefix(namespace)));
  });

  const startOrchestrator = (label: string): ChildProcess => {
    const child = spawn(
      process.execPath,
      ["services/orchestrator/src/main.ts", `--namespace=${namespace}`],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          LOCAL_FORK_PORT: String(FORK_PORT),
          DATABASE_URL: t.url,
          ORCHESTRATOR_PORT: String(API_PORT),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const take = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        logLines.push(line);
        logStream.write(`[${label}] ${line}\n`);
      }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    return child;
  };
  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`http://127.0.0.1:${API_PORT}${path}`, init);
    const text = await res.text();
    logLines.push(text);
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
  };
  const waitFor = async <T>(
    what: string,
    ms: number,
    fn: () => Promise<T | null | undefined | false>,
  ) => {
    const deadline = Date.now() + ms;
    for (;;) {
      try {
        const v = await fn();
        if (v) return v;
      } catch {
        // not yet
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(1_000);
    }
  };
  const stopChild = async (child: ChildProcess, signal: NodeJS.Signals) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    await new Promise((r) => child.once("exit", r));
  };

  step("orchestrator, then a mint with no manual reveal");
  let orch = startOrchestrator("first");
  cleanup.push(() => stopChild(orch, "SIGTERM"));
  await waitFor("the orchestrator", 60_000, async () => (await api("/health")).status === 200);
  const minted = await mintLocal(nft);
  const agentId = Number(minted.agentId);
  const mintedAt = Date.now();
  interface RuntimeView {
    agentId: string;
    status: string;
    tier: string;
    slots: number;
    keyAlias: string;
    playbook: string;
  }
  const runtime = await waitFor("provisioning", 120_000, async () => {
    const r = (await api("/v1/runtimes")).body.runtimes as RuntimeView[];
    return r.find((x) => x.agentId === String(agentId) && x.status === "ready");
  });
  const client = createPublicClient({ transport: http(fork.url) });
  const abi = parseAbi([
    "function tierOf(uint256) view returns (uint8)",
    "function slotsOf(uint256) view returns (uint8)",
  ]);
  const chainTier = await client.readContract({
    address: nft,
    abi,
    functionName: "tierOf",
    args: [BigInt(agentId)],
  });
  const chainSlots = await client.readContract({
    address: nft,
    abi,
    functionName: "slotsOf",
    args: [BigInt(agentId)],
  });
  report.provisioning = { agentId, msFromMint: Date.now() - mintedAt, runtime };
  check(
    "mint leads to reveal and provisioning with no manual step",
    runtime.status === "ready",
    `${Date.now() - mintedAt} ms`,
  );
  check(
    "rendered config matches the tier on chain",
    runtime.tier === ["base", "medium", "pro"][chainTier - 1] && runtime.slots === chainSlots,
    `${runtime.tier}, ${runtime.slots} slots, chain tier ${chainTier}`,
  );
  check(
    "the agent has its own LiteLLM key",
    await gateway.hasAlias(runtime.keyAlias),
    runtime.keyAlias,
  );
  const stored = await store.runtime({ chainId: 143143, agentId });
  if (stored?.keyCiphertext)
    secrets.push(decryptSecret(stored.keyCiphertext, reveal("ORCHESTRATOR_SECRET")));

  step("the no-op task end to end");
  const queued = await api(`/v1/agents/${agentId}/tasks/noop`, { method: "POST" });
  const taskId = String(queued.body.taskId);
  interface TaskView {
    status: string;
    result: Record<string, unknown> | null;
    error: string | null;
  }
  const task = await waitFor("the no-op task", 420_000, async () => {
    const v = (await api(`/v1/tasks/${taskId}`)).body as unknown as TaskView;
    return v.status === "succeeded" || v.status === "failed" ? v : null;
  });
  report.noop = task;
  const r = task.result ?? {};
  check(
    "no-op task succeeded with a structured result",
    task.status === "succeeded" && r.kind === "noop",
    task.error ?? "",
  );
  check(
    "the model answered through the gate",
    r.answeredNoopOk === true && Number(r.modelCallsOk) > 0,
    `${String(r.modelCalls)} calls`,
  );
  const noneLeft = async () =>
    waitFor("no sandbox left", 30_000, async () =>
      (await provider.list({ app: "alpha-agents", namespace })).length === 0 ? true : null,
    ).catch(() => false);
  check("the sandbox stopped", r.sandboxStopped === true && (await noneLeft()));

  step("hard kill while a sandbox runs, then the startup sweep");
  const second = await api(`/v1/agents/${agentId}/tasks/noop`, { method: "POST" });
  const lease = await waitFor("a running sandbox", 180_000, async () => {
    const l = await store.activeLease({ chainId: 143143, agentId });
    return l?.sandboxId ? l : null;
  });
  const pidFile = tunnelPidFile(devDir, namespace);
  const tunnelPid = Number(readFileSync(pidFile, "utf8"));
  orch.kill("SIGKILL");
  await new Promise((res) => orch.once("exit", res));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const leftSandboxes = await provider.list({ app: "alpha-agents", namespace });
  report.afterKill = {
    sandboxes: leftSandboxes.length,
    tunnelAlive: alive(tunnelPid),
    leaseActive: true,
  };
  check(
    "a hard kill leaves a sandbox and a tunnel behind (the case L-19 describes)",
    leftSandboxes.some((s) => s.id === lease.sandboxId) && alive(tunnelPid),
  );
  orch = startOrchestrator("after-kill");
  await waitFor(
    "the restarted orchestrator",
    60_000,
    async () => (await api("/health")).status === 200,
  );
  await noneLeft();
  const afterSweep = {
    sandboxes: (await provider.list({ app: "alpha-agents", namespace })).length,
    tunnelAlive: alive(tunnelPid),
    pidFile: existsSync(pidFile),
    lease: (await store.lease(lease.leaseId))?.status,
    task: (await store.task(String(second.body.taskId)))?.status,
  };
  report.afterSweep = afterSweep;
  check(
    "the startup sweep removed the leftovers",
    afterSweep.sandboxes === 0 &&
      !afterSweep.tunnelAlive &&
      !afterSweep.pidFile &&
      afterSweep.lease === "ended" &&
      afterSweep.task === "failed",
    JSON.stringify(afterSweep),
  );

  step("reset deletes the old key; teardown deletes every key");
  await api(`/v1/agents/${agentId}/reset`, { method: "POST" });
  const reset = await waitFor("the reset", 60_000, async () => {
    const rt = await store.runtime({ chainId: 143143, agentId });
    return rt && rt.status === "ready" && rt.generation === 2 ? rt : null;
  });
  if (reset.keyCiphertext)
    secrets.push(decryptSecret(reset.keyCiphertext, reveal("ORCHESTRATOR_SECRET")));
  check(
    "a reset deletes the old key and creates a new one",
    !(await gateway.hasAlias(runtime.keyAlias)) && (await gateway.hasAlias(reset.keyAlias)),
    `${runtime.keyAlias} -> ${reset.keyAlias}`,
  );
  await stopChild(orch, "SIGTERM");
  await gateway.deleteAliases(await gateway.listAliases(aliasPrefix(namespace)));
  check(
    "teardown leaves no key of this namespace",
    (await gateway.listAliases(aliasPrefix(namespace))).length === 0,
  );

  const leaked = secrets.filter((s) => s.length >= 8 && logLines.some((l) => l.includes(s)));
  check(
    "no key or token in any orchestrator log line or API reply",
    leaked.length === 0,
    `${logLines.length} lines`,
  );
  return Object.values(checks).every(Boolean) ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  report.error = redactor.redact(err instanceof Error ? err.message : String(err));
  console.error(`error: ${String(report.error)}`);
} finally {
  for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
  logStream.end();
  report.passed = code === 0;
  const text = redactor.redact(
    JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2),
  );
  const dir = join(ROOT, "evidence/p1-u5");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `live-${runTag}.json`), `${text}\n`);
  console.log(
    `\nreport: evidence/p1-u5/live-${runTag}.json; orchestrator log: ${logPath.slice(ROOT.length + 1)}`,
  );
}
process.exit(code);
