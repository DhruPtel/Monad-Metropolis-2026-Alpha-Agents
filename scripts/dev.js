// @ts-check
// Local environment commands: up, status, down, reset.
// Postgres and Redis run in Docker Compose; anvil runs as a local process
// supervised by scripts/anvil-runner.js.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { ConfigError } from "@alpha-agents/config";
import {
  ANVIL_URL,
  MONAD_MAINNET_CHAIN_ID,
  loadLocalConfig,
  loadRootEnv,
  readForkConfig,
} from "./lib/config.js";
import { ANVIL_LOG_PATH, ANVIL_PID_PATH, COMPOSE_FILE, ROOT } from "./lib/paths.js";
import { run, runInherit } from "./lib/proc.js";
import { redact } from "./lib/redact.js";
import { hexToNumber, rpc } from "./lib/rpc.js";

loadRootEnv();

const ANVIL_START_TIMEOUT_MS = 120_000;
const composeArgs = ["compose", "-f", COMPOSE_FILE];

/** @param {string[]} args */
const compose = (args) => run("docker", [...composeArgs, ...args], { timeoutMs: 60_000 });

/** @param {string} message */
function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function requireDocker() {
  const daemon = run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (!daemon.ok) fail("Docker is not reachable. Start Docker Desktop, then run pnpm run doctor.");
}

/** @returns {number | undefined} the runner PID if it is alive */
function runnerPid() {
  if (!existsSync(ANVIL_PID_PATH)) return undefined;
  const pid = Number.parseInt(readFileSync(ANVIL_PID_PATH, "utf8"), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
  } catch {
    rmSync(ANVIL_PID_PATH, { force: true });
    return undefined;
  }
  // Guard against PID reuse where /proc is available (Linux, WSL).
  const cmdline = `/proc/${pid}/cmdline`;
  if (existsSync(cmdline) && !readFileSync(cmdline, "utf8").includes("anvil-runner")) {
    rmSync(ANVIL_PID_PATH, { force: true });
    return undefined;
  }
  return pid;
}

/** @returns {Promise<{ chainId: number, blockNumber: number } | undefined>} */
async function anvilState() {
  try {
    const chainId = hexToNumber(await rpc(ANVIL_URL, "eth_chainId", [], 3_000));
    const blockNumber = hexToNumber(await rpc(ANVIL_URL, "eth_blockNumber", [], 3_000));
    return { chainId, blockNumber };
  } catch {
    return undefined;
  }
}

/**
 * The EVM family anvil runs, from anvil_nodeInfo. Only `network` is read: the
 * same response carries the fork URL, which must never be printed.
 * @returns {Promise<string | undefined>}
 */
async function anvilNetwork() {
  try {
    const info = /** @type {{ network?: unknown } | null} */ (
      await rpc(ANVIL_URL, "anvil_nodeInfo", [], 3_000)
    );
    return typeof info?.network === "string" ? info.network : undefined;
  } catch {
    return undefined;
  }
}

function anvilLogTail() {
  if (!existsSync(ANVIL_LOG_PATH)) return "(no anvil log)";
  const lines = readFileSync(ANVIL_LOG_PATH, "utf8").trimEnd().split("\n");
  // The runner already redacts; redact again in case the log came from elsewhere.
  return redact(lines.slice(-15).join("\n"), [process.env.MONAD_RPC_URL]);
}

