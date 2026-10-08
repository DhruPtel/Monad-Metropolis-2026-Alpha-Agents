// @ts-check
// pnpm deploy:canary: P2-EC part 2's throwaway mainnet canary of the trading
// contracts (D-250 to D-252), in the unit's order: CanaryAgent, then the
// oracle adapter over the real Chainlink feeds, the Executor, the v4 adapter
// on the launch pool (active) and the v3 adapter on SwapRouter02 (paused),
// ProtocolRegistry and AccountFactory (caps 10 USDC, only the canary owner on
// the allowlist), the Executor's binding and the state assertions (in the
// forge scripts). Every salt carries the p2ec.canary scope (D-249). Each
// step finds what an earlier run deployed, so a rerun after a failure is
// safe. The chain is checked as 143 before each step, the mainnet facts are
// re-checked first, and the spend is held to the canary's budget (D-316).
// Writes evidence/p2-ec/canary-deployment.json. Prints no key and no RPC URL.
//
//   CANARY_SIGNING_ENABLED=true pnpm deploy:canary            deploy (or find) everything
//   CANARY_SIGNING_ENABLED=true pnpm deploy:canary --dry-run  simulate step 1 against mainnet, sending nothing
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, MONAD_MAINNET_CHAIN_ID } from "@alpha-agents/config";
import { UNISWAP_V4_MON_USDC_POOL } from "@alpha-agents/domain";
import {
  CANARY_LIMITS,
  CANARY_SCOPE,
  addressLink,
  assertMainnet,
  canaryBook,
  canaryConfig,
  canaryReveal,
  checkMainnetFacts,
  mainnetRpc,
  mon,
  spentWei,
  txLink,
} from "./lib/canary.js";
import { loadRootEnv } from "./lib/config.js";
import { ROOT } from "./lib/paths.js";
import { addressOf, broadcastRecords, forgeScript, logged } from "./lib/testnet.js";

/** The most the deployment may spend; the run needs the rest of the 10 MON (D-316). */
const DEPLOY_BUDGET_WEI = 4_000_000_000_000_000_000n;

const dryRun = process.argv.includes("--dry-run");
loadRootEnv();

