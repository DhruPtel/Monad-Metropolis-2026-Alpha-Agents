// @ts-check
// Runs anvil as a child process, writes its output to .dev/anvil.log with the
// RPC URL redacted, and stops anvil when this process is told to stop.
// Started detached by `pnpm dev:up`; not meant to be run by hand.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { ANVIL_HOST, ANVIL_PORT, loadRootEnv, readForkConfig } from "./lib/config.js";
import { ANVIL_LOG_PATH, ANVIL_PID_PATH, DEV_DIR, MONAD_DIR } from "./lib/paths.js";
import { redact } from "@alpha-agents/devenv";

loadRootEnv();
const secrets = [process.env.MONAD_RPC_URL];
const { blockNumber } = readForkConfig();

mkdirSync(DEV_DIR, { recursive: true });
const log = createWriteStream(ANVIL_LOG_PATH, { flags: "w" });
writeFileSync(ANVIL_PID_PATH, String(process.pid));

// `--fork-url monad` resolves the alias in chains/monad/foundry.toml from
// MONAD_RPC_URL, so the URL never appears in the process argument list.
const anvil = spawn(
  "anvil",
  [
    "--fork-url",
    "monad",
    "--fork-block-number",
    String(blockNumber),
    "--host",
    ANVIL_HOST,
    "--port",
    String(ANVIL_PORT),
  ],
  { cwd: MONAD_DIR, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);

/** @param {Buffer} chunk */
const write = (chunk) => log.write(redact(chunk.toString("utf8"), secrets));
anvil.stdout.on("data", write);
anvil.stderr.on("data", write);

const cleanup = () => rmSync(ANVIL_PID_PATH, { force: true });

anvil.on("error", (err) => {
  log.write(`anvil failed to start: ${err.message}\n`);
  cleanup();
  process.exit(1);
});

anvil.on("exit", (code, signal) => {
  log.write(`anvil exited (code ${code ?? "none"}, signal ${signal ?? "none"})\n`);
  cleanup();
  log.end(() => process.exit(code ?? 0));
});

for (const sig of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"])) {
  process.on(sig, () => anvil.kill("SIGTERM"));
}
