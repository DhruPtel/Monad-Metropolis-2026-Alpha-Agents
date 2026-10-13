// @ts-check
// M-FAST: the Base fork for the Colosseum demo, beside the playtest fork.
//
//   pnpm base:fork:up      start anvil as a fork of Base mainnet at chains/base/fork.json's
//                          block, on port 8590 (BASE_FORK_PORT), answering chain 84538453,
//                          with its state saved to .dev/base-anvil-state.json every minute
//   pnpm base:fork:down    stop it (the saved state is kept; delete the file for a fresh fork)
//
// The upstream is BASE_RPC_URL from .env, or Base's public endpoint when it is
// unset (A-98); the URL never reaches the log or the terminal. The contract
// size limit is lifted on this fork only (anvil's --code-size-limit): the
// current trading contracts are over Base's 24,576 bytes until M-U0 splits
// them, and anvil is the only thing that reads the flag, so no real chain can
// ever get it. Never pointed at the playtest fork on 8545.
import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { BASE_FORK_CHAIN_ID, baseForkRpcUrl } from "@alpha-agents/config";
import { baseUpstreamUrl, loadRootEnv, readBaseForkConfig } from "./lib/config.js";
import {
  BASE_ANVIL_LOG_PATH,
  BASE_ANVIL_PID_PATH,
  BASE_ANVIL_STATE_PATH,
  DEV_DIR,
} from "./lib/paths.js";
import { alive } from "./lib/dev-all.js";

/** anvil's limit is bytes; 128 KB matches Monad's, so the same contracts deploy. */
const CODE_SIZE_LIMIT = 131072;
const STATE_INTERVAL_SECONDS = 60;

loadRootEnv();
const command = process.argv[2];
const url = baseForkRpcUrl(process.env);
const port = Number(new URL(url).port);

/** @param {string} method @param {unknown[]} [params] */
async function rpc(method, params = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  return /** @type {{ result?: unknown }} */ (await res.json()).result;
}

async function answers() {
  try {
    return Number(await rpc("eth_chainId")) === BASE_FORK_CHAIN_ID;
  } catch {
    return false;
  }
}

async function up() {
  mkdirSync(DEV_DIR, { recursive: true });
  if (await answers()) {
    console.log(`base fork: already up on ${url} (chain ${BASE_FORK_CHAIN_ID})`);
    return;
  }
  const { blockNumber } = readBaseForkConfig();
  const upstream = baseUpstreamUrl();
  const log = createWriteStream(BASE_ANVIL_LOG_PATH, { flags: "a" });
  const redact = (/** @type {string} */ text) =>
    text
      .replaceAll(upstream, "<base-upstream>")
      .replace(/https?:\/\/(?!127\.0\.0\.1)\S+/g, "<url>");
  const restoring = existsSync(BASE_ANVIL_STATE_PATH);
  log.write(
    `${new Date().toISOString()} starting the Base fork at block ${blockNumber} on port ${port}${restoring ? ` from ${BASE_ANVIL_STATE_PATH}` : ""}\n`,
  );
  const args = [
    "--fork-url",
    upstream,
    "--fork-block-number",
    String(blockNumber),
    "--chain-id",
    String(BASE_FORK_CHAIN_ID),
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
    "--code-size-limit",
    String(CODE_SIZE_LIMIT),
    "--state",
    BASE_ANVIL_STATE_PATH,
    "--state-interval",
    String(STATE_INTERVAL_SECONDS),
    // Base is an OP Stack chain: its blocks carry deposit transactions (type 0x7e), which anvil
    // and forge only read with Optimism support on.
    "--optimism",
    "--retries",
    "5",
    "--timeout",
    "45000",
    "--no-rate-limit",
  ];
  const child = spawn("anvil", args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  if (!child.pid) throw new Error("anvil did not start");
  writeFileSync(BASE_ANVIL_PID_PATH, String(child.pid));
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk) => log.write(redact(String(chunk))));
  child.on("exit", (code, signal) => {
    log.write(`${new Date().toISOString()} anvil exited (${signal ?? `code ${code}`})\n`);
    rmSync(BASE_ANVIL_PID_PATH, { force: true });
  });
  child.unref();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await answers()) {
      const head = Number(await rpc("eth_blockNumber"));
      console.log(
        `base fork: up on ${url} as chain ${BASE_FORK_CHAIN_ID}, head ${head} (pinned at ${blockNumber}); log ${BASE_ANVIL_LOG_PATH}`,
      );
      return;
    }
    if (!alive(child.pid)) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  console.error(`error: the Base fork did not answer on ${url}; see ${BASE_ANVIL_LOG_PATH}`);
  process.exit(1);
}

async function down() {
  if (!existsSync(BASE_ANVIL_PID_PATH)) {
    console.log("base fork: not running (no pid file)");
    return;
  }
  const pid = Number(readFileSync(BASE_ANVIL_PID_PATH, "utf8"));
  if (alive(pid)) {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 200));
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  rmSync(BASE_ANVIL_PID_PATH, { force: true });
  console.log(`base fork: stopped; state kept in ${BASE_ANVIL_STATE_PATH}`);
}

if (command === "up") await up();
else if (command === "down") await down();
else {
  console.error("usage: node scripts/base-fork.js up | down");
  process.exit(2);
}