let config;
try {
  config = canaryConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const url = /** @type {import("@alpha-agents/config").Secret} */ (config.rpcUrl).reveal();
const ownerKey = canaryReveal(config, "CANARY_OWNER_PRIVATE_KEY");
const roles = {
  owner: addressOf(ownerKey),
  guardian: addressOf(canaryReveal(config, "CANARY_GUARDIAN_PRIVATE_KEY")),
  session: addressOf(canaryReveal(config, "CANARY_SESSION_PRIVATE_KEY")),
};
const secrets = [ownerKey];
const keys = [roles.owner, roles.guardian, roles.session];

try {
  await assertMainnet(url);
  console.log("Re-checking the mainnet facts the canary relies on (D-248)");
  const facts = await checkMainnetFacts(url);
  console.log(
    `   all as recorded at block ${facts.block}; MON/USD ${/** @type {any} */ (facts.chainlink_mon_usd).ageSeconds} s old, USDC/USD ${/** @type {any} */ (facts.chainlink_usdc_usd).ageSeconds} s old`,
  );
  const startBlock = Number(await mainnetRpc(url, "eth_blockNumber"));
  let startWei = 0n;
  for (const k of keys) startWei += BigInt(await mainnetRpc(url, "eth_getBalance", [k, "latest"]));
  const ownerWei = BigInt(await mainnetRpc(url, "eth_getBalance", [roles.owner, "latest"]));
  console.log(
    `Monad mainnet (143) at block ${startBlock}; the canary owner ${roles.owner} holds ${mon(ownerWei)}`,
  );
  const common = { url, secrets, broadcast: !dryRun, scope: CANARY_SCOPE };
  const env = { DEPLOYER_PRIVATE_KEY: ownerKey, CANARY_SIGNING_ENABLED: "true" };

  console.log("\n1. CanaryAgent (D-250), owned by the canary owner");
  await assertMainnet(url);
  const agentOut = forgeScript("script/DeployCanaryAgent.s.sol:DeployCanaryAgent", {
    ...common,
    env: { ...env, CANARY_AGENT_OWNER: roles.owner },
  });
  const canaryAgent = logged(agentOut, "CANARY_AGENT_ADDRESS");
  if (dryRun && (await mainnetRpc(url, "eth_getCode", [canaryAgent, "latest"])) === "0x") {
    console.log(
      "\ndry run: step 2 needs CanaryAgent on chain, so it is not simulated here (pnpm test:canary-fork runs both); nothing was sent",
    );
    process.exit(0);
  }
  const afterAgent = await spentWei(url, keys, startWei);
  if (afterAgent > DEPLOY_BUDGET_WEI)
    throw new Error(`step 1 spent ${mon(afterAgent)}, over the deployment budget; stopping`);

  console.log(
    "\n2. The oracle adapter, Executor, v4 and v3 adapters, ProtocolRegistry and AccountFactory",
  );
  await assertMainnet(url);
  const custodyOut = forgeScript("script/DeployAccountFactory.s.sol:DeployAccountFactory", {
    ...common,
    env: {
      ...env,
      ACCOUNT_FACTORY_ADMIN: roles.owner,
      ACCOUNT_FACTORY_GUARDIAN: roles.guardian,
      ACCOUNT_FACTORY_SENTINEL: "0x0000000000000000000000000000000000000000",
      ACCOUNT_FACTORY_AGENT_NFT: canaryAgent,
      ACCOUNT_FACTORY_USDC: canaryBook("usdc"),
      ACCOUNT_FACTORY_WMON: canaryBook("wmon"),
      ACCOUNT_FACTORY_PERSONAL_CAP: CANARY_LIMITS.capE6.toString(),
      ACCOUNT_FACTORY_PLATFORM_CAP: CANARY_LIMITS.capE6.toString(),
      ACCOUNT_FACTORY_ALLOWLIST: roles.owner,
      ORACLE_MON_USD_FEED: canaryBook("chainlink_mon_usd"),
      ORACLE_USDC_USD_FEED: canaryBook("chainlink_usdc_usd"),
      ORACLE_STATE_VIEW: canaryBook("uniswap_v4_state_view"),
      ORACLE_POOL_ID: UNISWAP_V4_MON_USDC_POOL.id,
      VENUE_POOL_MANAGER: canaryBook("uniswap_v4_pool_manager"),
      VENUE_V3_ROUTER: canaryBook("uniswap_v3_swap_router02"),
    },
  });
  const custody = {
    oracleAdapter: logged(custodyOut, "ORACLE_ADAPTER_ADDRESS"),
    executor: logged(custodyOut, "EXECUTOR_ADDRESS"),
    protocolRegistry: logged(custodyOut, "PROTOCOL_REGISTRY_ADDRESS"),
    venueV4: logged(custodyOut, "VENUE_V4_ADDRESS"),
    venueV3: logged(custodyOut, "VENUE_V3_ADDRESS"),
    accountFactory: logged(custodyOut, "ACCOUNT_FACTORY_ADDRESS"),
    personalAccountImplementation: logged(custodyOut, "PERSONAL_ACCOUNT_IMPLEMENTATION"),
  };
  if (dryRun) {
    console.log("\ndry run: nothing was sent");
    process.exit(0);
  }

  const transactions = [
    ...(await broadcastRecords(url, "DeployCanaryAgent.s.sol", MONAD_MAINNET_CHAIN_ID)),
    ...(await broadcastRecords(url, "DeployAccountFactory.s.sol", MONAD_MAINNET_CHAIN_ID)),
  ]
    .filter((t) => t.block >= startBlock)
    .map((t) => ({ ...t, link: txLink(t.hash) }));
  const spent = await spentWei(url, keys, startWei);
  const record = {
    unit: "P2-EC part 2",
    chainId: MONAD_MAINNET_CHAIN_ID,
    label: "mainnet-canary, throwaway (D-247, D-249, D-250)",
    saltScope: CANARY_SCOPE,
    recordedAt: new Date().toISOString(),
    roles,
    allowlist: [roles.owner],
    capsE6: { personal: CANARY_LIMITS.capE6.toString(), platform: CANARY_LIMITS.capE6.toString() },
    facts,
    canaryAgent,
    custody,
    links: Object.fromEntries(
      Object.entries({ canaryAgent, ...custody }).map(([k, a]) => [k, addressLink(a)]),
    ),
    transactions,
    spentWei: spent.toString(),
  };
  const dir = join(ROOT, "evidence/p2-ec");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "canary-deployment.json");
  if (transactions.length > 0) writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\n${transactions.length} transactions; the canary keys spent ${mon(spent)}`);
  for (const t of transactions) console.log(`   ${t.what.padEnd(26)} ${t.link}`);
  console.log(
    `CanaryAgent ${canaryAgent}\nAccountFactory ${custody.accountFactory}\nExecutor ${custody.executor}`,
  );
  if (transactions.length > 0) console.log(`recorded in ${file}`);
  if (spent > DEPLOY_BUDGET_WEI) throw new Error(`the deployment spent ${mon(spent)}, over budget`);
} catch (err) {
  console.error(
    `error: ${(err instanceof Error ? err.message : String(err)).replaceAll(url, "<rpc>")}`,
  );
  process.exit(1);
}
