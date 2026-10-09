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
 * credit. Writes a redacted report to evidence/p1-u7/.
 *
 * P1-U6 adds credits: zero credits refuse LLM work; a deposit to the funding
 * address is credited with no other step; a task's metered charge comes off
 * the credits; a refund pays the owner on chain; a run that drains the credits
 * ends as billing with exactly one refused call; deterministic work continues
 * while the agent is restricted; and the ledger balances and matches the
 * funding address on chain.
 *
 * P1-U7 adds the Scan, with real Tavily and a real model: the orchestrator,
 * restarted with a 15-second cadence, schedules a Scan for each funded agent;
 * each uses web_search and read_url and ends with a schema-valid stage record;
 * every tool call is charged to the agent whose token made it; the narrator's
 * entry passes the number validator and a wrong number is rejected; and at
 * zero credits a Scan is refused. Needs TAVILY_API_KEY too.
 *
 * P2-U5 adds the chain check: a real agent reads its account through the chain
 * tools and proposes a swap. P2-U6 adds the trade flow: the owner arms the
 * agent (a grant to its funding address), the agent's proposal waits until the
 * owner's first approval arms it, then executes through the signer, the
 * Executor and the real v4 pool and settles after reconciliation, with
 * activity entries; a second proposal over the limits is blocked at
 * submission with its reason, served as why the agent did not trade.
 *
 * P3-U9 adds the research check: a real agent in E2B calls x_search, a saved
 * dune_query, read_contract, balance and get_code once each; each returns
 * typed, sourced results, X is charged at its price inside the caps, and the
 * mainnet lookups are free. Needs X_BEARER_TOKEN too; DUNE_API_KEY is optional
 * (D-326), and without it the check confirms Dune charges nothing.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Secret, loadConfig } from "@alpha-agents/config";
