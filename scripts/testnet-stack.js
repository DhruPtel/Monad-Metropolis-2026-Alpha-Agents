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
import { loadRootEnv } from "./lib/config.js";
import {
  MIN_AVAILABLE_BYTES,
  alive,
  availableMemory,
  heavyRunningNow,
  labelLines,
  readState as readLocalState,
  stopGroup,
} from "./lib/dev-all.js";
import { DEV_DIR, ROOT } from "./lib/paths.js";

const STATE_PATH = join(DEV_DIR, "testnet-stack.json");
const LOG_PATH = join(DEV_DIR, "testnet-stack.log");
const LOCAL_DATABASE = "postgres://alpha:alpha_local_dev_only@127.0.0.1:5432/alpha_agents";
export const TESTNET_DATABASE = "alpha_agents_testnet";

/** The testnet stack's own values; secrets are fresh each start and never written down. */
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
    API_SESSION_SECRET: randomBytes(32).toString("hex"),
    ORCHESTRATOR_SECRET: randomBytes(32).toString("hex"),
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
  },
  { name: "web", args: ["scripts/web.js", "dev"], ready: "http://localhost:3000/" },
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

async function up() {
  mkdirSync(DEV_DIR, { recursive: true });
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
        out(`testnet: ${service.name} exited (${signal ?? `code ${code}`}); the rest keep running`);
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
      out(ok ? `testnet: ${service.name} is up` : `testnet: ${service.name} did not answer yet`);
    }
  }
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
