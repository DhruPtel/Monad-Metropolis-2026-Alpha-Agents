/**
 * F-U10 live check: `pnpm test:activation:live`. One activation sweep on the
 * Medium tier (Claude Sonnet 5.5) with real everything, on a stack of its
 * own so the playtest fork and the dev database are never touched (D-200,
 * L-181): a test fork on port 8551 with AgentNFT, the v2 AccountFactory, the
 * fund set (screens skipped) and Executor v3; a throwaway database; the
 * indexer in this process; the orchestrator as a child in its own
 * namespace on port 4251, scheduled research off, token loops off.
 *
 * The flow is the owner's: a mint, credits, a Balanced goal on the Medium
 * tier, a PersonalAccountV3 with 90 USDC, the grant registered as the wallet
 * would (impersonated on the fork), then `POST /v1/agents/:id/activation`.
 * The sweep is watched through `GET .../activation` every two seconds, each
 * step's change printed as the owner would see it, until it ends. Then the
 * checks: the checks before the start named the grant as the one thing to
 * come; the steps ran in order; each stage's charge stayed within its
 * ceiling and the sweep within the ceiling shown before it started; the
 * sweep ended with a plan that waits for the owner (the first plan always
 * does); the activity entries pass the number validator; approving the plan
 * (the control API's own function, with the Test v2 re-check through the
 * orchestrator) arms the agent and sets it RUNNING; and the runner's first
 * leg reaches the signer.
 *
 * Spend: at most the gate's 10 USD cap per task (D-369); this run reports
 * its own figure from the gateway after a settle, and pnpm spend:report is
 * the figure of record (L-199). Needs MONAD_RPC_URL, E2B_API_KEY,
 * LITELLM_MASTER_KEY, REVEAL_KEEPER_PRIVATE_KEY, ORCHESTRATOR_SECRET,
 * TAVILY_API_KEY, cloudflared and LiteLLM running. Writes a redacted report
 * to evidence/f-u10/.
 *
 * With `--open-universe` (F-U12): the attestation verifier set in the
 * TokenRegistry through its timelock on the fork's clock, an Aggressive goal
 * with the screened-lane opt-in, the opt-in recorded on the account from the
 * owner's address, GHO (a real class A token) looked up and screened so the
 * registrar puts it in the screened lane with its pool, and, after the sweep,
 * the universe the cycle considered (every token with its buyability and why
 * not, the themes' decisions, what was proposed and why not) from the
 * research read. The report goes to evidence/f-u12/.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Secret, loadConfig } from "@alpha-agents/config";
import { createTestDatabase } from "@alpha-agents/db/testing";
import {
  balancesOf,
  createTestPersonalAccountV3,
  fundTestPersonalAccountV3,
  localPaths,
  mintTestUsdc,
  refreshLocalFeeds,
  secretFragments,
  sendAs,
  setMonBalance,
  startTestFork,
} from "@alpha-agents/devenv";
import { DEFAULT_GOAL_INPUT, type GoalInput, addressEntry } from "@alpha-agents/domain";
import { Indexer, RpcLogSource } from "@alpha-agents/indexer";
import { translateGoal } from "@alpha-agents/policy";
import {
  ActivationStore,
  type ActivationView,
  GoalStore,
  PlanStore,
  ProposalStore,
  TradeStore,
} from "@alpha-agents/trading";
import { type Hex, createPublicClient, encodeFunctionData, http, parseAbi } from "viem";
import { approveProposal } from "../../../apps/control-api/src/proposals.ts";
import { LiteLLMAdmin } from "./gateway-admin.ts";
import { type NarrationFacts, validateNarration } from "./narrator.ts";
import { aliasPrefix } from "./provisioner.ts";
import { OrchestratorQueue } from "./queue.ts";
import { E2BProvider } from "./sandbox.ts";
import { Redactor, decryptSecret } from "./secrets.ts";
import { Store } from "./store.ts";
import { must } from "./testing.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
/** F-U12: the open universe: the verifier, an Aggressive goal with the opt-in, a class A token screened. */
const OPEN = process.argv.includes("--open-universe");
/** The unit the report is evidence for (`--unit=F-T2`); the report goes to evidence/<unit>/. */
const UNIT =
  process.argv.find((a) => a.startsWith("--unit="))?.slice("--unit=".length) ??
  (OPEN ? "F-U12" : "F-U10");