import { sql } from "@alpha-agents/db";
import { createTestDatabase } from "@alpha-agents/db/testing";
import {
  balancesOf,
  localPaths,
  mintTestUsdc,
  secretFragments,
  sendAs,
  setMonBalance,
  startTestFork,
} from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import { Indexer, RpcLogSource } from "@alpha-agents/indexer";
import { type Hex, createPublicClient, encodeFunctionData, http, parseAbi } from "viem";
import { Ledger } from "./credits/ledger.ts";
import { type ScanFacts, narratorKeyFor, validateNarration } from "./narrator.ts";
import { LiteLLMAdmin } from "./gateway-admin.ts";
import { aliasPrefix } from "./provisioner.ts";
import { OrchestratorQueue } from "./queue.ts";
import { E2BProvider } from "./sandbox.ts";
import { Redactor, decryptSecret } from "./secrets.ts";
import { Store } from "./store.ts";
import { must } from "./testing.ts";
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
    "TAVILY_API_KEY",
  ],
});
const reveal = (n: keyof typeof config.values) => (config.values[n] as Secret).reveal();
const namespace = `live-${randomBytes(3).toString("hex")}`;
const runTag = new Date().toISOString().replaceAll(":", "-");
const checks: Record<string, boolean> = {};
const report: Record<string, unknown> = {
  unit: "P1-U5, P1-U6 and P1-U7",
  namespace,
  runTag,
  checks,
};
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
    mintLocal: (nft: Hex) => Promise<{ agentId: bigint; minter: Hex }>;
  };
  const nft = (await deployLocal({ quiet: true })) as Hex;
  const entry = addressEntry("local", "agent_nft");
  if (entry.status !== "verified") throw new Error("address book: agent_nft");
  const usdc = addressEntry("local", "usdc");
  if (usdc.status !== "verified") throw new Error("address book: usdc");
  const t = await createTestDatabase("orch_live");
  cleanup.push(() => t.drop());
  const store = new Store(t.db);
  const indexer = new Indexer({
    db: t.db,
    source: new RpcLogSource({ url: fork.url }),
    target: {
      chainId: 143143,
      agentNft: nft,
      usdc: usdc.address as Hex,
      startBlock: entry.verification.block + 1,
    },
    maxRange: 2_000,
    confirmations: 0,
    log: (line) => {
      logLines.push(line);
      logStream.write(`[indexer] ${redactor.redact(line)}\n`);
    },
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

  const startOrchestrator = (label: string, extra: string[] = []): ChildProcess => {
    const child = spawn(
      process.execPath,
      ["services/orchestrator/src/main.ts", `--namespace=${namespace}`, ...extra],
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

  // ---- P1-U6: credits ----
  const ledger = new Ledger(t.db);
  interface CreditsRow {
    agentId: string;
    fundingAddress: string | null;
    creditsUsdcE6: string;
    spendableUsdcE6: string;
    heldUsdcE6: string;
    restricted: boolean;
  }
  const creditsOf = async (id: number) =>
    ((await api("/v1/credits")).body.agents as CreditsRow[]).find((a) => a.agentId === String(id));
  const fundingOf = async (id: number) =>
    must(
      await waitFor("a funding address", 30_000, async () => (await creditsOf(id))?.fundingAddress),
    ) as Hex;
  /**
   * USDC sent by the agent's owner, as an owner funds it: D-242 refunds follow contributions,
   * and a mint straight to the funding address has no contributor to refund.
   */
  const fund = async (id: number, amountE6: bigint) => {
    const to = await fundingOf(id);
    const owner = await client.readContract({
      address: nft,
      abi: parseAbi(["function ownerOf(uint256 agentId) view returns (address)"]),
      functionName: "ownerOf",
      args: [BigInt(id)],
    });
    await mintTestUsdc(owner, amountE6, fork.url);
    if ((await balancesOf(owner, fork.url)).monWei < 10n ** 18n)
      await setMonBalance(owner, 10n ** 19n, fork.url);
    await sendAs(
      fork.url,
      owner,
      usdc.address as Hex,
      encodeFunctionData({
        abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
        functionName: "transfer",
        args: [to, amountE6],
      }),
    );
  };
  /** The ledger's funding address balance must equal the address's USDC on chain. */
  const reconciled = async (id: number) => {
    const onchain = (await balancesOf(await fundingOf(id), fork.url)).usdcE6;
    const books = await ledger.balances(143143, id);
    return { onchain, books: books.fundingAddress, ok: onchain === books.fundingAddress };
  };

  step("credits: zero refuses LLM work; a deposit is credited with no other step");
  const zero = await api(`/v1/agents/${agentId}/tasks/noop`, { method: "POST" });
  check(
    "with no credits the agent is RESTRICTED and an LLM task is refused",
    zero.status === 409 &&
      zero.body.error === "credits_exhausted" &&
      (await creditsOf(agentId))?.restricted === true,
    `${zero.status} ${String(zero.body.error)}`,
  );
  const fundedAt = Date.now();
  await fund(agentId, 1_000_000n);
  const credited = await waitFor("the deposit to be credited", 60_000, async () => {
    const c = await creditsOf(agentId);
    return c && c.spendableUsdcE6 === "1000000" ? c : null;
  }).catch(async (err: unknown) => {
    const rows = await t.db.selectFrom("indexer.usdc_transfers").selectAll().execute();
    const wm = await indexer.watermark();
    console.log(
      `indexed USDC transfers: ${JSON.stringify(rows)}; watermark ${wm.number}; head ${await client.getBlockNumber()}`,
    );
    throw err;
  });
  const budgeted = await waitFor("the gateway budget", 30_000, async () => {
    const rt = await store.runtime({ chainId: 143143, agentId });
    return rt && Number(rt.budgetUsd) === 0.8 ? rt : null;
  });
  report.deposit = { msToCredit: Date.now() - fundedAt, credited, budgetUsd: budgeted.budgetUsd };
  check(
    "USDC sent to the funding address appears as credits with no other action",
    credited.restricted === false,
    `${Date.now() - fundedAt} ms; key budget ${budgeted.budgetUsd} USD`,
  );

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
  // Every request LiteLLM logged with a cost must become exactly one receipt (L-17: its log lags).
  const liveKey = must(
    decryptSecret(
      must(must(await store.runtime({ chainId: 143143, agentId })).keyCiphertext),
      reveal("ORCHESTRATOR_SECRET"),
    ),
  );
  let gatewayRows: { requestId: string; spendUsd: number }[] = [];
  const metered = await waitFor("metering", 120_000, async () => {
    gatewayRows = await gateway.spendLogs(liveKey);
    const costed = gatewayRows
      .filter((x) => x.spendUsd > 0)
      .map((x) => x.requestId)
      .sort();
    const receipts = await t.db
      .selectFrom("platform.usage_receipts")
      .select(["request_id", "charge_usdc_e6"])
      .where("agent_id", "=", agentId)
      .execute();
    const got = receipts.map((x) => x.request_id).sort();
    return costed.length > 0 && JSON.stringify(costed) === JSON.stringify(got) ? receipts : null;
  });
  report.gatewayLog = {
    rows: gatewayRows.length,
    costed: gatewayRows.filter((x) => x.spendUsd > 0).length,
    gateCallsOk: r.modelCallsOk,
  };
  const charged = metered.reduce((a, x) => a + BigInt(x.charge_usdc_e6), 0n);
  const afterTask = must(await creditsOf(agentId));
  report.metering = {
    receipts: metered.length,
    chargedUsdcE6: charged.toString(),
    after: afterTask,
  };
  check(
    "the task reduced credits by exactly the metered amount, and the ledger balances",
    charged > 0n &&
      BigInt(afterTask.creditsUsdcE6) === 1_000_000n - charged &&
      (await ledger.balanced(143143)) &&
      (await reconciled(agentId)).ok,
    `${metered.length} receipts, ${charged} USDC units charged`,
  );

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

  step("refund to the current owner");
  const owner = minted.minter;
  const ownerBefore = (await balancesOf(owner, fork.url)).usdcE6;
  const before = must(await creditsOf(agentId));
  const asked = await api(`/v1/agents/${agentId}/refund`, { method: "POST" });
  const refunded = await waitFor("the refund", 120_000, async () => {
    const v = (await api(`/v1/refunds/${String(asked.body.refundId)}`)).body;
    return v.status === "sent" || v.status === "refused" || v.status === "failed" ? v : null;
  });
  const ownerAfter = (await balancesOf(owner, fork.url)).usdcE6;
  report.refund = { refund: refunded, ownerGainedUsdcE6: (ownerAfter - ownerBefore).toString() };
  check(
    "a refund returns the remaining credits as USDC to the current owner",
    refunded.status === "sent" &&
      ownerAfter - ownerBefore === BigInt(before.creditsUsdcE6) &&
      (await creditsOf(agentId))?.restricted === true &&
      (await reconciled(agentId)).ok,
    `${ownerAfter - ownerBefore} USDC units to ${owner.slice(0, 8)}...`,
  );

  step("the signer runs beside the orchestrator (P2-U4)");
  const signerState = (await api("/v1/signer")).body;
  check(
    "the signer worker is on, pinned to the local fork's chain",
    signerState.on === true && signerState.chainId === 143143,
    JSON.stringify(signerState),
  );

  step("drain to zero during a run: billing, no retries");
  // Credits run out while a task waits: a small balance lets the task be queued, then the
  // agent's own key spends it (as an earlier run would) before the sandbox's first model call.
  await fund(agentId, 2_000n); // 0.002 USDC
  await waitFor("the small deposit", 60_000, async () =>
    (await creditsOf(agentId))?.spendableUsdcE6 === "2000" ? true : null,
  );
  const drainId = String(
    (await api(`/v1/agents/${agentId}/tasks/noop`, { method: "POST" })).body.taskId,
  );
  const currentKey = must(
    decryptSecret(
      must(must(await store.runtime({ chainId: 143143, agentId })).keyCiphertext),
      reveal("ORCHESTRATOR_SECRET"),
    ),
  );
  secrets.push(currentKey);
  const spendNow = await fetch(`${litellmUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${currentKey}`, "content-type": "application/json" },
    // About 600 output tokens: more than the 0.0016 USD of provider cost 0.002 USDC buys.
    body: JSON.stringify({
      model: "scan-cheap",
      messages: [{ role: "user", content: "Write about 450 words on how honeybees make honey." }],
      max_tokens: 700,
    }),
  });
  await waitFor("the outside call to be metered", 120_000, async () =>
    (await creditsOf(agentId))?.restricted ? true : null,
  );
  const drained = await waitFor("the draining task", 420_000, async () => {
    const v = (await api(`/v1/tasks/${drainId}`)).body as unknown as TaskView;
    return v.status === "succeeded" || v.status === "failed" ? v : null;
  });
  const dr = drained.result ?? {};
  const gated = (dr.gatedCalls ?? []) as string[];
  const completions = gated.filter((c) => c.includes("/chat/completions"));
  report.drain = { outsideCall: spendNow.status, task: drained };
  check(
    "at zero the next call is refused and the run ends as billing, with no retries",
    drained.status === "failed" &&
      String(drained.error).startsWith("billing") &&
      dr.stopReason === "billing" &&
      completions.length === 1 &&
      completions[0]?.endsWith(" 402") === true,
    `gated calls: ${gated.join(", ") || "none"}`,
  );
  await waitFor("metering of the last call", 90_000, async () =>
    (await creditsOf(agentId))?.restricted ? true : null,
  );
  const again = await api(`/v1/agents/${agentId}/tasks/noop`, { method: "POST" });
  check(
    "afterwards the agent stays RESTRICTED and LLM tasks are refused",
    again.status === 409 && again.body.error === "credits_exhausted",
  );

  step("while restricted, deterministic work keeps running");
  const second2 = await mintLocal(nft);
  const other = Number(second2.agentId);
  const otherReady = await waitFor(
    "the next agent's reveal and provisioning",
    120_000,
    async () => {
      const rs = (await api("/v1/runtimes")).body.runtimes as RuntimeView[];
      return rs.find((x) => x.agentId === String(other) && x.status === "ready");
    },
  );
  await fund(agentId, 3_000_000n);
  const refilled = await waitFor("a deposit while restricted", 60_000, async () => {
    const c = await creditsOf(agentId);
    return c && !c.restricted ? c : null;
  });
  check(
    "the keeper, provisioning and deposits keep working while an agent is restricted",
    otherReady.status === "ready" && BigInt(refilled.spendableUsdcE6) > 0n,
    `agent ${other} provisioned; agent ${agentId} has ${refilled.spendableUsdcE6} again`,
  );
  check(
    "the ledger balances and matches the funding address on chain",
    (await ledger.balanced(143143)) && (await reconciled(agentId)).ok,
    JSON.stringify(await reconciled(agentId), (_k, v) => (typeof v === "bigint" ? String(v) : v)),
  );

  // ---- P1-U7: scheduled Scans with real Tavily and a real model ----
  step("the scheduler queues a Scan for each funded agent; web_search, read_url, complete_stage");
  secrets.push(narratorKeyFor(reveal("ORCHESTRATOR_SECRET"), namespace));
  await fund(other, 1_000_000n);
  await waitFor("the second agent's deposit", 60_000, async () =>
    (await creditsOf(other))?.spendableUsdcE6 === "1000000" ? true : null,
  );
  await stopChild(orch, "SIGTERM");
  // Both agents are funded and have never scanned: due once their first credit is 15 s old.
  orch = startOrchestrator("scans", ["--scan-interval-seconds=15"]);
  await waitFor("the orchestrator", 60_000, async () => (await api("/health")).status === 200);
  const scanTasks = await waitFor("the scheduler to queue both Scans", 120_000, async () => {
    const rows = await t.db
      .selectFrom("platform.agent_tasks")
      .select(["task_id", "agent_id"])
      .where("kind", "=", "scan")
      .execute();
    return rows.length >= 2 ? rows : null;
  });
  const scans = new Map<number, TaskView & { taskId: string }>();
  for (const row of scanTasks) {
    const v = await waitFor(`agent ${row.agent_id}'s Scan`, 600_000, async () => {
      const x = (await api(`/v1/tasks/${row.task_id}`)).body as unknown as TaskView;
      return x.status === "succeeded" || x.status === "failed" ? x : null;
    });
    scans.set(row.agent_id, { ...v, taskId: row.task_id });
  }
  const otherScan = must(scans.get(other));
  const os = (otherScan.result ?? {}) as {
    stopReason?: string;
    leaseId?: string;
    stage?: { outcome: string; schemaValid: boolean; candidates: unknown[] } | null;
    toolCalls?: { tool: string; status: string; errorCode: string | null; chargeUsdcE6: string }[];
    modelCalls?: number;
  };
  const used = (tool: string) =>
    (os.toolCalls ?? []).filter((c) => c.tool === tool && c.status === "succeeded").length;
  report.scans = Object.fromEntries([...scans].map(([id, v]) => [id, v]));
  check(
    "the scheduler queued a Scan for each funded agent with no manual step",
    scans.has(other) && scans.has(agentId) && scanTasks.length === 2,
    scanTasks.map((x) => `agent ${x.agent_id}`).join(", "),
  );
  check(
    "a funded agent's Scan used web_search and read_url and returned a schema-valid result",
    otherScan.status === "succeeded" &&
      os.stopReason === "COMPLETED" &&
      os.stage?.schemaValid === true &&
      used("web_search") > 0 &&
      used("read_url") > 0,
    `${otherScan.status}; ${used("web_search")} searches, ${used("read_url")} pages; ${os.stage?.outcome ?? "no stage"}; ${otherScan.error ?? ""}`,
  );
  // P3-U2: the agent read the market snapshot in E2B and got sourced, checked figures back.
  const snapshotCalls = await t.db
    .selectFrom("platform.tool_calls")
    .select(["status", "charge_usdc_e6", "cache_hit", "agent_id"])
    .where("tool", "=", "market_snapshot")
    .where("agent_id", "=", other)
    .execute();
  report.marketSnapshot = snapshotCalls;
  check(
    "the agent called market_snapshot from its sandbox and it answered",
    used("market_snapshot") > 0 && snapshotCalls.some((c) => c.status === "succeeded"),
    `${used("market_snapshot")} market_snapshot calls: ${snapshotCalls.map((c) => `${c.status}${c.cache_hit ? " (cached, free)" : ` ${c.charge_usdc_e6}`}`).join(", ")}`,
  );
  // P3-U9: a real agent in E2B uses each research source once, through the research check.
  {
    const started = await waitFor("the research check to be accepted", 300_000, async () => {
      const r = await api(`/v1/agents/${other}/tasks/research-check`, { method: "POST" });
      if (r.status === 202) return r;
      if (r.body.error !== "lease_held") throw new Error(`research check refused: ${r.status}`);
      await new Promise((res) => setTimeout(res, 3_000));
      return null;
    });
    const task = await waitFor("the research check", 600_000, async () => {
      const x = (await api(`/v1/tasks/${String(started.body.taskId)}`)).body as unknown as TaskView;
      return x.status === "succeeded" || x.status === "failed" ? x : null;
    });
    const res = (task.result ?? {}) as {
      stopReason?: string;
      leaseId?: string;
      toolCalls?: {
        tool: string;
        status: string;
        errorCode: string | null;
        chargeUsdcE6: string;
        cacheHit: boolean;
      }[];
    };
    const outputs = res.leaseId
      ? await t.db
          .selectFrom("platform.tool_calls")
          .select(["tool", "status", "error_code", "charge_usdc_e6", "cache_hit", "summary"])
          .where("lease_id", "=", res.leaseId)
          .orderBy("started_at")
          .execute()
      : [];
    const research = (await api("/v1/research")).body as Record<string, unknown>;
    report.researchCheck = {
      status: task.status,
      error: task.error,
      result: res,
      calls: outputs,
      usage: research.usage,
    };
    const ok = (tool: string) =>
      (res.toolCalls ?? []).some((c) => c.tool === tool && c.status === "succeeded");
    const line = (res.toolCalls ?? [])
      .map(
        (c) =>
          `${c.tool} ${c.status === "succeeded" ? "ok" : (c.errorCode ?? c.status)} ${c.chargeUsdcE6}${c.cacheHit ? " (cached)" : ""}`,
      )
      .join(", ");
    check(
      "a real agent in E2B ran x_search and got sourced, untrusted posts",
      ok("x_search"),
      line,
    );
    // Dune is optional, off without a key (D-326): with a key the query answers typed rows;
    // without one it is refused before the meter, so it charges nothing and leaves no record.
    const duneRows = outputs.filter((c) => c.tool === "dune_query");
    check(
      process.env.DUNE_API_KEY?.trim()
        ? "a real agent ran a saved Dune query by name and got typed rows"
        : "Dune is off without a key: the agent's dune_query is refused with no charge",
      process.env.DUNE_API_KEY?.trim()
        ? ok("dune_query")
        : duneRows.every((c) => String(c.charge_usdc_e6) === "0"),
      process.env.DUNE_API_KEY?.trim() ? line : `${duneRows.length} recorded Dune calls; ${line}`,
    );
    check(
      "a real agent read a contract, a balance and code on Monad mainnet, typed and free",
      ["read_contract", "balance", "get_code"].every(ok) &&
        outputs
          .filter((c) => ["read_contract", "balance", "get_code"].includes(c.tool))
          .every((c) => String(c.charge_usdc_e6) === "0"),
      line,
    );
    const x = outputs.find((c) => c.tool === "x_search" && c.status === "succeeded");
    check(
      "the X search was charged at its price, or free from the cache, and stayed inside the caps",
      x !== undefined &&
        (x.cache_hit ? String(x.charge_usdc_e6) === "0" : String(x.charge_usdc_e6) === "62500") &&
        Number((research.usage as { xPostsRead?: number } | undefined)?.xPostsRead ?? 999) <= 300,
      `${x?.charge_usdc_e6 ?? "none"} ${x?.cache_hit ? "(cached)" : ""}; usage ${JSON.stringify(research.usage)}`,
    );
  }

  // Every paid call is charged to the agent whose lease token made it, and nothing else.
  const charges = await t.db
    .selectFrom("platform.tool_calls as c")
    .innerJoin("platform.sandbox_leases as l", "l.lease_id", "c.lease_id")
    .leftJoin("platform.ledger_entries as e", "e.entry_id", "c.entry_id")
    .select([
      "c.agent_id as callAgent",
      "l.agent_id as leaseAgent",
      "e.agent_id as entryAgent",
      "c.status",
      "c.charge_usdc_e6",
      "c.reversal_entry_id",
      "c.server",
    ])
    .execute();
  // Paid means charged: an answer the shared cache held is free and has no ledger entry (D-322).
  const paid = charges.filter(
    (c) => c.server === "data" && c.status !== "refused" && BigInt(c.charge_usdc_e6) > 0n,
  );
  const toolSpendOf = (id: number) =>
    paid
      .filter((c) => c.callAgent === id && c.status === "succeeded")
      .reduce((a, c) => a + BigInt(c.charge_usdc_e6), 0n);
  const ledgerToolSpend = async (id: number) => {
    const rows = await t.db
      .selectFrom("platform.ledger_entries as e")
      .innerJoin("platform.ledger_lines as l", "l.entry_id", "e.entry_id")
      .select(["l.amount"])
      .where("e.agent_id", "=", id)
      .where("l.account", "=", "agent_credits")
      .where(sql<boolean>`e.source->>'kind' in ('tool_call', 'tool_call_failed')`)
      .execute();
    return rows.reduce((a, r) => a + BigInt(r.amount), 0n);
  };
  report.toolCharges = {
    calls: charges.length,
    paid: paid.length,
    byAgent: { [agentId]: toolSpendOf(agentId), [other]: toolSpendOf(other) },
  };
  check(
    "each tool call is charged to the right agent, and the ledger holds exactly those charges",
    paid.length > 0 &&
      charges.every((c) => c.callAgent === c.leaseAgent) &&
      paid.every((c) => c.entryAgent === c.callAgent) &&
      (await ledgerToolSpend(other)) === toolSpendOf(other) &&
      (await ledgerToolSpend(agentId)) === toolSpendOf(agentId) &&
      (await ledger.balanced(143143)) &&
      (await reconciled(other)).ok,
    `${paid.length} paid calls; agent ${other} ${toolSpendOf(other)}, agent ${agentId} ${toolSpendOf(agentId)} USDC units`,
  );
  const activity = (await api(`/v1/agents/${other}/activity`)).body.entries as {
    taskId: string;
    text: string;
    renderedBy: string;
  }[];
  const scanEntry = await t.db
    .selectFrom("platform.activity_entries")
    .selectAll()
    .where("task_id", "=", otherScan.taskId)
    .executeTakeFirst();
  const facts = scanEntry?.facts as unknown as ScanFacts | undefined;
  report.activity = {
    entry: scanEntry?.text,
    renderedBy: scanEntry?.rendered_by,
    rejections: scanEntry?.rejections,
  };
  check(
    "the narrator wrote an activity entry that passes the number validator",
    scanEntry !== undefined &&
      facts !== undefined &&
      validateNarration(scanEntry.text, facts).ok &&
      activity.some((a) => a.taskId === otherScan.taskId && a.text === scanEntry.text),
    `${scanEntry?.rendered_by ?? "none"}: ${scanEntry?.text ?? ""}`,
  );
  const wrong = `${(scanEntry?.text ?? "").slice(0, 200)} It spent 987654 USDC.`;
  const verdict = facts ? validateNarration(wrong, facts) : { ok: true as const };
  check(
    "the same entry with a deliberately wrong number is rejected",
    !verdict.ok && /987654/.test(verdict.ok ? "" : verdict.reason),
    verdict.ok ? "accepted" : verdict.reason,
  );
  // ---- P2-U5: a real agent in E2B uses the chain tools ----
  step(
    "the chain check: a real agent reads its account through the chain tools and proposes a swap",
  );
  {
    const { deployAccountFactoryLocal } = await import("../../../scripts/lib/account-factory.js");
    const custody = await import("../../../scripts/lib/custody.js");
    const { send, impersonate } =
      (await import("../../../scripts/lib/agent-reveal.js")) as unknown as {
        send: (from: Hex, request: unknown) => Promise<unknown>;
        impersonate: (address: Hex) => Promise<void>;
      };
    const { factory } = (await deployAccountFactoryLocal({ quiet: true })) as { factory: Hex };
    const owner = (await client.readContract({
      address: nft,
      abi: parseAbi(["function ownerOf(uint256 agentId) view returns (address)"]),
      functionName: "ownerOf",
      args: [BigInt(other)],
    })) as Hex;
    await impersonate(owner);
    // The local allowlist is anvil accounts 6 to 9 (A-33); the admin (anvil 0) adds this owner.
    await send("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", {
      address: factory,
      abi: parseAbi(["function addDepositor(address depositor)"]),
      functionName: "addDepositor",
      args: [owner],
    });
    const { account } = (await custody.ensureAccount(factory, BigInt(other), owner)) as {
      account: Hex;
    };
    await custody.depositUsdc(account, owner, 20_000_000n);
    // P2-U6: the owner arms the agent: a grant to its funding address (D-243), registered as the
    // owner's wallet would (impersonated on the fork), then checked on chain and recorded.
    const armed = await api(`/v1/agents/${other}/arm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    check(
      "the owner's grant to the funding address is recorded: armed once the first trade is approved",
      armed.status === 201 &&
        (armed.body.arming as { state?: string } | undefined)?.state === "awaiting_first_trade",
      `${armed.status} ${JSON.stringify(armed.body).slice(0, 200)}`,
    );
    // The scheduler's Scans (15-second cadence here) may hold the agent's sandbox: retry
    // until the chain check is accepted rather than waiting on a task that never started.
    const started = await waitFor("the chain check to be accepted", 300_000, async () => {
      const r = await api(`/v1/agents/${other}/tasks/chain-check`, { method: "POST" });
      if (r.status === 202) return r;
      if (r.body.error !== "lease_held") throw new Error(`chain check refused: ${r.status}`);
      await new Promise((res) => setTimeout(res, 3_000));
      return null;
    });
    const task = await waitFor("the chain check", 600_000, async () => {
      const x = (await api(`/v1/tasks/${String(started.body.taskId)}`)).body as unknown as TaskView;
      return x.status === "succeeded" || x.status === "failed" ? x : null;
    });
    const res = (task.result ?? {}) as {
      stopReason?: string;
      toolCalls?: { tool: string; status: string; errorCode: string | null }[];
      intents?: { intentId: string; status: string; reasonCodes: string[] }[];
    };
    const chainView = (await api(`/v1/agents/${other}/chain`)).body as {
      portfolio: Record<string, unknown> | null;
      intents: { intentId: string; status: string; reasonCodes: string[]; amountIn: string }[];
    };
    const intent = res.intents?.[0];
    const entry = intent
      ? await waitFor("the proposal's activity entry", 60_000, async () =>
          t.db
            .selectFrom("platform.activity_entries")
            .selectAll()
            .where("task_id", "=", intent.intentId)
            .executeTakeFirst(),
        )
      : undefined;
    report.chainCheck = {
      status: task.status,
      error: task.error,
      result: res,
      chain: chainView,
      entry: entry?.text,
    };
    const ok = (tool: string) =>
      (res.toolCalls ?? []).some((c) => c.tool === tool && c.status === "succeeded");
    check(
      "a real agent read its portfolio, prices, limits and tradable_now through the chain tools",
      task.status === "succeeded" &&
        res.stopReason === "COMPLETED" &&
        ["get_portfolio", "get_prices", "get_limits", "tradable_now"].every(ok) &&
        chainView.portfolio?.totalValueUsdc === "20",
      `${task.status}; ${(res.toolCalls ?? []).map((c) => `${c.tool}:${c.status}`).join(", ")}; ${task.error ?? ""}`,
    );
    check(
      "its proposed swap waits for approval as an intent, with no calldata and an activity entry",
      intent?.status === "awaiting_approval" &&
        chainView.intents.some((i) => i.intentId === intent.intentId) &&
        !/calldata|"data":"0x/.test(JSON.stringify(chainView)) &&
        entry !== undefined &&
        entry.kind === "intent" &&
        validateNarration(entry.text, entry.facts as never).ok,
      `${intent?.status ?? "no intent"} ${(intent?.reasonCodes ?? []).join(",")}; ${entry?.text ?? ""}`,
    );
    // Nothing is sent before the owner approves the first trade.
    const before = await t.db
      .selectFrom("platform.signer_outbox")
      .select("tx_id")
      .where("kind", "=", "executor_swap")
      .execute();
    check(
      "no swap reached the signer before the owner's first approval",
      before.length === 0,
      `${before.length} swaps`,
    );

    // ---- P2-U6: the owner approves; the trade executes on the real v4 pool and settles ----
    step("the trade flow: the owner's first approval arms the agent and the swap settles");
    const approved = intent
      ? await api(`/v1/agents/${other}/intents/${intent.intentId}/approve`, { method: "POST" })
      : null;
    check(
      "the owner's first approval arms the agent",
      approved?.status === 200 && approved.body.armed === true,
      `${approved?.status} ${JSON.stringify(approved?.body ?? {}).slice(0, 200)}`,
    );
    interface LiveIntent {
      intentId: string;
      status: string;
      reasonCodes: string[];
      blockers: { code: string; message: string; clears: string }[];
      amountOut: { amount: string } | null;
      txHash: string | null;
      approvedBy: string | null;
    }
    const intentNow = async (id: string) =>
      ((await api(`/v1/agents/${other}/chain`)).body.intents as LiveIntent[]).find(
        (i) => i.intentId === id,
      );
    const settled = intent
      ? await waitFor("the first trade to settle", 180_000, async () => {
          const i = await intentNow(intent.intentId);
          return i && ["reconciled", "rejected", "failed"].includes(i.status) ? i : null;
        })
      : undefined;
    const outbox = settled?.txHash
      ? await t.db
          .selectFrom("platform.signer_outbox")
          .select(["status", "amount_out", "ledger_entry_id"])
          .where("tx_hash", "=", settled.txHash)
          .executeTakeFirst()
      : undefined;
    report.trade = { intent: settled, outbox };
    check(
      "the swap executed through the signer, the Executor and the real v4 pool, and settled after reconciliation",
      settled?.status === "reconciled" &&
        Number(settled.amountOut?.amount ?? 0) > 0 &&
        outbox?.status === "reconciled" &&
        outbox.ledger_entry_id !== null,
      `${settled?.status ?? "none"} ${settled?.amountOut?.amount ?? ""} ${outbox?.status ?? ""}`,
    );
    const tradeEntry =
      intent && settled?.status === "reconciled"
        ? await waitFor("the trade's activity entry", 60_000, async () =>
            t.db
              .selectFrom("platform.activity_entries")
              .selectAll()
              .where("task_id", "=", `${intent.intentId}:trade`)
              .executeTakeFirst(),
          )
        : undefined;
    const armedEntry = await t.db
      .selectFrom("platform.activity_entries")
      .select(["text", "kind"])
      .where("agent_id", "=", other)
      .where("kind", "=", "arming")
      .execute();
    report.tradeEntries = { trade: tradeEntry?.text, arming: armedEntry.map((e) => e.text) };
    check(
      "the trade and the arming have activity entries held to the number validator",
      tradeEntry !== undefined &&
        tradeEntry.kind === "trade" &&
        validateNarration(tradeEntry.text, tradeEntry.facts as never).ok &&
        armedEntry.length >= 1,
      `${tradeEntry?.text ?? "none"}; ${armedEntry.length} arming entries`,
    );

    // A second proposal over the limits: armed, so it is approved on its own, and the
    // re-check at submission blocks it with its reason; nothing more reaches the signer.
    const account20 = (await api(`/v1/agents/${other}/chain`)).body;
    const overId = `intent-${randomUUID()}`;
    const view = await t.db
      .selectFrom("platform.intents")
      .select(["owner_epoch", "config_epoch", "account"])
      .where("intent_id", "=", intent?.intentId ?? "")
      .executeTakeFirst();
    await t.db
      .insertInto("platform.intents")
      .values({
        intent_id: overId,
        chain_id: 143143,
        agent_id: other,
        lease_id: "live-over-limit",
        kind: "swap",
        account: view?.account ?? null,
        sell: "USDC",
        buy: "WMON",
        amount_in: "10000000", // half the 20 USDC account: over the 10% trade size
        reason: "Live check: a trade over the size limit.",
        idempotency_key: overId,
        status: "awaiting_approval",
        reason_codes: "[]",
        checks: "{}",
        owner_epoch: view?.owner_epoch ?? null,
        config_epoch: view?.config_epoch ?? null,
        expires_at: new Date(Date.now() + 1_800_000),
      })
      .execute();
    const blocked = await waitFor("the over-limit proposal to be blocked", 60_000, async () => {
      const i = await intentNow(overId);
      return i && i.status !== "awaiting_approval" && i.status !== "approved" ? i : null;
    });
    const why = (await api(`/v1/agents/${other}/why-not-traded`)).body as {
      reasons?: { code: string; intentId: string | null }[];
    };
    const swapsAfter = await t.db
      .selectFrom("platform.signer_outbox")
      .select("tx_id")
      .where("kind", "=", "executor_swap")
      .execute();
    report.overLimit = { intent: blocked, why, before: account20.portfolio };
    check(
      "an over-limit proposal is blocked at submission with its reason, served as why the agent did not trade",
      blocked.status === "rejected" &&
        blocked.reasonCodes.includes("TRADE_SIZE_EXCEEDED") &&
        (why.reasons ?? []).some(
          (r) => r.intentId === overId && r.code === "TRADE_SIZE_EXCEEDED",
        ) &&
        swapsAfter.length === 1,
      `${blocked.status} ${blocked.reasonCodes.join(",")}; ${swapsAfter.length} swaps`,
    );
  }

  const refundOther = await api(`/v1/agents/${other}/refund`, { method: "POST" });
  await waitFor("the second agent's refund", 120_000, async () => {
    const v = (await api(`/v1/refunds/${String(refundOther.body.refundId)}`)).body;
    return v.status === "sent" ? v : null;
  });
  const broke = await api(`/v1/agents/${other}/tasks/scan`, { method: "POST" });
  check(
    "at zero credits a Scan is refused",
    broke.status === 409 && broke.body.error === "credits_exhausted",
    `${broke.status} ${String(broke.body.error)}`,
  );

  for (const id of [agentId, other]) {
    const rt = await store.runtime({ chainId: 143143, agentId: id });
    if (rt?.keyCiphertext)
      secrets.push(decryptSecret(rt.keyCiphertext, reveal("ORCHESTRATOR_SECRET")));
  }
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
  const dir = join(ROOT, "evidence/p1-u7");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `live-${runTag}.json`), `${text}\n`);
  console.log(
    `\nreport: evidence/p1-u7/live-${runTag}.json; orchestrator log: ${logPath.slice(ROOT.length + 1)}`,
  );
}
process.exit(code);
