// @ts-check
// The stack against Monad testnet (P2-EC part 1): the indexer, the control
// API, the orchestrator (keeper with real Pyth Entropy, the signer with the
// testnet funding seed, the trade flow, feeds re-dated on demand) and the web
// app, all with APP_ENV=testnet, a database of their own and Redis database 1.
// The local stack's ports are reused (Privy allows only localhost:3000), so it
// runs instead of dev:all, never beside it. Anvil, the playtest fork and the
// local database are never touched; the console stays local-only.
//
//   pnpm testnet:up        start it (refuses while dev:all runs)
//   pnpm testnet:down      stop it
//   pnpm testnet:to-local  stop it and start dev:all again
//   pnpm testnet:propose 3 have agent 3 propose a small trade (the chain check,
//                          an operator action until Phase 3's runner proposes)
//   pnpm testnet:propose 3 --over-limit  record a proposal over the trade size
//                          limit, which the trade flow refuses with its reason
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createDb, sql } from "@alpha-agents/db";
import { privateKeyToAccount } from "viem/accounts";
import { LOCAL_PLAYTEST_WALLETS } from "./lib/account-factory.js";
import { loadRootEnv } from "./lib/config.js";
import { MAX_RESTARTS, keepLog, restartDelayMs } from "./lib/stack-restart.js";
import { OWNER_PLAYTEST_WALLETS } from "./lib/testnet.js";
import {
  MIN_AVAILABLE_BYTES,
  alive,
  availableMemory,
  heavyRunningNow,
  labelLines,
  readState as readLocalState,
  stopGroup,
} from "./lib/dev-all.js";
import { DEV_DIR, ENV_PATH, ROOT } from "./lib/paths.js";

const STATE_PATH = join(DEV_DIR, "testnet-stack.json");
const LOG_PATH = join(DEV_DIR, "testnet-stack.log");
const LOCAL_DATABASE = "postgres://alpha:alpha_local_dev_only@127.0.0.1:5432/alpha_agents";
export const TESTNET_DATABASE = "alpha_agents_testnet";

/**
 * The testnet stack's own values. Its two secrets are TESTNET_ORCHESTRATOR_SECRET and
 * TESTNET_API_SESSION_SECRET in .env, which config maps on testnet: they must stay the
 * same across restarts, because the orchestrator encrypts each agent's stored gateway key
 * with its secret (P2-EC: a fresh secret per start left every stored key unreadable).
 */
/** HOST-U1: the owner's playtest wallets and the test wallet, for the demo research allowlist. */
function demoAllowlistDefault() {
  const wallets = [...OWNER_PLAYTEST_WALLETS];
  const testKey = process.env.TESTNET_TEST_WALLET_PRIVATE_KEY?.trim();
  if (testKey && /^0x[0-9a-fA-F]{64}$/.test(testKey))
    wallets.push(privateKeyToAccount(/** @type {`0x${string}`} */ (testKey)).address);
  return wallets.join(",");
}

