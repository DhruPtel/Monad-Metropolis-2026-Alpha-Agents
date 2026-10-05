// @ts-check
// Runs the fork smoke tests against the local anvil fork started by `pnpm dev:up`,
// deploys our own contracts there (deterministic and idempotent), then checks
// every verified address book entry against the same fork.
// Forge does not read the root .env, and the fork tests skip themselves when
// MONAD_RPC_URL is unset, so this loads .env and refuses to run instead of
// letting a skipped suite look like a pass.
import { spawnSync } from "node:child_process";
import { ConfigError } from "@alpha-agents/config";
import { revertToSnapshot, takeSnapshot } from "@alpha-agents/devenv";
import { deployLocal } from "./lib/agent-nft.js";
import { loadLocalConfig, loadRootEnv } from "./lib/config.js";
import { MONAD_DIR } from "./lib/paths.js";
import { verifyAddressBook } from "./lib/verify-addresses.js";

loadRootEnv();
try {
  loadLocalConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const result = spawnSync("forge", ["test", "--match-path", "test/fork/**", "-vv"], {
  cwd: MONAD_DIR,
  stdio: "inherit",
  env: process.env,
});
if (result.error) console.error("error: forge not found on PATH");

// Our own contracts are recorded in the address book at their deterministic
// local addresses; deploy them first (a no-op when already deployed).
// The snapshot is reverted afterwards, so the check leaves the fork as it found it.
console.log("\nAgentNFT on the local fork:");
const snapshot = await takeSnapshot();
let deployed = true;
try {
  console.log(await deployLocal({ quiet: true }));
} catch (err) {
  deployed = false;
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
}

console.log("\naddress book (packages/domain) against the local fork:");
const book = await verifyAddressBook();
await revertToSnapshot(snapshot);
for (const line of book.lines) console.log(line);
console.log(
  book.ok ? "address book: every verified entry matches the fork" : "address book: MISMATCH",
);

process.exit(result.status === 0 && deployed && book.ok ? 0 : 1);
