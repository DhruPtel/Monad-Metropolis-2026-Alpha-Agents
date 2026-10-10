// @ts-check
// AccountFactoryV3 deployment (F-U3): the local roles, caps and allowlist, the
// fund v3 set it binds to, and the call into
// chains/monad/script/DeployCustodyV3.s.sol. Local forks only: no unit has
// authorized a testnet or mainnet deployment of the custody core v3. The
// deployment is deterministic (CREATE2, fixed salt and arguments), so running
// it again finds the existing contract. The Executor is unset until F-U4,
// which deploys this factory again with Executor v3 given at deployment.
import { assertLocalFork, rpc } from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import { BETA_CAPS, CUSTODY_ROLES, LOCAL_TEST_OWNERS } from "./account-factory.js";
import {
  LOCAL_DEPLOY_ATTEMPTS,
  deployLocal as deployAgentNftLocal,
  isTransientForkError,
} from "./agent-nft.js";
import { ANVIL_URL } from "./config.js";
import { feeArgs, runForge } from "./fund.js";

const ZERO = "0x0000000000000000000000000000000000000000";

/** @param {import("@alpha-agents/domain").AddressBookId} id */
function verified(id) {
  const e = addressEntry("local", id);
  if (e.status !== "verified")
    throw new Error(`the address book has no verified ${id} for the local fork`);
  return e.address;
}

/** @param {string} url @param {string} address */
async function hasCode(url, address) {
  const code = await rpc(url, "eth_getCode", [address, "latest"]);
  return typeof code === "string" && code.length > 2;
}

/**
 * The fund v3 set the factory binds to: the caller's (a test fork's fresh
 * deployment), else the address book's local entries, which must have code on
 * the fork (the playtest fork after `pnpm deploy:fund`).
 * @param {string} url
 * @param {{ tokenRegistry: `0x${string}`, oracle: `0x${string}` } | undefined} given
 */
async function fundSet(url, given) {
  if (given) return given;
  const tokenRegistry = verified("token_registry_v3");
  const oracle = verified("oracle_adapter_v3");
  for (const e of [
    { id: "token_registry_v3", address: tokenRegistry },
    { id: "oracle_adapter_v3", address: oracle },
  ]) {
    if (!(await hasCode(url, e.address)))
      throw new Error(
        `the address book's ${e.id} (${e.address}) has no code on this fork; run pnpm deploy:fund first`,
      );
  }
  return { tokenRegistry, oracle };
}

const redact = (/** @type {string} */ s) =>
  s
    .split("\n")
    .filter((l) => !/private.?key/i.test(l))
    .join("\n")
    .replace(/https?:\/\/(?!127\.0\.0\.1)\S+/g, "[url]");

/**
 * Deploys AccountFactoryV3 (and its PersonalAccountV3 implementation), or
 * finds it, on the fork LOCAL_FORK_PORT names (D-200). AgentNFT is deployed
 * first if the fork has none.
 * @param {{ url?: string, quiet?: boolean, fund?: { tokenRegistry: `0x${string}`, oracle: `0x${string}` }, executor?: `0x${string}` }} [options]
 * @returns {Promise<{ factory: `0x${string}`, implementation: `0x${string}`, tokenRegistry: `0x${string}`, oracle: `0x${string}`, executor: `0x${string}` }>}
 */
export async function deployCustodyV3Local(options = {}) {
  const url = options.url ?? ANVIL_URL;
  if (url !== ANVIL_URL)
    throw new Error(
      "deployCustodyV3Local deploys on the fork LOCAL_FORK_PORT names; set it before importing",
    );
  await assertLocalFork(url);
  const agentNft = /** @type {`0x${string}`} */ (await deployAgentNftLocal({ quiet: true }));
  const fund = await fundSet(url, options.fund);
  const executor = options.executor ?? /** @type {`0x${string}`} */ (ZERO);
  const env = {
    CUSTODY_V3_ADMIN: CUSTODY_ROLES.admin,
    CUSTODY_V3_GUARDIAN: CUSTODY_ROLES.guardian,
    CUSTODY_V3_SENTINEL: CUSTODY_ROLES.sentinel,
    CUSTODY_V3_AGENT_NFT: agentNft,
    CUSTODY_V3_USDC: verified("usdc"),
    CUSTODY_V3_TOKEN_REGISTRY: fund.tokenRegistry,
    CUSTODY_V3_ORACLE: fund.oracle,
    CUSTODY_V3_EXECUTOR: executor,
    CUSTODY_V3_PERSONAL_CAP: BETA_CAPS.personalE6.toString(),
    CUSTODY_V3_PLATFORM_CAP: BETA_CAPS.platformE6.toString(),
    CUSTODY_V3_ALLOWLIST: LOCAL_TEST_OWNERS.join(","),
  };
  const args = [
    "script",
    "script/DeployCustodyV3.s.sol:DeployCustodyV3",
    "--broadcast",
    "--rpc-url",
    url,
    "--unlocked",
    "--sender",
    CUSTODY_ROLES.admin,
    ...(await feeArgs(url)),
  ];
  let output = "";
  for (let attempt = 1; ; attempt++) {
    // Async (L-109): a process that drains a fork's log must never block on forge.
    const r = await runForge(args, env);
    output = r.output;
    if (r.status === 0) break;
    if (attempt < LOCAL_DEPLOY_ATTEMPTS && isTransientForkError(output)) {
      console.log(
        `forge script hit a transient fork error; retrying (${attempt + 1} of ${LOCAL_DEPLOY_ATTEMPTS})`,
      );
      continue;
    }
    console.log(redact(output));
    throw new Error("forge script failed");
  }
  /** @param {string} name */
  const found = (name) => {
    const a = new RegExp(`${name}\\s+(0x[0-9a-fA-F]{40})`).exec(output)?.[1];
    if (!a) throw new Error(`forge script did not report ${name}`);
    return /** @type {`0x${string}`} */ (a);
  };
  const result = {
    factory: found("ACCOUNT_FACTORY_V3_ADDRESS"),
    implementation: found("PERSONAL_ACCOUNT_V3_IMPLEMENTATION"),
    tokenRegistry: fund.tokenRegistry,
    oracle: fund.oracle,
    executor,
  };
  if (options.quiet) return result;
  console.log(`\nAccountFactoryV3 on the local fork: ${result.factory}`);
  console.log(`PersonalAccountV3 implementation: ${result.implementation}`);
  console.log(`TokenRegistry (v3): ${fund.tokenRegistry}; OracleAdapterV3: ${fund.oracle}`);
  console.log(
    executor === ZERO
      ? "Executor: none until F-U4 deploys Executor v3 and this factory again with it"
      : `Executor: ${executor}`,
  );
  console.log(`admin ${CUSTODY_ROLES.admin} (anvil account 0)`);
  console.log(`guardian ${CUSTODY_ROLES.guardian} (anvil account 4)`);
  console.log(`sentinel key ${CUSTODY_ROLES.sentinel} (anvil account 5)`);
  console.log(
    "caps: 100 USDC per account, 2,000 USDC across the platform; allowlist: anvil accounts 6 to 9",
  );
  console.log("Try it: pnpm custody:v3:demo (on a fork of its own)");
  return result;
}
