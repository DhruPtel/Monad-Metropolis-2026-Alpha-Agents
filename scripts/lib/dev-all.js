// @ts-check
// pnpm dev:all and pnpm dev:down (D-211): every local service as one
// supervised process with labeled, combined logs. The stack (Postgres, Redis,
// anvil) and LiteLLM start first; then the indexer, the control API, the
// orchestrator, the web app and the console, each in its own process group so
// a stop takes its children (next dev) too. Their PIDs go to
// .dev/dev-all.json so dev:down stops them by PID (L-11), even after the
// supervisor itself was killed.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEV_DIR } from "./paths.js";

export const STATE_PATH = join(DEV_DIR, "dev-all.json");
export const LOG_PATH = join(DEV_DIR, "dev-all.log");
/** Below this much available memory dev:all refuses to start (Heavy work rule). */
export const MIN_AVAILABLE_BYTES = 2 * 1024 ** 3;

/**
 * The services, in start order. `ready` is a URL that answers once the service is up.
 * @type {readonly { name: string, args: string[], ready: string | null }[]}
 */
export const SERVICES = [
  { name: "indexer", args: ["services/indexer/src/main.ts"], ready: null },
  { name: "api", args: ["apps/control-api/src/main.ts"], ready: "http://127.0.0.1:4100/health" },
  {
    name: "orchestrator",
    args: ["services/orchestrator/src/main.ts"],
    ready: "http://127.0.0.1:4200/health",
  },
  { name: "web", args: ["scripts/web.js", "dev"], ready: "http://localhost:3000/" },
  { name: "console", args: ["scripts/console.js", "dev"], ready: "http://127.0.0.1:3001/" },
];

/**
 * Prefixes each complete line with its service's label; returns the unfinished tail.
 * @param {string} label
 * @param {string} buffered
 * @param {string} chunk
 * @returns {{ lines: string[], rest: string }}
 */
export function labelLines(label, buffered, chunk) {
  const text = buffered + chunk;
  const parts = text.split("\n");
  const rest = parts.pop() ?? "";
  const width = Math.max(...SERVICES.map((s) => s.name.length));
  return {
    lines: parts.map((l) => `${label.padEnd(width)} | ${l.replace(/\r$/, "")}`),
    rest,
  };
}

/** Bytes of MemAvailable from /proc/meminfo, or null where it cannot be read. */
export function availableMemory(meminfo = "/proc/meminfo") {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync(meminfo, "utf8"));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Heavy suites running now (Heavy work rule): Playwright, in the pinned image
 * or on the host, and production builds.
 * @param {string} processList  `ps -eo args` output
 * @param {string} containerImages  `docker ps --format {{.Image}}` output
 * @returns {string[]}
 */
export function heavyRunning(processList, containerImages) {
  const found = [];
  if (/mcr\.microsoft\.com\/playwright/.test(containerImages)) found.push("a Playwright container");
  for (const line of processList.split("\n")) {
    if (/@playwright\/test\/cli\.js\s+test|playwright test/.test(line)) found.push("Playwright");
    if (/next(\/dist\/bin\/next)?\s+build/.test(line)) found.push("a next build");
    if (/scripts\/web-e2e\.js|scripts\/check-web-build\.js/.test(line)) found.push("a web e2e run");
  }
  return [...new Set(found)];
}

/** @returns {string[]} */
export function heavyRunningNow() {
  const ps = spawnSync("ps", ["-eo", "args"], { encoding: "utf8" });
  const docker = spawnSync("docker", ["ps", "--format", "{{.Image}}"], { encoding: "utf8" });
  return heavyRunning(ps.stdout ?? "", docker.stdout ?? "");
}

/**
 * @typedef {{ supervisor: number, services: { name: string, pid: number }[] }} State
 */

/** @returns {State | null} */
export function readState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

/** @param {State} state */
export function writeState(state) {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

/** @param {number} pid */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stops a process group (the service and its children), politely then firmly.
 * @param {number} pid
 */
export async function stopGroup(pid) {
  const signal = (/** @type {NodeJS.Signals} */ sig) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // already gone
      }
    }
  };
  signal("SIGTERM");
  for (let i = 0; i < 50 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 200));
  if (alive(pid)) signal("SIGKILL");
}

/** Stops every service the state file names, then removes it. Returns what it stopped. */
export async function stopRecorded() {
  const state = readState();
  if (!state) return [];
  // The supervisor first, so it knows the exits that follow are a stop, not a crash.
  if (state.supervisor !== process.pid && alive(state.supervisor)) {
    try {
      process.kill(state.supervisor, "SIGTERM");
    } catch {
      // gone
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const stopped = [];
  // Newest first: the console and web before the services they read.
  for (const s of [...state.services].reverse()) {
    if (alive(s.pid)) {
      await stopGroup(s.pid);
      stopped.push(s.name);
    }
  }
  rmSync(STATE_PATH, { force: true });
  return stopped;
}
