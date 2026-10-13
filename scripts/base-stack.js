// @ts-check
// M-FAST: the stack against the Base fork (pnpm base:fork:up first): the
// indexer, the control API, the orchestrator (the keeper impersonating Pyth
// Entropy on the fork, the signer with the local funding seed, the trade flow,
// the Chainlink feeds re-dated on the fork) and the web app, all with
// APP_ENV=base, a database of their own (alpha_agents_base) and Redis database
// 2, on their own ports (API 4110, orchestrator 4210, web 3010 or WEB_PORT), so
// the dev stack and the testnet stack keep theirs. Never touches the playtest
// fork on 8545 or the Base fork's state.
//
//   pnpm base:up                 start it (the Base fork must answer on 8590)
//   WEB_PORT=3000 pnpm base:up   the web app on 3000 (Privy allows only that origin), when nothing else holds it
//   pnpm base:down               stop it
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { baseForkRpcUrl } from "@alpha-agents/config";
import { createDb, sql } from "@alpha-agents/db";
import { loadRootEnv } from "./lib/config.js";
import {
  MIN_AVAILABLE_BYTES,
  alive,
  availableMemory,
  heavyRunningNow,
  labelLines,
  stopGroup,
} from "./lib/dev-all.js";
import { DEV_DIR, ROOT } from "./lib/paths.js";

const STATE_PATH = join(DEV_DIR, "base-stack.json");
const LOG_PATH = join(DEV_DIR, "base-stack.log");
const LOCAL_DATABASE = "postgres://alpha:alpha_local_dev_only@127.0.0.1:5432/alpha_agents";
export const BASE_DATABASE = "alpha_agents_base";
const WEB_PORT = process.env.WEB_PORT?.trim() || "3010";

/**
 * The testnet stack's own values. Its two secrets are TESTNET_ORCHESTRATOR_SECRET and
 * TESTNET_API_SESSION_SECRET in .env, which config maps on testnet: they must stay the
 * same across restarts, because the orchestrator encrypts each agent's stored gateway key
 * with its secret (P2-EC: a fresh secret per start left every stored key unreadable).
 */
function baseEnv() {
  return {
    APP_ENV: "base",
    FORK_ENV: "base",
    DATABASE_URL: LOCAL_DATABASE.replace(/alpha_agents$/, BASE_DATABASE),
    REDIS_URL: "redis://127.0.0.1:6380/2",
    LITELLM_BASE_URL: "http://127.0.0.1:4000",
    CONTROL_API_PORT: "4110",
    CONTROL_API_URL: "http://127.0.0.1:4110",
    ORCHESTRATOR_PORT: "4210",
    ORCHESTRATOR_URL: "http://127.0.0.1:4210",
    APP_PUBLIC_URL: `http://localhost:${WEB_PORT}`,
    WEB_PORT,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
}

const SERVICES = [
  { name: "indexer", args: ["services/indexer/src/main.ts"], ready: null },
  { name: "api", args: ["apps/control-api/src/main.ts"], ready: "http://127.0.0.1:4110/health" },
  {
    name: "orchestrator",
    args: ["services/orchestrator/src/main.ts"],
    ready: "http://127.0.0.1:4210/health",
  },
  { name: "web", args: ["scripts/web.js", "dev"], ready: `http://localhost:${WEB_PORT}/` },
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
  if (state.supervisor !== process.pid && alive(state.supervisor)) {
    try {
      process.kill(state.supervisor, "SIGTERM");
    } catch {
      // gone
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const stopped = [];
  for (const s of [...state.services].reverse()) {
    if (alive(s.pid)) {
      await stopGroup(s.pid);
      stopped.push(s.name);
    }
  }
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
    const found = await sql`select 1 from pg_database where datname = ${BASE_DATABASE}`.execute(
      admin,
    );
    if (found.rows.length === 0) {
      await sql.raw(`create database ${BASE_DATABASE}`).execute(admin);
      return true;
    }
    return false;
  } finally {
    await admin.destroy();
  }
}

async function up() {
  mkdirSync(DEV_DIR, { recursive: true });
  const previous = readState();
  if (previous && alive(previous.supervisor))
    fail(`the Base stack is already running (PID ${previous.supervisor}); pnpm base:down stops it`);
  if (previous) await stop();
  const busy = [Number(WEB_PORT), 4110, 4210].filter(portBusy);
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
  if (!portBusy(Number(new URL(baseForkRpcUrl(process.env)).port)))
    fail("the Base fork is not up; start it with pnpm base:fork:up");

  writeFileSync(LOG_PATH, "");
  /** @param {string} line */
  const out = (line) => {
    console.log(line);
    appendFileSync(LOG_PATH, `${line}\n`);
  };
  out(
    (await ensureDatabase())
      ? `base: created the database ${BASE_DATABASE}`
      : `base: database ${BASE_DATABASE}`,
  );

  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, ...baseEnv() };
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
    out(`base: ${why}; stopping every service`);
    const stopped = await stop();
    out(`base: stopped ${stopped.length ? stopped.join(", ") : "nothing"}`);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("interrupted"));
  process.on("SIGTERM", () => void shutdown("asked to stop"));

  for (const service of SERVICES) {
    if (stopping) break;
    const child = spawn(process.execPath, service.args, {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    if (!child.pid) fail(`${service.name} did not start`);
    state.services.push({ name: service.name, pid: /** @type {number} */ (child.pid) });
    writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
    for (const stream of [child.stdout, child.stderr]) {
      let rest = "";
      stream?.on("data", (/** @type {Buffer} */ chunk) => {
        const r = labelLines(service.name, rest, chunk.toString("utf8"));
        rest = r.rest;
        for (const line of r.lines) out(line);
      });
    }
    child.on("exit", (code, signal) => {
      if (!stopping)
        out(`base: ${service.name} exited (${signal ?? `code ${code}`}); the rest keep running`);
    });
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
      out(ok ? `base: ${service.name} is up` : `base: ${service.name} did not answer yet`);
    }
  }
  if (!stopping)
    out(
      `base: everything is started on the Base fork (chain 84538453). Web http://localhost:${WEB_PORT} (add the Base fork network to your wallet: chain 84538453, RPC http://127.0.0.1:8590, currency ETH), API http://127.0.0.1:4110. Ctrl-C or pnpm base:down stops it.`,
    );
}

const command = process.argv[2];
loadRootEnv();
if (command === "up") await up();
else if (command === "down") {
  const stopped = await stop();
  console.log(`base: stopped ${stopped.length ? stopped.join(", ") : "nothing (not running)"}`);
} else {
  console.error("usage: node scripts/base-stack.js up | down");
  process.exit(2);
}
