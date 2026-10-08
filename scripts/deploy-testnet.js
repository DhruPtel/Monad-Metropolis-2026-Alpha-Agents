// @ts-check
// pnpm deploy:testnet: P2-EC part 1's throwaway deployment to Monad testnet,
// in the unit's order: the TestnetFeeds, the P2-EC pool (seeded once),
// AgentNFT, the oracle adapter, the Executor, the v4 adapter, ProtocolRegistry
// and AccountFactory, then the Executor's binding and the state assertions
// (in the forge scripts). Every salt carries the p2ec.testnet scope (D-249).
// Each step finds what an earlier run deployed, so a rerun after a failure is
// safe. Writes evidence/p2-ec/deployment.json: addresses, transactions, gas
// limit and gas used, and MON paid. Prints no key and no RPC URL.
//
//   pnpm deploy:testnet            deploy (or find) everything
//   pnpm deploy:testnet --dry-run  simulate against testnet, sending nothing
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "@alpha-agents/config";
import { loadRootEnv } from "./lib/config.js";
import { ROOT } from "./lib/paths.js";
import {
  SALT_SCOPE,
  SEED,
  TESTNET,
  addressOf,
  assertTestnet,
  broadcastRecords,
  forgeScript,
  logged,
  loggedBytes32,
  reveal,
  testnetConfig,
  testnetRpc,
} from "./lib/testnet.js";

/** The owner's playtest wallets (the local mint allowlist's "playtest" entries), for D-303. */
export const OWNER_PLAYTEST_WALLETS = [
  "0x683ee842a16f85e69883f433745263bfe8d55f76",
  "0x32838fe90541567bbf77fa0570661f3c20e2b152",
  "0xc8821706961bcac0e95441308083644eff444871",
];

const dryRun = process.argv.includes("--dry-run");
loadRootEnv();

