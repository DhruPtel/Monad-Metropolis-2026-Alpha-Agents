// @ts-check
// Runs anvil as a child process, writes its output to .dev/anvil.log with the
// RPC URL redacted, and stops anvil when this process is told to stop.
// Started detached by `pnpm dev:up`; not meant to be run by hand.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { ANVIL_HOST, ANVIL_PORT, loadRootEnv, readForkConfig } from "./lib/config.js";
import { ANVIL_LOG_PATH, ANVIL_PID_PATH, DEV_DIR, MONAD_DIR } from "./lib/paths.js";
import { LOCAL_FORK_CHAIN_ID } from "@alpha-agents/config";
import {
  FORK_START_ATTEMPTS,
  backoffMs,
  forkUpstreams,
  redact,
  servesBlock,
  upstreamFor,
} from "@alpha-agents/devenv";

loadRootEnv();
const upstreams = forkUpstreams(process.env);
const { blockNumber } = readForkConfig();
mkdirSync(DEV_DIR, { recursive: true });
const log = createWriteStream(ANVIL_LOG_PATH, { flags: "w" });
writeFileSync(ANVIL_PID_PATH, String(process.pid));
const cleanup = () => rmSync(ANVIL_PID_PATH, { force: true });
/** @param {number} code */
const finish = (code) => {
  cleanup();
  log.end(() => process.exit(code));
};
if (upstreams.length === 0) {
  log.write("no fork upstream: set MONAD_RPC_URL in .env\n");
  finish(1);
}

/** @type {import("node:child_process").ChildProcess | null} */
let anvil = null;
let stopping = false;
let ready = false;

/** True once anvil answers on its port as the local fork. */
async function answers() {
  try {
    const res = await fetch(`http://${ANVIL_HOST}:${ANVIL_PORT}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(2_000),
    });
    const body = /** @type {{ result?: string }} */ (await res.json());
    return body.result !== undefined && Number(body.result) === LOCAL_FORK_CHAIN_ID;
  } catch {
    return false;
  }
}

/**
 * Starts anvil on the attempt's upstream. The upstream sometimes answers the
 * pinned block as missing (L-87), so each attempt asks for it first, attempts
 * back off exponentially, and alternate with MONAD_RPC_URL_SECONDARY when it
 * is set (D-220). Once anvil serves, an exit ends this runner, as before.
 * @param {number} attempt
 */
async function launch(attempt) {
  if (stopping) return finish(0);
  const upstream = upstreamFor(upstreams, attempt);
  const which = upstreams.indexOf(upstream) === 0 ? "primary" : "secondary";
  const retry = (/** @type {string} */ why) => {
    log.write(`attempt ${attempt}: ${why}\n`);
    if (attempt >= FORK_START_ATTEMPTS) return finish(1);
    setTimeout(() => void launch(attempt + 1), backoffMs(attempt));
  };
  if (!(await servesBlock(upstream, blockNumber)))
    return retry(`the ${which} upstream did not serve block ${blockNumber}`);
  log.write(`attempt ${attempt}: starting anvil on the ${which} upstream\n`);
  // `--fork-url monad` resolves the alias in chains/monad/foundry.toml from
  // MONAD_RPC_URL, so the URL never appears in the process argument list.
  // The fork answers its own chain ID, 143143, not Monad mainnet's 143, so no
  // wallet can confuse the two (D-195, L-53). anvil infers the network family
  // from the chain ID, which no longer says Monad, so `--network monad` keeps
  // Monad's EVM and hardfork explicitly.
  const child = spawn(
    "anvil",
    [
      "--fork-url",
      "monad",
      "--fork-block-number",
      String(blockNumber),
      "--chain-id",
      String(LOCAL_FORK_CHAIN_ID),
      "--network",
      "monad",
      "--host",
      ANVIL_HOST,
      "--port",
      String(ANVIL_PORT),
    ],
    {
      cwd: MONAD_DIR,
      env: { ...process.env, MONAD_RPC_URL: upstream },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  anvil = child;
  /** @param {Buffer} chunk */
  const write = (chunk) => log.write(redact(chunk.toString("utf8"), upstreams));
  child.stdout?.on("data", write);
  child.stderr?.on("data", write);
  child.on("error", (err) => {
    log.write(`anvil failed to start: ${err.message}\n`);
    finish(1);
  });
  child.on("exit", (code, signal) => {
    log.write(`anvil exited (code ${code ?? "none"}, signal ${signal ?? "none"})\n`);
    anvil = null;
    if (stopping || ready) return finish(code ?? 0);
    retry("anvil exited before it served the fork");
  });
  for (let i = 0; i < 120 && !ready && anvil === child; i += 1) {
    if (await answers()) ready = true;
    else await new Promise((r) => setTimeout(r, 500));
  }
}

for (const sig of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"])) {
  process.on(sig, () => {
    stopping = true;
    if (anvil) anvil.kill("SIGTERM");
    else finish(0);
  });
}

void launch(1);
