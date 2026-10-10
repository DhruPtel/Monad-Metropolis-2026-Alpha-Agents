// @ts-check
// pnpm test:fork: the forge fork tests, AgentNFT and AccountFactory deploys and the address
// book check, on a fork of their own on port 8546 (D-200), started here and
// stopped afterwards. The playtest fork on 8545 is never touched: a run there
// used to need snapshots, and a restored state dump has no history (L-63).
// A forge run that fails on a transient upstream fetch is retried once on a
// fresh fork (L-70).
import { ConfigError, LOCAL_TEST_FORK_PORT } from "@alpha-agents/config";
import { startTestFork } from "@alpha-agents/devenv";
import { spawn } from "node:child_process";

// Every library below reads the fork's port from here when it loads.
process.env.LOCAL_FORK_PORT = String(LOCAL_TEST_FORK_PORT);
const { loadLocalConfig, loadRootEnv } = await import("./lib/config.js");
const { deployLocal, isTransientForkError } = await import("./lib/agent-nft.js");
const { deployAccountFactoryLocal } = await import("./lib/account-factory.js");
const { deployFundLocal } = await import("./lib/fund.js");
const { deployCustodyV3Local } = await import("./lib/custody-v3.js");
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

/**
 * The forge fork tests against a fork; output is printed and returned. Run
 * asynchronously: this process drains anvil's log pipe, and a spawnSync here
 * would block it, so once anvil had logged a pipe's worth it stopped answering
 * mid-run (L-109). One suite at a time keeps the fork's upstream fetches in step.
 * @param {string} url
 * @returns {Promise<{ status: number | null, output: string }>}
 */
function forgeForkTests(url) {
  return new Promise((resolve) => {
    const child = spawn(
      "forge",
      ["test", "--match-path", "test/fork/**", "--threads", "1", "-vv"],
      {
        cwd: MONAD_DIR,
        env: { ...process.env, LOCAL_FORK_URL: url },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", () => {
      console.error("error: forge not found on PATH");
      resolve({ status: 1, output });
    });
    child.on("close", (status) => resolve({ status, output }));
  });
}

/** Fresh-fork retries for forge on a transient upstream failure. */
const FORGE_RETRIES = 2;

console.log(`starting a test fork on port ${LOCAL_TEST_FORK_PORT}`);
let fork = await startTestFork();
let status;
try {
  let result = await forgeForkTests(fork.url);
  // A fresh fork fetches everything from the upstream, which sometimes fails a fetch (L-43,
  // L-70, L-109). Up to two retries, each on a new fork, only for a failure classified as
  // transient upstream.
  for (let retry = 1; retry <= FORGE_RETRIES; retry++) {
    if (result.status === 0 || !isTransientForkError(result.output)) break;
    console.log(
      `\nforge failed on a transient upstream error; retry ${retry} of ${FORGE_RETRIES} on a fresh fork`,
    );
    await fork.stop();
    fork = await startTestFork();
    result = await forgeForkTests(fork.url);
  }

  console.log("\nAgentNFT on the test fork:");
  let deployed = true;
  try {
    console.log(await deployLocal({ quiet: true }));
    console.log("\nAccountFactory and the PersonalAccount implementation on the test fork:");
    const custody = await deployAccountFactoryLocal({ quiet: true });
    console.log(`${custody.factory}\n${custody.implementation}`);
    // F-U2: the v3 set. Screens are the orchestrator's; a test fork seeds every candidate.
    console.log("\nthe fund agent's v3 set on the test fork:");
    const fund = await deployFundLocal({ quiet: true, skipScreens: true });
    console.log(
      `${fund.tokenRegistry}\n${fund.protocolRegistry}\n${fund.oracle}\n${fund.routeAdapter}`,
    );
    // F-U3: the custody core v3, bound to that set.
    console.log("\nAccountFactoryV3 and the PersonalAccountV3 implementation on the test fork:");
    const custodyV3 = await deployCustodyV3Local({
      quiet: true,
      fund: { tokenRegistry: fund.tokenRegistry, oracle: fund.oracle },
    });
    console.log(`${custodyV3.factory}\n${custodyV3.implementation}`);
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