/** GHO on Monad: class A (no feed), a hookless v4 pool against USDC; the class A token of the sweep. */
const GHO = "0xfc421ad3c883bf9e7c4f42de845c4e4405799e73" as Hex;
const FORK_PORT = 8551;
const API_PORT = 4251;
const SCREEN_FORK_PORT = 8582;
const CHAIN = 143143;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

process.loadEnvFile(join(ROOT, ".env"));
process.env.LOCAL_FORK_PORT = String(FORK_PORT);
const config = loadConfig({
  name: "activation live check",
  requires: [
    "E2B_API_KEY",
    "LITELLM_MASTER_KEY",
    "REVEAL_KEEPER_PRIVATE_KEY",
    "ORCHESTRATOR_SECRET",
    "TAVILY_API_KEY",
  ],
});
const reveal = (n: keyof typeof config.values) => (config.values[n] as Secret).reveal();
const namespace = `live-act-${randomBytes(3).toString("hex")}`;
const runTag = new Date().toISOString().replaceAll(":", "-");
const checks: Record<string, boolean> = {};
const report: Record<string, unknown> = { unit: UNIT, namespace, runTag, checks };
const secrets: string[] = [];
for (const v of Object.values(config.values))
  if (v instanceof Secret)
    for (const f of secretFragments(v.reveal()))
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(f)) secrets.push(f);
const redactor = new Redactor();
redactor.add(...secrets);
const step = (s: string) => console.log(`\n== ${s}`);
/** D-369: the most model spend this run may make, as the gateway's /global/spend counts it. */
const SPEND_CAP_USD = 10;
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
  const spendAtStart = (await gateway.globalSpend()).spendUsd;
  const spentUsd = async () => (await gateway.globalSpend()).spendUsd - spendAtStart;
  const provider = new E2BProvider(reveal("E2B_API_KEY"));

  step(
    "stack: a test fork with AgentNFT, the v2 factory, the fund set and Executor v3; a database; the indexer",
  );
  const fork = await startTestFork({ port: FORK_PORT });
  cleanup.push(() => fork.stop());
  const { deployLocal } = await import("../../../scripts/lib/agent-nft.js");
  const { mintLocal } = (await import("../../../scripts/lib/agent-mint.js")) as {
    mintLocal: (nft: Hex) => Promise<{ agentId: bigint; minter: Hex }>;
  };
  const { deployAccountFactoryLocal } = await import("../../../scripts/lib/account-factory.js");
  const { deployFundLocal } = await import("../../../scripts/lib/fund.js");
  const { deployExecutorV3Local } = await import("../../../scripts/lib/executor-v3.js");
  const nft = (await deployLocal({ quiet: true })) as Hex;
  await deployAccountFactoryLocal({ quiet: true });
  const fund = (await deployFundLocal({ quiet: true, skipScreens: true })) as {
    tokenRegistry: Hex;
  };
  await deployExecutorV3Local({ quiet: true, tokenRegistry: fund.tokenRegistry });
  if (OPEN) {
    // F-U12: the verifier, set through the registry's own timelock, driven on the fork's clock.
    const { deployAttestationVerifierLocal } = await import("../../../scripts/lib/attestor.js");
    const v = (await deployAttestationVerifierLocal({
      url: fork.url,
      tokenRegistry: fund.tokenRegistry,
      quiet: true,
    })) as { verifier: Hex; attestor: Hex; set: boolean; warpedSeconds: number };
    report.verifier = { address: v.verifier, attestor: v.attestor, warpedSeconds: v.warpedSeconds };
    check(
      "the attestation verifier is set in the TokenRegistry through its timelock (SET_VERIFIER, 9 days on the fork's clock)",
      v.set,
      `${v.verifier} for attestor ${v.attestor}, ${v.warpedSeconds} s warped`,
    );
  }
  await refreshLocalFeeds(fork.url);
  const entry = addressEntry("local", "agent_nft");
  if (entry.status !== "verified") throw new Error("address book: agent_nft");
  const usdc = addressEntry("local", "usdc");
  if (usdc.status !== "verified") throw new Error("address book: usdc");
  const t = await createTestDatabase("act_live");
  cleanup.push(() => t.drop());
  const store = new Store(t.db);
  const indexer = new Indexer({
    db: t.db,
    source: new RpcLogSource({ url: fork.url }),
    target: {
      chainId: CHAIN,
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
  cleanup.push(async () => {
    for (const s of await provider.list({ app: "alpha-agents", namespace }))
      await provider.kill(s.id);
    await gateway.deleteAliases(await gateway.listAliases(aliasPrefix(namespace)));
  });

  const orch: ChildProcess = spawn(
    process.execPath,
    [
      "services/orchestrator/src/main.ts",
      `--namespace=${namespace}`,
      "--token-loops=off",
      `--screen-fork-port=${SCREEN_FORK_PORT}`,
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        LOCAL_FORK_PORT: String(FORK_PORT),
        DATABASE_URL: t.url,
        ORCHESTRATOR_PORT: String(API_PORT),
        SCHEDULED_RESEARCH: "off",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const take = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      logLines.push(line);
      logStream.write(`[orchestrator] ${line}\n`);
    }
  };
  orch.stdout?.on("data", take);
  orch.stderr?.on("data", take);
  cleanup.push(async () => {
    if (orch.exitCode !== null || orch.signalCode !== null) return;
    orch.kill("SIGTERM");
    await new Promise((r) => orch.once("exit", r));
  });
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
  await waitFor("the orchestrator", 60_000, async () => (await api("/health")).status === 200);

  step(
    "the owner: a mint, credits, a Balanced goal on the Medium tier, a trading account with 90 USDC",
  );
  const minted = await mintLocal(nft);
  const agentId = Number(minted.agentId);
  const client = createPublicClient({ transport: http(fork.url) });
  const owner = (await client.readContract({
    address: nft,
    abi: parseAbi(["function ownerOf(uint256 agentId) view returns (address)"]),
    functionName: "ownerOf",
    args: [BigInt(agentId)],
  })) as Hex;
  const ownerEpoch = await client.readContract({
    address: nft,
    abi: parseAbi(["function ownerEpoch(uint256 agentId) view returns (uint64)"]),
    functionName: "ownerEpoch",
    args: [BigInt(agentId)],
  });
  interface RuntimeView {
    agentId: string;
    status: string;
    keyAlias: string;
  }
  const runtime = await waitFor("provisioning", 120_000, async () => {
    const r = (await api("/v1/runtimes")).body.runtimes as RuntimeView[];
    return r.find((x) => x.agentId === String(agentId) && x.status === "ready");
  });
  report.agent = { agentId, runtime };
  const stored = await store.runtime({ chainId: CHAIN, agentId });
  if (stored?.keyCiphertext)
    secrets.push(decryptSecret(stored.keyCiphertext, reveal("ORCHESTRATOR_SECRET")));
  interface CreditsRow {
    agentId: string;
    fundingAddress: string | null;
    spendableUsdcE6: string;
    restricted: boolean;
  }
  const creditsOf = async () =>
    ((await api("/v1/credits")).body.agents as CreditsRow[]).find(
      (a) => a.agentId === String(agentId),
    );
  const funding = must(
    await waitFor("a funding address", 30_000, async () => (await creditsOf())?.fundingAddress),
  ) as Hex;
  // The owner funds credits as owners do: USDC from their wallet to the funding address.
  const CREDITS_E6 = 8_000_000n;
  await mintTestUsdc(owner, CREDITS_E6, fork.url);
  if ((await balancesOf(owner, fork.url)).monWei < 10n ** 18n)
    await setMonBalance(owner, 10n ** 19n, fork.url);
  await sendAs(
    fork.url,
    owner,
    usdc.address as Hex,
    encodeFunctionData({
      abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
      functionName: "transfer",
      args: [funding, CREDITS_E6],
    }),
  );
  await waitFor("the credits", 90_000, async () =>
    BigInt((await creditsOf())?.spendableUsdcE6 ?? "0") >= CREDITS_E6 ? true : null,
  );
  const translated = translateGoal({
    ...DEFAULT_GOAL_INPUT,
    modelTier: "MEDIUM",
    research: { intensity: "STANDARD", dailyBudgetUsdcE6: "5000000" },
    // F-U12: an Aggressive goal with the screened-lane opt-in, as the owner tests it.
    ...(OPEN ? { aggressiveness: "AGGRESSIVE", screenedOptIn: true } : {}),
  } as GoalInput);
  if (!translated.ok) throw new Error("the live goal does not translate");
  const goals = new GoalStore(t.db);
  await goals.save({
    chainId: CHAIN,
    agentId,
    ownerEpoch: BigInt(ownerEpoch),
    savedBy: owner,
    config: translated.config,
  });
  const account = await createTestPersonalAccountV3(fork.url, agentId, owner);
  await fundTestPersonalAccountV3(fork.url, agentId, owner, [
    { token: usdc.address, usdcE6: 90_000_000n },
  ]);
  report.setup = { owner, funding, account, creditsUsdcE6: CREDITS_E6.toString() };
  if (OPEN) {
    // F-U12: the opt-in recorded on the account from the owner's address, as the Goal page sends it.
    const ACCOUNT_ABI = parseAbi([
      "function setScreenedOptIn(bool optIn)",
      "function screenedOptIn() view returns (bool)",
    ]);
    await sendAs(
      fork.url,
      owner,
      account,
      encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "setScreenedOptIn", args: [true] }),
    );
    const optedIn = await client.readContract({
      address: account as Hex,
      abi: ACCOUNT_ABI,
      functionName: "screenedOptIn",
    });
    report.optIn = optedIn;
    check("the owner's screened-lane opt-in is recorded on the account on chain", optedIn === true);
  }

  step("the core tokens' safety screens, as the dev stack's hourly loop keeps them (D-339)");
  interface PlanView {
    portfolio: { tokens: { token: string; symbol: string; lane: string }[] } | null;
  }
  const planView = (await api(`/v1/agents/${agentId}/plan`)).body as unknown as PlanView;
  const screened: { symbol: string; verdict: string; ms: number }[] = [];
  for (const tk of planView.portfolio?.tokens ?? []) {
    if (tk.lane !== "CORE" || tk.token.toLowerCase() === usdc.address.toLowerCase()) continue;
    const at = Date.now();
    const r = await api(`/v1/tokens/${tk.token}/screen`, { method: "POST" });
    const verdict = (r.body.screen as { verdict?: string } | undefined)?.verdict ?? "error";
    screened.push({ symbol: tk.symbol, verdict, ms: Date.now() - at });
    console.log(
      `   ${tk.symbol}: ${verdict} in ${Math.round((Date.now() - at) / 1000)} s${r.status !== 200 ? ` (${r.status} ${String(r.body.message ?? "")})` : ""}`,
    );
  }
  report.screens = screened;
  check(
    "the core tokens were screened before the sweep, and at least one passed",
    screened.length > 0 && screened.some((x) => x.verdict === "passed"),
    screened.map((x) => `${x.symbol} ${x.verdict}`).join(", ") || "no core token",
  );
  if (OPEN) {
    step(
      "class A tokens looked up and screened: a passing screen registers each in the screened lane (D-342)",
    );
    // F-T2: three more real class A tokens beside GHO, so the open universe has several buyable ones.
    const classA: { symbol: string; address: Hex; lookup: number; verdict: string }[] = [];
    for (const [symbol, address] of [
      ["GHO", GHO],
      ["CHAOS", "0xdcd8114f42fd40db1914de241c75adc9e3c1722e" as Hex],
      ["SAKURA", "0x2f68fdad1130e05dc16421553512ebf9e63a50da" as Hex],
      ["LV", "0x1001ff13bf368aa4fa85f21043648079f00e1001" as Hex],
    ] as const) {
      const lookedUp = await api("/v1/tokens/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const at = Date.now();
      const r = await api(`/v1/tokens/${address}/screen`, { method: "POST" });
      const v = (r.body.screen as { verdict?: string } | undefined)?.verdict ?? "error";
      classA.push({ symbol, address, lookup: lookedUp.status, verdict: v });
      console.log(
        `   ${symbol}: lookup ${lookedUp.status}, screen ${v} in ${Math.round((Date.now() - at) / 1000)} s${r.status !== 200 ? ` (${r.status} ${String(r.body.message ?? "")})` : ""}`,
      );
    }
    report.classATokens = classA;
    const looked = { status: classA[0]?.lookup ?? 0 };
    const verdict = classA[0]?.verdict ?? "error";
    const view = (await api(`/v1/tokens/${GHO}`)).body as {
      token?: { registryLane?: string | null; registryStatus?: string | null; priceClass?: string };
    };
    report.classA = {
      token: GHO,
      lookup: looked.status,
      verdict,
      lane: view.token?.registryLane ?? null,
      status: view.token?.registryStatus ?? null,
    };
    check(
      "GHO passed the safety screen and the registrar put it in the screened lane at once, listed",
      verdict === "passed" &&
        view.token?.registryLane === "screened" &&
        view.token?.registryStatus === "listed",
      `${verdict}, lane ${String(view.token?.registryLane)}, status ${String(view.token?.registryStatus)}`,
    );
  }

  step("the checks before the sweep, then the grant from the owner's wallet");
  interface Check {
    code: string;
    ok: boolean;
    message: string;
    blocking: boolean;
  }
  interface Read {
    activation: ActivationView | null;
    checks: Check[];
    ceilingUsdcE6: string;
    tier: { choice: string; label: string };
  }
  const before = (await api(`/v1/agents/${agentId}/activation`)).body as unknown as Read;
  report.checksBefore = before.checks;
  check(
    "before the grant, every check passes but the grant, named as the step to come, on the Medium tier with a 3.80 USDC ceiling",
    before.activation === null &&
      before.tier.choice === "MEDIUM" &&
      before.ceilingUsdcE6 === "3800000" &&
      before.checks
        .filter((c) => !c.ok)
        .map((c) => c.code)
        .join(",") === "GRANT",
    before.checks.map((c) => `${c.code}:${c.ok ? "ok" : "no"}`).join(" "),
  );
  const refusedEarly = await api(`/v1/agents/${agentId}/activation`, { method: "POST" });
  check(
    "a start before the grant is refused and names the grant",
    refusedEarly.status === 409 && refusedEarly.body.error === "activation_grant",
    `${refusedEarly.status} ${String(refusedEarly.body.error)}`,
  );
  const armed = await api(`/v1/agents/${agentId}/arm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  check(
    "the grant is on chain and recorded as waiting for its first approval (D-291)",
    armed.status === 201 &&
      (armed.body.arming as { state?: string } | undefined)?.state === "awaiting_first_trade",
    `${armed.status} ${JSON.stringify(armed.body).slice(0, 160)}`,
  );

  await spendGuard(spentUsd, "the activation sweep");
  step("turn on automatic trading: the sweep, watched every two seconds as the owner sees it");
  const sweepStartedAt = Date.now();
  const started = await api(`/v1/agents/${agentId}/activation`, { method: "POST" });
  check(
    "the start is accepted: the sweep is queued and its first step is done at once",
    started.status === 202 &&
      (started.body.activation as ActivationView | undefined)?.status === "running" &&
      (started.body.activation as ActivationView | undefined)?.steps[0]?.state === "done",
    `${started.status} ${JSON.stringify(started.body).slice(0, 200)}`,
  );
  const transitions: { at: number; key: string; state: string; result: string | null }[] = [];
  const WORK = ["scan", "market", "dives", "challenge", "test", "plan"];
  let maxRunningAtOnce = 0;
  let last: Record<string, string> = {};
  const final = await waitFor("the sweep to end", 45 * 60_000, async () => {
    const r = (await api(`/v1/agents/${agentId}/activation`)).body as unknown as Read;
    const a = r.activation;
    if (!a) return null;
    const now: Record<string, string> = {};
    maxRunningAtOnce = Math.max(
      maxRunningAtOnce,
      a.steps.filter((s) => WORK.includes(s.key) && s.state === "running").length,
    );
    for (const s of a.steps) {
      now[s.key] = s.state;
      if (last[s.key] !== s.state) {
        const at = Math.round((Date.now() - sweepStartedAt) / 1000);
        transitions.push({ at, key: s.key, state: s.state, result: s.result });
        console.log(
          `   [${String(at).padStart(4)} s] ${s.label}: ${s.state}${s.result ? ` · ${s.result}` : ""}${s.reason ? ` · ${s.reason}` : ""} · ${(Number(s.chargedUsdcE6) / 1e6).toFixed(2)} of ${(Number(s.ceilingUsdcE6) / 1e6).toFixed(2)} USDC`,
        );
      }
    }
    last = now;
    await sleep(1_000);
    return a.status === "running" ? null : a;
  });
  const sweepMs = Date.now() - sweepStartedAt;
  report.sweep = { view: final, transitions, ms: sweepMs };
  console.log(
    `   ended ${final.status} after ${Math.round(sweepMs / 1000)} s: ${final.outcome.title}`,
  );
  // Each work step first left "pending" no earlier than the one before it (the Dives run twice,
  // once per theme; the deterministic Test can go straight to done between two polls).
  const firstLeft = WORK.map((k) => transitions.find((t) => t.key === k && t.state !== "pending"));
  const began = firstLeft.map((t) => t?.at ?? null);
  const inOrder = began.every(
    (at, i) => at === null || began.slice(0, i).every((b) => b !== null && b <= at),
  );
  check(
    "the steps ran in order, each after the one before it, and never two at once",
    inOrder && began.filter((b) => b !== null).length >= 5 && maxRunningAtOnce <= 1,
    `first seen: ${WORK.map((k, i) => `${k} ${began[i] === null ? "never" : `${began[i]} s`}`).join(", ")}; at most ${maxRunningAtOnce} running at once`,
  );
  const stages = final.steps.filter((s) => BigInt(s.ceilingUsdcE6) > 0n);
  const charged = BigInt(final.chargedUsdcE6);
  check(
    "no step was charged above its ceiling, and the sweep stayed within the ceiling shown before it started",
    stages.every((s) => BigInt(s.chargedUsdcE6) <= BigInt(s.ceilingUsdcE6)) &&
      charged <= BigInt(final.ceilingUsdcE6) &&
      final.ceilingUsdcE6 === before.ceilingUsdcE6,
    `${stages.map((s) => `${s.key} ${(Number(s.chargedUsdcE6) / 1e6).toFixed(2)}/${(Number(s.ceilingUsdcE6) / 1e6).toFixed(2)}`).join(", ")}; total ${(Number(charged) / 1e6).toFixed(2)} of ${(Number(final.ceilingUsdcE6) / 1e6).toFixed(2)} USDC`,
  );
  const activations = new ActivationStore(t.db);
  const record = must(await activations.latest(CHAIN, agentId));
  check(
    "the deterministic steps recorded their facts: the goal and account, and the pools and prices",
    record.checks.tradingValueUsdcE6 === "90000000" && record.market?.ok === true,
    `${JSON.stringify(record.checks)} ${JSON.stringify(record.market)}`,
  );
  const proposals = new ProposalStore(t.db);
  const pending = await proposals.pending(CHAIN, agentId);
  check(
    "the sweep ended with a plan that waits for the owner: the first plan always needs approval",
    final.status === "plan_ready" &&
      pending !== null &&
      pending.needsApproval &&
      pending.evaluation?.passed === true &&
      pending.evaluation.approval !== null,
    `${final.status}; ${pending ? `${pending.status} ${pending.positions.length} positions, approval ${pending.evaluation?.approval}` : "no proposal"}; ${final.outcome.title}: ${final.outcome.message}`,
  );
  const entries = await t.db
    .selectFrom("platform.activity_entries")
    .select(["task_id", "kind", "text", "facts", "rendered_by"])
    .where("agent_id", "=", agentId)
    .orderBy("created_at")
    .execute();
  const activationEntries = entries.filter((e) => e.kind === "activation");
  report.entries = entries.map((e) => `${e.kind} (${e.rendered_by}): ${e.text}`);
  check(
    "activity entries for the sweep's start, each deterministic step, every stage and the result, each passing the number validator",
    activationEntries.some((e) => e.task_id.endsWith(":started")) &&
      activationEntries.some((e) => e.task_id.includes(":step:reading-your-goal")) &&
      activationEntries.some((e) => e.task_id.includes(":step:reading-pools")) &&
      activationEntries.some((e) => e.task_id.endsWith(":finished")) &&
      entries.filter((e) => e.kind === "stage").length >= 4 &&
      entries.every((e) => validateNarration(e.text, e.facts as unknown as NarrationFacts).ok),
    `${activationEntries.length} activation entries, ${entries.filter((e) => e.kind === "stage").length} stage entries, ${entries.length} in all`,
  );

  if (pending) {
    step("the owner approves the plan: the Test v2 re-check, the arming, the runner's first leg");
    const trades = new TradeStore(t.db);
    const approval = await approveProposal(
      {
        db: t.db,
        proposals,
        plans: new PlanStore(t.db),
        goals,
        trades,
        activations,
        now: () => new Date(),
        recheck: async (id, params) => {
          const res = await api(`/v1/agents/${id}/plan/check`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              template: "target_portfolio@1",
              positions: params.positions,
              cashTargetBps: params.cashTargetBps,
              minTradeUsdcE6: params.minTradeUsdcE6.toString(),
              volatilityBrakeBps: params.volatilityBrakeBps,
              costHurdleBps: params.costHurdleBps,
              maxLegBps: params.maxLegBps,
            }),
          });
          return res.status === 200
            ? ((res.body.findings as { code: string; field: string; message: string }[]) ?? null)
            : null;
        },
      },
      CHAIN,
      agentId,
      pending.proposalId,
      { wallet: owner, epoch: BigInt(ownerEpoch) },
    );
    report.approval = approval.ok
      ? { status: approval.proposal.status, armed: approval.armed, plan: approval.plan.paramId }
      : approval;
    const arming = await trades.openArming(CHAIN, agentId);
    const state = await t.db
      .selectFrom("platform.agent_states")
      .select("state")
      .where("chain_id", "=", CHAIN)
      .where("agent_id", "=", agentId)
      .executeTakeFirst();
    const after = (await api(`/v1/agents/${agentId}/activation`)).body as unknown as Read;
    check(
      "approving the plan passes the re-check, arms the agent, sets it RUNNING, and the sweep reads as active",
      approval.ok &&
        approval.armed &&
        arming?.status === "armed" &&
        state?.state === "RUNNING" &&
        after.activation?.status === "active",
      approval.ok
        ? `armed ${String(arming?.status)}, state ${String(state?.state)}, sweep ${String(after.activation?.status)}`
        : `${approval.code}: ${approval.message}${"findings" in approval ? ` ${approval.findings.map((f) => f.code).join(",")}` : ""}`,
    );
    if (approval.ok && pending.positions.length === 0) {
      // A plan of cash only gives the runner nothing to buy: it records its hold instead.
      const hold = await waitFor("the runner's hold", 3 * 60_000, async () =>
        t.db
          .selectFrom("platform.runner_decisions")
          .select(["outcome", "code"])
          .where("chain_id", "=", CHAIN)
          .where("agent_id", "=", agentId)
          .orderBy("last_at", "desc")
          .executeTakeFirst(),
      ).catch(() => null);
      report.firstLeg = hold;
      check(
        "with a cash-only plan the runner holds, recording its reason, and sends nothing",
        hold?.outcome === "hold" && (await trades.intents(CHAIN, agentId, 10)).length === 0,
        hold ? `${hold.outcome} ${hold.code}` : "no decision within three minutes",
      );
    } else if (approval.ok) {
      // F-T1: the sweep took minutes on a fork whose feeds do not update on their own; re-date them
      // before the runner's leg, as the dev stack's refresher would, so the Executor's price check holds.
      await refreshLocalFeeds(fork.url);
      const leg = await waitFor("the runner's first leg", 6 * 60_000, async () => {
        const all = await trades.intents(CHAIN, agentId, 10);
        return all.find(
          (i) =>
            i.source === "template" &&
            ["approved", "submitted", "confirmed", "reconciled"].includes(i.status),
        );
      }).catch(() => null);
      const settled =
        leg &&
        (await waitFor("the leg to settle", 4 * 60_000, async () => {
          const i = await trades.intent(CHAIN, agentId, leg.intentId);
          return i && ["reconciled", "rejected", "failed", "expired"].includes(i.status) ? i : null;
        }).catch(() => null));
      report.firstLeg = leg
        ? {
            intentId: leg.intentId,
            sell: leg.sell,
            buy: leg.buy,
            amountIn: leg.amountIn.toString(),
            status: settled?.status ?? leg.status,
            txHash: settled?.txHash ?? leg.txHash,
          }
        : null;
      check(
        "the runner's first leg went through on its own and settled on the fork's real pools",
        settled?.status === "reconciled",
        leg
          ? `${leg.sell} to ${leg.buy}: ${settled?.status ?? leg.status}${settled?.failure ? ` (${settled.failure})` : ""}`
          : "no leg within six minutes",
      );
    }
  }

  if (OPEN) {
    step(
      "the universe the sweep considered: every token, its buyability and why not, what was proposed",
    );
    interface UniverseRow {
      symbol: string;
      priceClass: string;
      lane: string | null;
      buyable: boolean;
      whyNot: string | null;
      held: boolean;
      themeCode: string | null;
      themeReason: string | null;
      researched: boolean;
      proposed: boolean;
      droppedReason: string | null;
    }
    const research = (await api(`/v1/agents/${agentId}/research`)).body as {
      universe?: { cycleId: string; kind: string; rows: UniverseRow[] } | null;
    };
    const rows = research.universe?.rows ?? [];
    for (const u of rows)
      console.log(
        `   ${u.symbol.padEnd(6)} ${u.priceClass} ${(u.lane ?? "none").padEnd(8)} ${u.buyable ? "buyable" : `not buyable: ${u.whyNot ?? ""}`}${u.themeCode ? ` · ${u.researched ? "Dive" : "no Dive"} ${u.themeCode}: ${u.themeReason ?? ""}` : ""}${u.proposed ? " · PROPOSED" : u.droppedReason ? ` · not proposed: ${u.droppedReason}` : ""}`,
      );
    report.universe = research.universe ?? null;
    // The proposal's evaluation, as the plan view records the decisions, so a refusal names its rule.
    const planAfter = (await api(`/v1/agents/${agentId}/plan`)).body as {
      decisions?: unknown[];
    };
    report.decisions = planAfter.decisions ?? [];
    for (const d of planAfter.decisions ?? [])
      console.log(`   decision: ${redactor.redact(JSON.stringify(d)).slice(0, 400)}`);
    // The terminal's check lines: the evaluator's findings on the proposal, each with its rule.
    const terminal = (await api(`/v1/agents/${agentId}/terminal`)).body as {
      events?: { kind: string; text: string }[];
    };
    const checksSeen = (terminal.events ?? []).filter((e) => e.kind === "check").map((e) => e.text);
    report.proposalChecks = checksSeen;
    for (const line of checksSeen) console.log(`   ${redactor.redact(line).slice(0, 300)}`);
    const gho = rows.find((u) => u.symbol === "GHO");
    check(
      "the sweep recorded the universe it considered, with a reason for every token this account cannot buy",
      rows.length > 0 && rows.every((u) => u.buyable || u.whyNot !== null),
      `${rows.length} tokens, ${rows.filter((u) => u.buyable).length} buyable`,
    );
    check(
      "GHO, in the screened lane, is buyable for this opted-in owner in the universe the agent saw",
      gho?.buyable === true,
      gho
        ? `${gho.lane} ${gho.buyable ? "buyable" : (gho.whyNot ?? "")}`
        : "GHO not in the universe",
    );
    check(
      "every token the sweep dived or the account holds that the plan leaves out has its reason",
      rows
        .filter((u) => (u.researched || u.held) && !u.proposed)
        .every((u) => u.droppedReason !== null),
      rows
        .filter((u) => u.researched || u.held || u.proposed)
        .map((u) => `${u.symbol}:${u.proposed ? "proposed" : (u.droppedReason ?? "no reason")}`)
        .join("; ") || "nothing dived or held",
    );
  }

  const leaked = secrets.filter((s) => s.length >= 8 && logLines.some((l) => l.includes(s)));
  check(
    "no key or token in any log line or API reply",
    leaked.length === 0,
    `${logLines.length} lines`,
  );
  // LiteLLM writes its spend logs in batches (L-199): the figure settles after a wait.
  await sleep(90_000);
  report.spendUsd = Number((await spentUsd()).toFixed(4));
  console.log(
    `\nmodel spend of this run: ${String(report.spendUsd)} USD (cap ${SPEND_CAP_USD}), as the gateway's spend logs show it after a settle; pnpm spend:report --days=1 is the figure of record`,
  );
  return Object.values(checks).every(Boolean) ? 0 : 1;
}

class SpendCapReached extends Error {}
async function spendGuard(spentUsd: () => Promise<number>, next: string) {
  const spent = await spentUsd();
  report.spendUsd = Number(spent.toFixed(4));
  console.log(`   model spend so far: ${spent.toFixed(3)} USD of the ${SPEND_CAP_USD} USD cap`);
  if (spent >= SPEND_CAP_USD)
    throw new SpendCapReached(
      `the run reached its model spend cap (${spent.toFixed(3)} USD of ${SPEND_CAP_USD}) before "${next}"`,
    );
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
  // A key named "token" beside an address reads as a credential to the secrets scan (L-205).
  const addressKeys = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(addressKeys)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).map(([k, x]) => [
              k.replace(/token/i, (m) => (m === "token" ? "address" : "Address")),
              addressKeys(x),
            ]),
          )
        : v;
  const text = redactor.redact(
    JSON.stringify(addressKeys(report), (_k, v) => (typeof v === "bigint" ? String(v) : v), 2),
  );
  const evidence = `evidence/${UNIT.toLowerCase()}`;
  const dir = join(ROOT, evidence);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `live-${runTag}.json`), `${text}\n`);
  console.log(
    `\nreport: ${evidence}/live-${runTag}.json; orchestrator log: ${logPath.slice(ROOT.length + 1)}`,
  );
}
process.exit(code);