let config;
try {
  config = testnetConfig([
    "TESTNET_DEPLOYER_PRIVATE_KEY",
    "TESTNET_GUARDIAN_PRIVATE_KEY",
    "TESTNET_SENTINEL_PRIVATE_KEY",
    "TESTNET_CLAIM_SIGNER_PRIVATE_KEY",
    "TESTNET_FEED_PRIVATE_KEY",
    "TESTNET_TEST_WALLET_PRIVATE_KEY",
  ]);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const url = /** @type {import("@alpha-agents/config").Secret} */ (config.rpcUrl).reveal();
const deployerKey = reveal(config, "TESTNET_DEPLOYER_PRIVATE_KEY");
const secrets = [deployerKey];
const deployer = addressOf(deployerKey);
const roles = {
  deployer,
  admin: deployer,
  guardian: addressOf(reveal(config, "TESTNET_GUARDIAN_PRIVATE_KEY")),
  sentinel: addressOf(reveal(config, "TESTNET_SENTINEL_PRIVATE_KEY")),
  claimSigner: addressOf(reveal(config, "TESTNET_CLAIM_SIGNER_PRIVATE_KEY")),
  feedWriter: addressOf(reveal(config, "TESTNET_FEED_PRIVATE_KEY")),
  testWallet: addressOf(reveal(config, "TESTNET_TEST_WALLET_PRIVATE_KEY")),
};
const allowlist = [roles.testWallet, ...OWNER_PLAYTEST_WALLETS];

try {
  await assertTestnet(url);
  const startBlock = Number(await testnetRpc(url, "eth_blockNumber"));
  const balanceBefore = BigInt(await testnetRpc(url, "eth_getBalance", [deployer, "latest"]));
  console.log(
    `Monad testnet (10143) at block ${startBlock}; deployer ${deployer} holds ${Number(balanceBefore) / 1e18} MON`,
  );
  const common = { url, secrets, broadcast: !dryRun };
  const keyEnv = { DEPLOYER_PRIVATE_KEY: deployerKey };

  console.log("\n1. TestnetFeeds, the pool seeder and the P2-EC pool");
  const marketOut = forgeScript("script/DeployTestnetMarket.s.sol:DeployTestnetMarket", {
    ...common,
    env: {
      ...keyEnv,
      TESTNET_FEED_WRITER: roles.feedWriter,
      TESTNET_USDC: TESTNET.usdc,
      TESTNET_POOL_MANAGER: TESTNET.poolManager,
      TESTNET_STATE_VIEW: TESTNET.stateView,
      SEED_MON_WEI: SEED.monWei.toString(),
      SEED_USDC_RAW: SEED.usdcRaw.toString(),
      SEED_LIQUIDITY: SEED.liquidity.toString(),
      SEED_TICK_LOWER: String(SEED.tickLower),
      SEED_TICK_UPPER: String(SEED.tickUpper),
    },
  });
  const market = {
    monUsdFeed: logged(marketOut, "TESTNET_FEED_MON_USD_ADDRESS"),
    usdcUsdFeed: logged(marketOut, "TESTNET_FEED_USDC_USD_ADDRESS"),
    seeder: logged(marketOut, "POOL_SEEDER_ADDRESS"),
    poolId: loggedBytes32(marketOut, "POOL_ID"),
    poolTick: Number(logged(marketOut, "POOL_TICK")),
    poolLiquidity: logged(marketOut, "POOL_LIQUIDITY"),
  };

  console.log("\n2. AgentNFT");
  const nftOut = forgeScript("script/DeployAgentNFT.s.sol:DeployAgentNFT", {
    ...common,
    env: {
      ...keyEnv,
      AGENT_NFT_ADMIN: roles.admin,
      AGENT_NFT_CLAIM_SIGNER: roles.claimSigner,
      AGENT_NFT_TREASURY: roles.admin,
      AGENT_NFT_IMAGE_BASE_URI: "ipfs://alpha-agents-images-pending/",
      AGENT_NFT_ENTROPY: TESTNET.entropy,
    },
  });
  const agentNft = logged(nftOut, "AGENT_NFT_ADDRESS");
  if (dryRun && (await testnetRpc(url, "eth_getCode", [agentNft, "latest"])) === "0x") {
    console.log(
      "\ndry run: step 3 needs AgentNFT on chain, so it is not simulated here (pnpm test:testnet-fork runs all three); nothing was sent",
    );
    process.exit(0);
  }

  console.log("\n3. The oracle adapter, Executor, v4 adapter, ProtocolRegistry and AccountFactory");
  const custodyOut = forgeScript("script/DeployAccountFactory.s.sol:DeployAccountFactory", {
    ...common,
    env: {
      ...keyEnv,
      ACCOUNT_FACTORY_ADMIN: roles.admin,
      ACCOUNT_FACTORY_GUARDIAN: roles.guardian,
      ACCOUNT_FACTORY_SENTINEL: roles.sentinel,
      ACCOUNT_FACTORY_AGENT_NFT: agentNft,
      ACCOUNT_FACTORY_USDC: TESTNET.usdc,
      ACCOUNT_FACTORY_WMON: TESTNET.wmon,
      ACCOUNT_FACTORY_PERSONAL_CAP: "100000000",
      ACCOUNT_FACTORY_PLATFORM_CAP: "2000000000",
      ACCOUNT_FACTORY_ALLOWLIST: allowlist.join(","),
      ORACLE_MON_USD_FEED: market.monUsdFeed,
      ORACLE_USDC_USD_FEED: market.usdcUsdFeed,
      ORACLE_STATE_VIEW: TESTNET.stateView,
      ORACLE_POOL_ID: market.poolId,
      VENUE_POOL_MANAGER: TESTNET.poolManager,
      VENUE_V3_ROUTER: "0x0000000000000000000000000000000000000000",
    },
  });
  const custody = {
    oracleAdapter: logged(custodyOut, "ORACLE_ADAPTER_ADDRESS"),
    executor: logged(custodyOut, "EXECUTOR_ADDRESS"),
    protocolRegistry: logged(custodyOut, "PROTOCOL_REGISTRY_ADDRESS"),
    venueV4: logged(custodyOut, "VENUE_V4_ADDRESS"),
    accountFactory: logged(custodyOut, "ACCOUNT_FACTORY_ADDRESS"),
    personalAccountImplementation: logged(custodyOut, "PERSONAL_ACCOUNT_IMPLEMENTATION"),
  };
  if (dryRun) {
    console.log("\ndry run: nothing was sent");
    process.exit(0);
  }

  const transactions = [
    ...(await broadcastRecords(url, "DeployTestnetMarket.s.sol")),
    ...(await broadcastRecords(url, "DeployAgentNFT.s.sol")),
    ...(await broadcastRecords(url, "DeployAccountFactory.s.sol")),
  ].filter((t) => t.block >= startBlock);
  const balanceAfter = BigInt(await testnetRpc(url, "eth_getBalance", [deployer, "latest"]));
  const record = {
    unit: "P2-EC part 1",
    chainId: TESTNET.chainId,
    label: "testnet, throwaway (D-247, D-249)",
    saltScope: SALT_SCOPE,
    recordedAt: new Date().toISOString(),
    roles,
    allowlist,
    market: {
      ...market,
      seed: {
        ...SEED,
        monWei: SEED.monWei.toString(),
        usdcRaw: SEED.usdcRaw.toString(),
        liquidity: SEED.liquidity.toString(),
      },
    },
    agentNft,
    custody,
    transactions,
    deployerMonSpentWei: (balanceBefore - balanceAfter).toString(),
  };
  const dir = join(ROOT, "evidence/p2-ec");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "deployment.json");
  // A rerun that sends nothing keeps the first run's transactions.
  if (transactions.length > 0) writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    `\n${transactions.length} transactions; the deployer spent ${Number(balanceBefore - balanceAfter) / 1e18} MON`,
  );
  console.log(
    `AgentNFT ${agentNft}\nAccountFactory ${custody.accountFactory}\nExecutor ${custody.executor}`,
  );
  if (transactions.length > 0) console.log(`recorded in ${file}`);
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
