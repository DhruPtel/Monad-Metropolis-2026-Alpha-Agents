// @ts-check
// pnpm test:testnet-fork: P2-EC's dry run of the testnet deployment and trade
// path (chains/monad/test/testnet) on forge's in-memory fork of Monad testnet.
// Nothing is sent to testnet and no local RPC server is started, so no local
// chain ever answers testnet's chain ID. The RPC URL is read by forge from the
// environment (foundry.toml's monad_testnet alias) and redacted from every
// line printed here.
import { spawn } from "node:child_process";
import { redact } from "@alpha-agents/devenv";
import { loadRootEnv } from "./lib/config.js";
import { MONAD_DIR } from "./lib/paths.js";

loadRootEnv();
const url = process.env.MONAD_TESTNET_RPC_URL?.trim();
if (!url) {
  console.error("error: MONAD_TESTNET_RPC_URL is not set in .env");
  process.exit(1);
}

const child = spawn(
  "forge",
  ["test", "--match-path", "test/testnet/**", "--threads", "1", "-vv", ...process.argv.slice(2)],
  { cwd: MONAD_DIR, env: { ...process.env, TESTNET_FORK: "true" } },
);
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => process.stdout.write(redact(String(chunk), [url])));
}
child.on("error", () => {
  console.error("error: forge not found on PATH");
  process.exit(1);
});
child.on("close", (status) => process.exit(status ?? 1));
