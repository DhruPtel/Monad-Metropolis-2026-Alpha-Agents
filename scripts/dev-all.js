// @ts-check
// pnpm dev:all (D-211): starts the whole local stack and supervises it, with
// every service's output in one stream, each line labeled with its service,
// also written to .dev/dev-all.log. Ctrl-C, or pnpm dev:down from another
// terminal, stops everything it started.
//
//   pnpm dev:all            refuses while a heavy suite runs or memory is low
//   pnpm dev:all --force    starts anyway (your call: the Heavy work rule)
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import {
  LOG_PATH,
  MIN_AVAILABLE_BYTES,
  SERVICES,
  alive,
  availableMemory,
  heavyRunningNow,
  labelLines,
  readState,
  stopRecorded,
  writeState,
} from "./lib/dev-all.js";
import { COMPOSE_FILE, DEV_DIR, ENV_PATH, ROOT } from "./lib/paths.js";

const force = process.argv.includes("--force");
/** @param {string} message */
const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};

mkdirSync(DEV_DIR, { recursive: true });
const previous = readState();
if (previous && alive(previous.supervisor))
  fail(`dev:all is already running (PID ${previous.supervisor}); stop it with pnpm dev:down`);
if (previous) await stopRecorded();

const heavy = heavyRunningNow();
if (heavy.length > 0 && !force)
  fail(
    `${heavy.join(" and ")} is running; wait for it to finish (the Heavy work rule), or pass --force`,
  );
const free = availableMemory();
if (free !== null && free < MIN_AVAILABLE_BYTES && !force)
  fail(
    `only ${(free / 1024 ** 3).toFixed(1)} GiB of memory is available, under the 2 GiB the full stack needs; close something, or pass --force`,
  );

writeFileSync(LOG_PATH, "");
/** @param {string} line */
const out = (line) => {
  console.log(line);
  appendFileSync(LOG_PATH, `${line}\n`);
};

out("dev:all: starting Postgres, Redis and anvil");
if (spawnSync("node", ["scripts/dev.js", "up"], { cwd: ROOT, stdio: "inherit" }).status !== 0)
  fail("pnpm dev:up failed");
out("dev:all: starting LiteLLM");
const litellm = spawnSync(
  "docker",
  [
    "compose",
    "-f",
    COMPOSE_FILE,
    "--env-file",
    ENV_PATH,
    "--profile",
    "agent",
    "up",
    "-d",
    "--wait",
    "litellm",
  ],
  { cwd: ROOT, stdio: "inherit" },
);
if (litellm.status !== 0) fail("LiteLLM did not start (pnpm dev:litellm)");

/** @type {import("./lib/dev-all.js").State} */
const state = { supervisor: process.pid, services: [] };
writeState(state);
let stopping = false;

const shutdown = async (/** @type {string} */ why) => {
  if (stopping) return;
  stopping = true;
  out(`dev:all: ${why}; stopping every service`);
  const stopped = await stopRecorded();
  out(
    `dev:all: stopped ${stopped.length ? stopped.join(", ") : "nothing"}. Containers and anvil keep running; pnpm dev:down stops them too.`,
  );
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("interrupted"));
process.on("SIGTERM", () => void shutdown("asked to stop"));

/** @param {string} url @param {number} timeoutMs */
async function waitReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopping) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (res.status < 500) return true;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

for (const service of SERVICES) {
  if (stopping) break;
  const child = spawn(process.execPath, service.args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  if (!child.pid) fail(`${service.name} did not start`);
  state.services.push({ name: service.name, pid: /** @type {number} */ (child.pid) });
  writeState(state);
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
      out(`dev:all: ${service.name} exited (${signal ?? `code ${code}`}); the rest keep running`);
  });
  if (service.ready) {
    const ok = await waitReady(
      service.ready,
      service.name === "web" || service.name === "console" ? 240_000 : 90_000,
    );
    out(
      ok
        ? `dev:all: ${service.name} is up at ${service.ready}`
        : `dev:all: ${service.name} did not answer ${service.ready} yet`,
    );
  }
}
if (!stopping)
  out(
    "dev:all: everything is started. Web http://localhost:3000, console http://127.0.0.1:3001, API http://127.0.0.1:4100, orchestrator http://127.0.0.1:4200. Ctrl-C or pnpm dev:down stops it all.",
  );
