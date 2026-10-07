// @ts-check
// pnpm test:fork: the forge fork tests, AgentNFT and AccountFactory deploys and the address
// book check, on a fork of their own on port 8546 (D-200), started here and
// stopped afterwards. The playtest fork on 8545 is never touched: a run there
// used to need snapshots, and a restored state dump has no history (L-63).
// A forge run that fails on a transient upstream fetch is retried once on a
// fresh fork (L-70).
import { ConfigError, LOCAL_TEST_FORK_PORT } from "@alpha-agents/config";
import { startTestFork } from "@alpha-agents/devenv";
import { spawnSync } from "node:child_process";

// Every library below reads the fork's port from here when it loads.
process.env.LOCAL_FORK_PORT = String(LOCAL_TEST_FORK_PORT);
const { loadLocalConfig, loadRootEnv } = await import("./lib/config.js");
const { deployLocal, isTransientForkError } = await import("./lib/agent-nft.js");
const { deployAccountFactoryLocal } = await import("./lib/account-factory.js");
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

/** The forge fork tests against a fork; output is printed and returned. */
function forgeForkTests(/** @type {string} */ url) {
  const result = spawnSync("forge", ["test", "--match-path", "test/fork/**", "-vv"], {
    cwd: MONAD_DIR,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LOCAL_FORK_URL: url },
  });
  if (result.error) console.error("error: forge not found on PATH");
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

console.log(`starting a test fork on port ${LOCAL_TEST_FORK_PORT}`);
let fork = await startTestFork();
let status;
try {
  let result = forgeForkTests(fork.url);
  // A fresh fork fetches everything from the upstream, which sometimes fails a fetch (L-43,
  // L-70). One retry on a new fork, only for a failure classified as transient upstream.
  if (result.status !== 0 && isTransientForkError(result.output)) {
    console.log("\nforge failed on a transient upstream error; retrying once on a fresh fork");
    await fork.stop();
    fork = await startTestFork();
    result = forgeForkTests(fork.url);
  }

  console.log("\nAgentNFT on the test fork:");
  let deployed = true;
  try {
    console.log(await deployLocal({ quiet: true }));
    console.log("\nAccountFactory and the PersonalAccount implementation on the test fork:");
    const custody = await deployAccountFactoryLocal({ quiet: true });
    console.log(`${custody.factory}\n${custody.implementation}`);
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