async function startAnvil() {
  if (runnerPid() !== undefined) {
    console.log("anvil: already running");
    return;
  }
  if ((await anvilState()) !== undefined) {
    fail(`something else is already serving ${ANVIL_URL}; stop it and retry`);
  }
  const runner = spawn(process.execPath, ["scripts/anvil-runner.js"], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  let exited = false;
  runner.on("exit", () => {
    exited = true;
  });
  runner.unref();

  const deadline = Date.now() + ANVIL_START_TIMEOUT_MS;
  process.stdout.write("anvil: starting fork");
  while (!exited && Date.now() < deadline) {
    await sleep(1_000);
    process.stdout.write(".");
    if ((await anvilState()) !== undefined) {
      process.stdout.write(" ready\n");
      return;
    }
  }
  process.stdout.write(" failed\n");
  console.error(anvilLogTail());
  await stopAnvil();
  fail("anvil did not start; see the log above and run pnpm run doctor");
}

async function stopAnvil() {
  const pid = runnerPid();
  if (pid === undefined) {
    console.log("anvil: not running");
    return;
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50 && runnerPid() !== undefined; i += 1) await sleep(200);
  if (runnerPid() !== undefined) {
    process.kill(pid, "SIGKILL");
    rmSync(ANVIL_PID_PATH, { force: true });
  }
  console.log("anvil: stopped");
}

async function up() {
  requireDocker();
  try {
    loadLocalConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    fail(`${err.message}\nRun pnpm run doctor for details.`);
  }
  console.log("postgres, redis: starting");
  if (!runInherit("docker", [...composeArgs, "up", "-d", "--wait"])) {
    fail("docker compose up failed");
  }
  await startAnvil();
  return status();
}

/** @returns {Promise<boolean>} */
async function status() {
  let healthy = true;
  /**
   * @param {boolean} ok
   * @param {string} name
   * @param {string} detail
   */
  const line = (ok, name, detail) => {
    if (!ok) healthy = false;
    console.log(`${ok ? "UP  " : "DOWN"}  ${name.padEnd(9)} ${detail}`);
  };

  const dockerUp = run("docker", ["info", "--format", "{{.ServerVersion}}"]).ok;
  if (!dockerUp) {
    line(false, "postgres", "Docker not reachable");
    line(false, "redis", "Docker not reachable");
  } else {
    const pg = compose([
      "exec",
      "-T",
      "postgres",
      "pg_isready",
      "-U",
      "alpha",
      "-d",
      "alpha_agents",
    ]);
    line(pg.ok, "postgres", pg.ok ? "accepting connections" : "not accepting connections");
    const redis = compose(["exec", "-T", "redis", "redis-cli", "ping"]);
    const pong = redis.ok && redis.stdout.trim() === "PONG";
    line(pong, "redis", pong ? "PONG" : "not responding");
  }

  const { blockNumber: pinned } = readForkConfig();
  const anvil = await anvilState();
  if (anvil === undefined) {
    line(false, "anvil", `no response at ${ANVIL_URL}`);
  } else {
    const network = await anvilNetwork();
    const ok =
      anvil.chainId === MONAD_MAINNET_CHAIN_ID &&
      anvil.blockNumber >= pinned &&
      network === "monad";
    const atPin = anvil.blockNumber === pinned ? "at pinned block" : `pinned block is ${pinned}`;
    const net =
      network === "monad" ? "network monad" : `network ${network ?? "unknown"}, want monad`;
    line(ok, "anvil", `chain ID ${anvil.chainId}, ${net}, block ${anvil.blockNumber} (${atPin})`);
  }
  return healthy;
}

async function down() {
  await stopAnvil();
  if (run("docker", ["info", "--format", "{{.ServerVersion}}"]).ok) {
    if (!runInherit("docker", [...composeArgs, "down"])) fail("docker compose down failed");
  } else {
    console.log("postgres, redis: Docker not reachable, nothing to stop");
  }
}

async function reset() {
  requireDocker();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    "This stops everything and deletes the local Postgres and Redis volumes.\nType 'reset' to continue: ",
  );
  rl.close();
  if (answer.trim() !== "reset") {
    console.log("Aborted. Nothing was changed.");
    return;
  }
  await stopAnvil();
  if (!runInherit("docker", [...composeArgs, "down", "--volumes"])) {
    fail("docker compose down --volumes failed");
  }
  console.log("Local volumes deleted.");
}

const commands = { up, status, down, reset };
const name = process.argv[2];
if (name === undefined || !(name in commands)) {
  fail(`usage: node scripts/dev.js <${Object.keys(commands).join("|")}>`);
} else {
  const result = await commands[/** @type {keyof typeof commands} */ (name)]();
  if (result === false) process.exit(1);
}