function testnetEnv() {
  return {
    APP_ENV: "testnet",
    DATABASE_URL: LOCAL_DATABASE.replace(/alpha_agents$/, TESTNET_DATABASE),
    REDIS_URL: "redis://127.0.0.1:6380/1",
    LITELLM_BASE_URL: "http://127.0.0.1:4000",
    CONTROL_API_PORT: "4100",
    CONTROL_API_URL: "http://127.0.0.1:4100",
    ORCHESTRATOR_PORT: "4200",
    ORCHESTRATOR_URL: "http://127.0.0.1:4200",
    APP_PUBLIC_URL: "http://localhost:3000",
    // HOST-U1 (D-383): the testnet demo mints for any wallet within the per-wallet limit, and
    // research runs for the owner's playtest wallets (and whoever .env adds) under 5 USD a day.
    MINT_OPEN: process.env.MINT_OPEN ?? "on",
    DEMO_RESEARCH_ALLOWLIST: process.env.DEMO_RESEARCH_ALLOWLIST ?? demoAllowlistDefault(),
    DEMO_DAILY_MODEL_BUDGET_USD: process.env.DEMO_DAILY_MODEL_BUDGET_USD ?? "5",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
}

const SERVICES = [
  { name: "indexer", args: ["services/indexer/src/main.ts"], ready: null },
  { name: "api", args: ["apps/control-api/src/main.ts"], ready: "http://127.0.0.1:4100/health" },
  {
    name: "orchestrator",
    args: ["services/orchestrator/src/main.ts"],
    ready: "http://127.0.0.1:4200/health",
    // 2026-10-13: an orchestrator that exits on its own is started again (see restartDelayMs).
    restart: true,
  },
  { name: "web", args: ["scripts/web.js", "dev"], ready: "http://localhost:3000/" },
  // P-SWEEP (D-384): Base's tokens in the research table, for research only, every hour.
  {
    name: "research-base",
    args: ["services/orchestrator/src/research-discovery.ts"],
    ready: null,
    env: { MARKET_CHAIN: "base" },
  },
];

/** @returns {{ supervisor: number, services: { name: string, pid: number }[] } | null} */
function readState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function stop() {
  const state = readState();
  if (!state) return [];
  // 2026-10-13: what was running before anything is signalled. The supervisor stops services
  // itself on SIGTERM, so a list taken afterwards left out the ones it stopped first, which
  // read as services that had stopped on their own.
  const running = state.services.filter((s) => alive(s.pid)).map((s) => s.name);
  if (state.supervisor !== process.pid && alive(state.supervisor)) {
    try {
      process.kill(state.supervisor, "SIGTERM");
    } catch {
      // gone
    }
    for (let i = 0; i < 100 && alive(state.supervisor); i += 1)
      await new Promise((r) => setTimeout(r, 200));
  }
  for (const s of [...state.services].reverse()) if (alive(s.pid)) await stopGroup(s.pid);
  const stopped = [...state.services]
    .reverse()
    .map((s) => s.name)
    .filter((n) => running.includes(n));
  rmSync(STATE_PATH, { force: true });
  return stopped;
}

/** @param {string} message */
const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};

/** @param {number} port */
const portBusy = (port) =>
  (spawnSync("ss", ["-ltn", `sport = :${port}`], { encoding: "utf8" }).stdout ?? "")
    .split("\n")
    .slice(1)
    .some((l) => l.trim() !== "");

async function ensureDatabase() {
  const admin = createDb(LOCAL_DATABASE, { max: 1 });
  try {
    const found = await sql`select 1 from pg_database where datname = ${TESTNET_DATABASE}`.execute(
      admin,
    );
    if (found.rows.length === 0) {
      await sql.raw(`create database ${TESTNET_DATABASE}`).execute(admin);
      return true;
    }
    return false;
  } finally {
    await admin.destroy();
  }
}

/** Adds the testnet secrets to .env once, with random values; prints only their names. */
function ensureSecrets() {
  const text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const missing = ["TESTNET_ORCHESTRATOR_SECRET", "TESTNET_API_SESSION_SECRET"].filter(
    (name) => !new RegExp(`^${name}=\\S{32,}`, "m").test(text),
  );
  if (missing.length === 0) return;
  const lines = missing.map((name) => `${name}=${randomBytes(32).toString("hex")}`);
  appendFileSync(
    ENV_PATH,
    `${text.endsWith("\n") || text === "" ? "" : "\n"}# P2-EC: the testnet stack's own secrets, made once by pnpm testnet:up\n${lines.join("\n")}\n`,
  );
  for (const name of missing)
    process.env[name] = lines.find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1);
  console.log(`testnet: added ${missing.join(" and ")} to .env (random, testnet only)`);
}

/**
 * The playtest steps a reset database needs (CL-U1): the mint allowlist and the
 * operator gas, through the existing scripts, with the stack's own environment.
 * @param {Record<string, string | undefined>} env @param {(line: string) => void} out
 */
