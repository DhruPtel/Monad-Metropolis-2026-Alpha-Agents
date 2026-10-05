// @ts-check
// pnpm test:fork: the forge fork tests, an AgentNFT deploy and the address
// book check, on a fork of their own on port 8546 (D-200), started here and
// stopped afterwards. The playtest fork on 8545 is never touched: a run there
// used to need snapshots, and a restored state dump has no history (L-63).
import { ConfigError, LOCAL_TEST_FORK_PORT } from "@alpha-agents/config";
import { startTestFork } from "@alpha-agents/devenv";
import { spawnSync } from "node:child_process";

// Every library below reads the fork's port from here when it loads.
process.env.LOCAL_FORK_PORT = String(LOCAL_TEST_FORK_PORT);
const { loadLocalConfig, loadRootEnv } = await import("./lib/config.js");
const { deployLocal } = await import("./lib/agent-nft.js");
const { verifyAddressBook } = await import("./lib/verify-addresses.js");
const { MONAD_DIR } = await import("./lib/paths.js");

loadRootEnv();
try {
  loadLocalConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(1);
}

console.log(`starting a test fork on port ${LOCAL_TEST_FORK_PORT}`);
const fork = await startTestFork();
let status;
try {
  const result = spawnSync("forge", ["test", "--match-path", "test/fork/**", "-vv"], {
    cwd: MONAD_DIR,
    stdio: "inherit",
    env: { ...process.env, LOCAL_FORK_URL: fork.url },
  });
  if (result.error) console.error("error: forge not found on PATH");

  console.log("\nAgentNFT on the test fork:");
  let deployed = true;
  try {
    console.log(await deployLocal({ quiet: true }));
  } catch (err) {
    deployed = false;
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("\naddress book (packages/domain) against the test fork:");
  const book = await verifyAddressBook();
  for (const line of book.lines) console.log(line);
  console.log(
    book.ok ? "address book: every verified entry matches the fork" : "address book: MISMATCH",
  );
  status = result.status === 0 && deployed && book.ok ? 0 : 1;
} finally {
  await fork.stop();
}
process.exit(status ?? 1);
