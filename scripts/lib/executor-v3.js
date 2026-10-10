// @ts-check
// Executor v3 and the set it trades through (F-U4): the Executor, its
// RouteAdapter and a ProtocolRegistryV3 listing it from construction, an
// OracleAdapterV3 over that registry, AccountFactoryV3 deployed again with the
// Executor and the oracle given, and the binding (D-361, D-363). Local forks
// only: no unit has authorized a testnet or mainnet deployment. Every address
// follows from the arguments (CREATE2, and CREATE from a CREATE2-deployed
// ExecutorSetDeployer), so running it again finds the same contracts.
import { assertLocalFork, rpc } from "@alpha-agents/devenv";
import { CORE_LANE_CANDIDATES, addressEntry } from "@alpha-agents/domain";
import {
  LOCAL_DEPLOY_ATTEMPTS,
  deployLocal as deployAgentNftLocal,
  isTransientForkError,
} from "./agent-nft.js";
import { ANVIL_URL } from "./config.js";
import { deployCustodyV3Local } from "./custody-v3.js";
import { FUND_ROLES, feeArgs, fundConfig, runForge } from "./fund.js";

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

const redact = (/** @type {string} */ s) =>
  s
    .split("\n")
    .filter((l) => !/private.?key/i.test(l))
    .join("\n")
    .replace(/https?:\/\/(?!127\.0\.0\.1)\S+/g, "[url]");

/**
 * Runs one deploy script with the fork's gas price, retrying a transient fork error.
 * @param {string} url @param {string} target @param {Record<string, string>} env
 */
async function script(url, target, env) {
  const args = [
    "script",
    target,
    "--broadcast",
    "--rpc-url",
    url,
    "--unlocked",
    "--sender",
    FUND_ROLES.admin,
    ...(await feeArgs(url)),
  ];
  for (let attempt = 1; ; attempt++) {
    // Async (L-109): a process that drains a fork's log must never block on forge.
    const r = await runForge(args, env);
    if (r.status === 0) return r.output;
    if (attempt < LOCAL_DEPLOY_ATTEMPTS && isTransientForkError(r.output)) {
      console.log(
        `forge script hit a transient fork error; retrying (${attempt + 1} of ${LOCAL_DEPLOY_ATTEMPTS})`,
      );
      continue;
    }
    console.log(redact(r.output));
    throw new Error(`forge script failed: ${target}`);
  }
}

/** @param {string} output @param {string} name */
function found(output, name) {
  const a = new RegExp(`${name}\\s+(0x[0-9a-fA-F]{40})`).exec(output)?.[1];
  if (!a) throw new Error(`forge script did not report ${name}`);
  return /** @type {`0x${string}`} */ (a);
}

/** @param {string} output @param {string} name */
function size(output, name) {
  const n = new RegExp(`${name}\\s+(\\d+)`).exec(output)?.[1];
  if (!n) throw new Error(`forge script did not report ${name}`);
  return Number(n);
}

/**
 * Deploys Executor v3's set on the fork LOCAL_FORK_PORT names (D-200), or
 * finds it, then AccountFactoryV3 with the Executor given, then binds.
 * @param {{ url?: string, quiet?: boolean, tokenRegistry?: `0x${string}` }} [options]
 */
export async function deployExecutorV3Local(options = {}) {
  const url = options.url ?? ANVIL_URL;
  if (url !== ANVIL_URL)
    throw new Error(
      "deployExecutorV3Local deploys on the fork LOCAL_FORK_PORT names; set it before importing",
    );
  await assertLocalFork(url);
  const agentNft = /** @type {`0x${string}`} */ (await deployAgentNftLocal({ quiet: true }));
  const tokenRegistry = options.tokenRegistry ?? verified("token_registry_v3");
  if (!(await hasCode(url, tokenRegistry)))
    throw new Error(
      `the TokenRegistry ${tokenRegistry} has no code on this fork; run pnpm deploy:fund first`,
    );
  // Every candidate pool; the script keeps those whose tokens the registry lists.
  const config = fundConfig(CORE_LANE_CANDIDATES.map((c) => c.address));
  const out = await script(url, "script/DeployExecutorV3.s.sol:DeployExecutorV3", {
    FUND_CONFIG: JSON.stringify(config),
    EXECUTOR_V3_TOKEN_REGISTRY: tokenRegistry,
    EXECUTOR_V3_AGENT_NFT: agentNft,
  });
  const set = {
    executor: found(out, "EXECUTOR_V3_ADDRESS"),
    routeAdapter: found(out, "EXECUTOR_ROUTE_ADAPTER_V3_ADDRESS"),
    protocolRegistry: found(out, "PROTOCOL_REGISTRY_V3_ADDRESS"),
    oracle: found(out, "ORACLE_ADAPTER_V3_ADDRESS"),
    setDeployer: found(out, "EXECUTOR_SET_DEPLOYER_ADDRESS"),
    sizes: {
      executor: size(out, "EXECUTOR_V3_CODE_SIZE"),
      routeAdapter: size(out, "EXECUTOR_ROUTE_ADAPTER_V3_CODE_SIZE"),
      protocolRegistry: size(out, "PROTOCOL_REGISTRY_V3_CODE_SIZE"),
      oracle: size(out, "ORACLE_ADAPTER_V3_CODE_SIZE"),
    },
    corePools: size(out, "CORE_POOLS"),
    policyHash: /** @type {`0x${string}`} */ (
      /EXECUTOR_V3_POLICY_HASH\s+(0x[0-9a-fA-F]{64})/.exec(out)?.[1] ?? "0x"
    ),
    leftOut: out.split("\n").filter((l) => l.includes("POOL_LEFT_OUT")).length,
  };
  const custody = await deployCustodyV3Local({
    fund: { tokenRegistry, oracle: set.oracle },
    executor: set.executor,
    quiet: true,
  });
  const bound = await script(url, "script/BindExecutorV3.s.sol:BindExecutorV3", {
    EXECUTOR_V3: set.executor,
    EXECUTOR_V3_FACTORY: custody.factory,
    EXECUTOR_V3_POOLS: set.protocolRegistry,
  });
  if (found(bound, "EXECUTOR_V3_BOUND_FACTORY").toLowerCase() !== custody.factory.toLowerCase())
    throw new Error("Executor v3 is bound to another factory");
  const result = {
    ...set,
    factory: custody.factory,
    implementation: custody.implementation,
    tokenRegistry,
  };
  if (options.quiet) return result;
  console.log(`\nExecutor v3 on the local fork: ${result.executor}`);
  console.log(`its RouteAdapter (registered, active): ${result.routeAdapter}`);
  console.log(
    `ProtocolRegistryV3 (${result.corePools} core pools${result.leftOut ? `, ${result.leftOut} left out` : ""}): ${result.protocolRegistry}`,
  );
  console.log(`OracleAdapterV3 over it: ${result.oracle}`);
  console.log(`AccountFactoryV3 with the Executor given: ${result.factory}`);
  console.log(`PersonalAccountV3 implementation: ${result.implementation}`);
  console.log(`TokenRegistry (existing): ${tokenRegistry}`);
  console.log(`policy hash: ${result.policyHash}`);
  console.log(
    `admin ${FUND_ROLES.admin} (anvil account 0), guardian ${FUND_ROLES.guardian} (anvil account 4)`,
  );
  return result;
}