function readyForPlaytest(env, out) {
  const wallets = [...LOCAL_PLAYTEST_WALLETS];
  const testKey = env.TESTNET_TEST_WALLET_PRIVATE_KEY?.trim();
  if (testKey && /^0x[0-9a-fA-F]{64}$/.test(testKey)) {
    const address = privateKeyToAccount(/** @type {`0x${string}`} */ (testKey)).address;
    if (!wallets.includes(address)) wallets.unshift(address);
  }
  for (const wallet of wallets) {
    const r = spawnSync(
      process.execPath,
      ["scripts/allowlist.js", "add", wallet, "playtest wallet (testnet:up)"],
      { cwd: ROOT, env, encoding: "utf8" },
    );
    const first = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n")[0] ?? "";
    out(
      r.status === 0
        ? `testnet: ${first}`
        : `testnet: the allowlist step failed for ${wallet}: ${first || `exit ${r.status}`}`,
    );
  }
  const gas = spawnSync(process.execPath, ["scripts/testnet-gas.js"], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
  const lines = `${gas.stdout ?? ""}${gas.stderr ?? ""}`.trim().split("\n").filter(Boolean);
  if (gas.status === 0) for (const line of lines) out(`testnet: gas: ${line}`);
  else out(`testnet: the gas step failed: ${lines.at(-1) ?? `exit ${gas.status}`}`);
}

async function up() {
  mkdirSync(DEV_DIR, { recursive: true });
  ensureSecrets();
  const previous = readState();
  if (previous && alive(previous.supervisor))
    fail(
      `the testnet stack is already running (PID ${previous.supervisor}); pnpm testnet:down stops it`,
    );
  if (previous) await stop();
  const local = readLocalState();
  if (local && alive(local.supervisor))
    fail(
      `dev:all is running (PID ${local.supervisor}) on the same ports; stop it first with Ctrl-C in its terminal (not pnpm dev:down, which also stops the playtest fork)`,
    );
  const busy = [3000, 4100, 4200].filter(portBusy);
  if (busy.length > 0) fail(`port ${busy.join(", ")} is in use; stop what listens there first`);
  const heavy = heavyRunningNow();
  if (heavy.length > 0)
    fail(`${heavy.join(" and ")} is running; wait for it (the Heavy work rule)`);
  const free = availableMemory();
  if (free !== null && free < MIN_AVAILABLE_BYTES)
    fail(`only ${(free / 1024 ** 3).toFixed(1)} GiB of memory is available, under 2 GiB`);
  for (const port of [5432, 6380, 4000])
    if (!portBusy(port))
      fail(
        `nothing listens on ${port} (Postgres 5432, Redis 6380, LiteLLM 4000); start them with pnpm dev:up and pnpm dev:litellm`,
      );

  // 2026-10-13: the last run's log is kept under its time, not wiped.
  keepLog(LOG_PATH);
  writeFileSync(LOG_PATH, "");
  /** @param {string} line */
  const out = (line) => {
    console.log(line);
    appendFileSync(LOG_PATH, `${line}\n`);
  };
  out(
    (await ensureDatabase())
      ? `testnet: created the database ${TESTNET_DATABASE}`
      : `testnet: database ${TESTNET_DATABASE}`,
  );

  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, ...testnetEnv() };
  // Local-only settings never reach testnet (config refuses a steered reveal off local).
  delete env.LOCAL_FIRST_REVEAL_SPECIES;
  delete env.LOCAL_FORK_PORT;
  delete env.ALPHA_E2E_MOCK_WALLET;
  /** @type {{ supervisor: number, services: { name: string, pid: number }[] }} */
  const state = { supervisor: process.pid, services: [] };
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  let stopping = false;
  const shutdown = async (/** @type {string} */ why) => {
    if (stopping) return;
    stopping = true;
    out(`testnet: ${why}; stopping every service`);
    const stopped = await stop();
    out(`testnet: stopped ${stopped.length ? stopped.join(", ") : "nothing"}`);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("interrupted"));
  process.on("SIGTERM", () => void shutdown("asked to stop"));

  /** Starts one service, records its PID, labels its output, and restarts it if it should. */
  const launch = (
    /** @type {(typeof SERVICES)[number]} */ service,
    /** @type {number} */ restarts,
  ) => {
    const child = spawn(process.execPath, service.args, {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, ...("env" in service ? service.env : {}) },
    });
    if (!child.pid) fail(`${service.name} did not start`);
    const entry = state.services.find((x) => x.name === service.name);
    if (entry) entry.pid = /** @type {number} */ (child.pid);
    else state.services.push({ name: service.name, pid: /** @type {number} */ (child.pid) });
    writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
    for (const stream of [child.stdout, child.stderr]) {
      let rest = "";
      stream?.on("data", (/** @type {Buffer} */ chunk) => {
        const r = labelLines(service.name, rest, chunk.toString("utf8"));
        rest = r.rest;
        for (const line of r.lines) out(line);
      });
    }
    const startedAt = Date.now();
    child.on("exit", (code, signal) => {
      if (stopping) return;
      out(`testnet: ${service.name} exited (${signal ?? `code ${code}`}); the rest keep running`);
      if (!("restart" in service && service.restart)) return;
      // A run that lasted a while starts the count again; a crash loop backs off and gives up.
      const n = Date.now() - startedAt > 10 * 60_000 ? 0 : restarts + 1;
      if (n > MAX_RESTARTS) {
        out(`testnet: ${service.name} exited ${n} times in a row; not restarting it again`);
        return;
      }
      const delay = restartDelayMs(n);
      out(`testnet: restarting ${service.name} in ${Math.round(delay / 1000)} s`);
      setTimeout(() => {
        if (!stopping) launch(service, n);
      }, delay);
    });
    return child;
  };

  for (const service of SERVICES) {
    if (stopping) break;
    launch(service, 0);
    if (service.ready) {
      const deadline = Date.now() + (service.name === "web" ? 240_000 : 90_000);
      let ok = false;
      while (!ok && Date.now() < deadline && !stopping) {
        try {
          ok = (await fetch(service.ready, { signal: AbortSignal.timeout(5_000) })).status < 500;
        } catch {
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
      out(ok ? `testnet: ${service.name} is up` : `testnet: ${service.name} did not answer yet`);
    }
  }
  // CL-U1: a reset database is ready for a playtest without the two manual steps (L-249,
  // F-U13): the mint allowlist gets the test wallet and the owner's playtest wallets (an
  // idempotent upsert), and the operator gas script tops the keeper and the feed writer up
  // to their targets (it sends nothing to an address already there). A failed step is
  // reported and the stack keeps running.
  if (!stopping) readyForPlaytest(env, out);
  if (!stopping)
    out(
      "testnet: everything is started on Monad testnet (chain 10143). Web http://localhost:3000 (put your wallet on Monad Testnet), API http://127.0.0.1:4100. Ctrl-C or pnpm testnet:down stops it; pnpm testnet:to-local goes back to the fork.",
    );
}

const command = process.argv[2];
loadRootEnv();
if (command === "up") await up();
else if (command === "down") {
  const stopped = await stop();
  console.log(`testnet: stopped ${stopped.length ? stopped.join(", ") : "nothing (not running)"}`);
} else if (command === "to-local") {
  const stopped = await stop();
  console.log(
    `testnet: stopped ${stopped.length ? stopped.join(", ") : "nothing"}; starting dev:all`,
  );
  const result = spawnSync(process.execPath, ["scripts/dev-all.js"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  process.exit(result.status ?? 0);
} else if (command === "propose") {
  const id = process.argv[3] ?? "";
  if (!/^[1-9]\d{0,4}$/.test(id)) fail("give the agent ID, such as pnpm testnet:propose 1");
  const state = readState();
  if (!state || !alive(state.supervisor)) fail("the testnet stack is not running; pnpm testnet:up");
  const overLimit = process.argv.includes("--over-limit");
  const path = overLimit ? "test-over-limit" : "tasks/chain-check";
  const res = await fetch(`http://127.0.0.1:4200/v1/agents/${id}/${path}`, {
    method: "POST",
  }).catch(() => null);
  if (!res) fail("the orchestrator did not answer on 127.0.0.1:4200");
  const body =
    /** @type {{ taskId?: string, intentId?: string, message?: string, error?: string }} */ (
      await /** @type {Response} */ (res).json().catch(() => ({}))
    );
  if (body.intentId)
    console.log(
      `agent ${id}: over-limit proposal ${body.intentId} recorded; the trade flow refuses it at submission`,
    );
  else if (body.taskId)
    console.log(
      `agent ${id}: chain check ${body.taskId} queued; its proposal appears on the portfolio page`,
    );
  else fail(body.message ?? body.error ?? `the orchestrator answered ${res?.status}`);
} else {
  console.error("usage: node scripts/testnet-stack.js up | down | to-local | propose <agentId>");
  process.exit(2);
}
