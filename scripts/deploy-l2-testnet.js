// @ts-check
// pnpm deploy:l2 base-sepolia | arbitrum-sepolia (CO-U1): the fund agent's trading set on an L2
// testnet, personal accounts only (no vault), in this order: the market (TestUSDC, the agents'
// copy NFT, one WETH/tUSDC Uniswap v3 pool at Chainlink's ETH/USD price with liquidity around
// it), the fund set (TokenRegistry with tUSDC and WETH as class F on Chainlink's feeds, the
// ProtocolRegistryV3 with the pool, OracleAdapterV3, a RouteAdapter), Executor v3 and its set,
// AccountFactoryV3 with the PersonalAccountV3 implementation, and the Executor's binding. Every
// step is simulated first and stops, naming what to send, when the deployer cannot cover it. A
// rerun finds what an earlier one deployed. Writes evidence/co-u1/<chain>-deployment.json and
// the address book's data file. Prints no key and no RPC URL.
//
//   pnpm deploy:l2 base-sepolia [--dry-run]
const chainKey = process.argv[2] ?? "";
if (chainKey !== "base-sepolia" && chainKey !== "arbitrum-sepolia") {
  console.error("usage: pnpm deploy:l2 base-sepolia | arbitrum-sepolia [--dry-run]");
  process.exit(2);
}
process.env.TESTNET_CHAIN = chainKey;
process.env.FOUNDRY_PROFILE = "l2";
const { mkdirSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { ConfigError } = await import("@alpha-agents/config");
const { FUND_VENUE } = await import("@alpha-agents/domain");
const { loadRootEnv } = await import("./lib/config.js");
const { ROOT } = await import("./lib/paths.js");
const {
  OWNER_PLAYTEST_WALLETS,
  TESTNET,
  addressOf,
  assertTestnet,
  forgeScript,
  logged,
  loggedBytes32,
  reveal,
  testnetConfig,
  testnetRpc,
} = await import("./lib/testnet.js");

/** The chain's own contracts, from Uniswap's, Chainlink's and Pyth's deployment lists (checked on 2026-10-14). */
const CHAINS = {
  "base-sepolia": {
    weth: "0x4200000000000000000000000000000000000006",
    ethUsdFeed: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
    usdcUsdFeed: "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165",
    uniswapV3Factory: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    swapRouter02: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
    quoterV2: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
    positionManager: "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2",
    entropy: "0x41c9e39574F40Ad34c79f1C99B66A45eFB830d4c",
  },
  "arbitrum-sepolia": {
    weth: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
    ethUsdFeed: "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165",
    usdcUsdFeed: "0x0153002d20B96532C639313c2d54c3dA09109309",
    uniswapV3Factory: "0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e",
    swapRouter02: "0x101F443B4d1b059569D643917553c771E1b9663E",
    quoterV2: "0x2779a0CC1c3e0E44D2542EC3e79e3864Ae93Ef0B",
    positionManager: "0x6b2937Bde17889EDCf8fbD8dE31C3C2a70Bc4d65",
    entropy: "0x549Ebba8036Ab746611B4fFA1423eb0A4Df61440",
  },
};
const chain = CHAINS[chainKey];
/** The Monad testnet custody caps (USDC base units): 100 per personal account, 2,000 across the platform. */
const CAPS = { personalE6: 100_000_000n, vaultE6: 0n, platformE6: 2_000_000_000n };
/** Chainlink's testnet feeds update on deviation with a day's heartbeat at most. */
const FEED_MAX_AGE = 86_400;
/** ETH wrapped into the pool: about 100 USDC of depth in a ±2.5% range. */
const POOL_WETH_WEI = 40_000_000_000_000_000n;
const dryRun = process.argv.includes("--dry-run");
const CO_SCOPE = "co.testnet";

loadRootEnv();
let config;
try {
  config = testnetConfig([
    "TESTNET_DEPLOYER_PRIVATE_KEY",
    "TESTNET_GUARDIAN_PRIVATE_KEY",
    "TESTNET_SENTINEL_PRIVATE_KEY",
    "TESTNET_SCREENER_PRIVATE_KEY",
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
  admin: deployer,
  guardian: addressOf(reveal(config, "TESTNET_GUARDIAN_PRIVATE_KEY")),
  sentinel: addressOf(reveal(config, "TESTNET_SENTINEL_PRIVATE_KEY")),
  screener: addressOf(reveal(config, "TESTNET_SCREENER_PRIVATE_KEY")),
  testWallet: addressOf(reveal(config, "TESTNET_TEST_WALLET_PRIVATE_KEY")),
};
const keyEnv = { DEPLOYER_PRIVATE_KEY: deployerKey };

/** @param {string} output */
function estimate(output) {
  const gas = /Estimated total gas used for script: (\d+)/.exec(output)?.[1];
  const eth = /Estimated amount required: ([\d.]+) ETH/.exec(output)?.[1];
  return gas ? { gas: Number(gas), eth: Number(eth ?? 0) } : null;
}

/** Simulates, checks the deployer covers forge's estimate (plus what it sends), then broadcasts. */
async function step(
  /** @type {string} */ name,
  /** @type {string} */ script,
  /** @type {Record<string, string>} */ env,
  sendsWei = 0n,
) {
  const o = { url, secrets, env, scope: CO_SCOPE };
  const simulated = forgeScript(script, { ...o, broadcast: false });
  const e = estimate(simulated);
  if (!e || dryRun) return simulated;
  const balance = Number(await testnetRpc(url, "eth_getBalance", [deployer, "latest"])) / 1e18;
  const need = e.eth + Number(sendsWei) / 1e18;
  if (balance < need) {
    console.error(
      `error: ${name} needs about ${need.toFixed(5)} ETH and the deployer ${deployer} holds ${balance.toFixed(5)} ETH: send at least ${(need - balance + 0.005).toFixed(4)} ETH to ${deployer} on ${chainKey} and run pnpm deploy:l2 ${chainKey} again; every step so far stands`,
    );
    process.exit(1);
  }
  console.log(
    `   ${name}: about ${need.toFixed(5)} ETH; the deployer holds ${balance.toFixed(5)} ETH`,
  );
  return forgeScript(script, { ...o, broadcast: true });
}

await assertTestnet(url);
const startBlock = Number(await testnetRpc(url, "eth_blockNumber"));
console.log(`${chainKey} (chain ${TESTNET.chainId}) at block ${startBlock}; deployer ${deployer}`);

// A rerun finds the pool seeded already: only an empty pool takes the ETH wrapped for it.
const { existsSync, readFileSync } = await import("node:fs");
const recordPath = join(ROOT, `evidence/co-u1/${chainKey}-deployment.json`);
let poolSeeded = false;
if (existsSync(recordPath)) {
  const pool = JSON.parse(readFileSync(recordPath, "utf8")).contracts?.uniswap_v3_pool_usdc_weth_500
    ?.address;
  if (pool) {
    // liquidity() is 0x1a686502.
    const liq = await testnetRpc(url, "eth_call", [{ to: pool, data: "0x1a686502" }, "latest"]);
    poolSeeded = BigInt(liq ?? "0x0") > 0n;
  }
}

console.log("\n1. TestUSDC, the agents' copy NFT and the WETH/tUSDC pool");
const marketOut = await step(
  "1 market",
  "script/DeployL2Market.s.sol:DeployL2Market",
  {
    ...keyEnv,
    L2_WETH: chain.weth,
    L2_ETH_USD_FEED: chain.ethUsdFeed,
    L2_UNISWAP_V3_FACTORY: chain.uniswapV3Factory,
    L2_POSITION_MANAGER: chain.positionManager,
    L2_COPY_MINTER: deployer,
    L2_COPY_IMAGE_BASE_URI: "https://vivarium-testnet.vercel.app/species/",
    L2_POOL_WETH: POOL_WETH_WEI.toString(),
    // CO-U1: a fresh AgentCopyNFT (and the sets bound to it) under a new salt version, e.g. to
    // mirror the clean Monad AgentNFT's agents; TestUSDC and the pool are found again.
    L2_COPY_SALT_VERSION: process.env.L2_COPY_SALT_VERSION?.trim() || "1",
  },
  poolSeeded ? 0n : POOL_WETH_WEI,
);
const market = {
  usdc: logged(marketOut, "TEST_USDC_ADDRESS"),
  agentNft: logged(marketOut, "AGENT_COPY_NFT_ADDRESS"),
  pool: logged(marketOut, "POOL_ADDRESS"),
  token0: logged(marketOut, "POOL_TOKEN0"),
  token1: logged(marketOut, "POOL_TOKEN1"),
};
console.log(`   tUSDC ${market.usdc}, AgentCopyNFT ${market.agentNft}, pool ${market.pool}`);
if (dryRun && !/^0x[0-9a-fA-F]{40}$/.test(market.pool)) {
  console.log("dry run: the market is not on chain yet, so the later steps cannot be simulated");
  process.exit(0);
}

const fund = {
  admin: roles.admin,
  guardian: roles.guardian,
  screener: roles.screener,
  usdc: market.usdc.toLowerCase(),
  wmon: chain.weth.toLowerCase(),
  uniswapV3Factory: chain.uniswapV3Factory,
  // No PancakeSwap and no Uniswap v4 here: the CREATE2 deployer (code on every chain) stands in,
  // as on Monad testnet, and no pool of theirs is ever listed.
  pancakeswapV3Factory: TESTNET.create2Deployer,
  poolManager: TESTNET.create2Deployer,
  stateView: TESTNET.create2Deployer,
  demoExecutor: deployer,
  // CO-U1: 5% between the pool and Chainlink, since nothing arbitrages a testnet pool.
  maxDeviationBps: 500,
  seeds: [
    {
      token: market.usdc.toLowerCase(),
      maxPositionBps: 10_000,
      usdFeed: chain.usdcUsdFeed,
      usdDecimals: 8,
      usdMaxAge: FEED_MAX_AGE,
      rateFeed: "0x0000000000000000000000000000000000000000",
      rateDecimals: 0,
      rateMaxAge: 0,
    },
    {
      token: chain.weth.toLowerCase(),
      maxPositionBps: 6_000,
      usdFeed: chain.ethUsdFeed,
      usdDecimals: 8,
      usdMaxAge: FEED_MAX_AGE,
      rateFeed: "0x0000000000000000000000000000000000000000",
      rateDecimals: 0,
      rateMaxAge: 0,
    },
  ],
  pools: [
    {
      venue: FUND_VENUE.UNISWAP_V3,
      token0: market.token0.toLowerCase(),
      token1: market.token1.toLowerCase(),
      fee: 500,
      tickSpacing: 10,
      pool: market.pool.toLowerCase(),
    },
  ],
};

console.log("\n2. The fund set: TokenRegistry, ProtocolRegistryV3, OracleAdapterV3, RouteAdapter");
const fundOut = await step("2 fund set", "script/DeployFund.s.sol:DeployFund", {
  ...keyEnv,
  FUND_CONFIG: JSON.stringify(fund),
});
const fundSet = {
  tokenRegistry: logged(fundOut, "TOKEN_REGISTRY_ADDRESS"),
  protocolRegistry: logged(fundOut, "PROTOCOL_REGISTRY_V3_ADDRESS"),
  oracle: logged(fundOut, "ORACLE_ADAPTER_V3_ADDRESS"),
  routeAdapter: logged(fundOut, "ROUTE_ADAPTER_ADDRESS"),
};

console.log("\n3. Executor v3 and its set");
const execOut = await step("3 executor v3", "script/DeployExecutorV3.s.sol:DeployExecutorV3", {
  ...keyEnv,
  FUND_CONFIG: JSON.stringify(fund),
  EXECUTOR_V3_TOKEN_REGISTRY: fundSet.tokenRegistry,
  EXECUTOR_V3_AGENT_NFT: market.agentNft,
});
const executorSet = {
  executor: logged(execOut, "EXECUTOR_V3_ADDRESS"),
  routeAdapter: logged(execOut, "EXECUTOR_ROUTE_ADAPTER_V3_ADDRESS"),
  protocolRegistry: logged(execOut, "PROTOCOL_REGISTRY_V3_ADDRESS"),
  oracle: logged(execOut, "ORACLE_ADAPTER_V3_ADDRESS"),
  policyHash: loggedBytes32(execOut, "EXECUTOR_V3_POLICY_HASH"),
};

console.log("\n4. AccountFactoryV3 (personal accounts only) and the Executor's binding");
const custodyOut = await step("4 custody v3", "script/DeployCustodyV3.s.sol:DeployCustodyV3", {
  ...keyEnv,
  CUSTODY_V3_ADMIN: roles.admin,
  CUSTODY_V3_GUARDIAN: roles.guardian,
  CUSTODY_V3_SENTINEL: roles.sentinel,
  CUSTODY_V3_AGENT_NFT: market.agentNft,
  CUSTODY_V3_USDC: market.usdc,
  CUSTODY_V3_TOKEN_REGISTRY: fundSet.tokenRegistry,
  CUSTODY_V3_ORACLE: executorSet.oracle,
  CUSTODY_V3_EXECUTOR: executorSet.executor,
  CUSTODY_V3_PERSONAL_CAP: CAPS.personalE6.toString(),
  CUSTODY_V3_VAULT_CAP: CAPS.vaultE6.toString(),
  CUSTODY_V3_PLATFORM_CAP: CAPS.platformE6.toString(),
  CUSTODY_V3_DEPOSITS_ENABLED: "false",
  CUSTODY_V3_ALLOWLIST: [roles.testWallet, ...OWNER_PLAYTEST_WALLETS].join(","),
  CUSTODY_V3_VAULTS: "false",
});
const custody = {
  factory: logged(custodyOut, "ACCOUNT_FACTORY_V3_ADDRESS"),
  personalAccountImplementation: logged(custodyOut, "PERSONAL_ACCOUNT_V3_IMPLEMENTATION"),
};
const bindOut = await step("4 bind", "script/BindExecutorV3.s.sol:BindExecutorV3", {
  ...keyEnv,
  EXECUTOR_V3: executorSet.executor,
  EXECUTOR_V3_FACTORY: custody.factory,
  EXECUTOR_V3_POOLS: executorSet.protocolRegistry,
});
if (logged(bindOut, "EXECUTOR_V3_BOUND_FACTORY").toLowerCase() !== custody.factory.toLowerCase())
  throw new Error("Executor v3 is bound to another factory");

const endBlock = Number(await testnetRpc(url, "eth_blockNumber"));
/** @param {string} address */
const codeSize = async (address) =>
  ((await testnetRpc(url, "eth_getCode", [address, "latest"])).length - 2) / 2;
const deployed = {
  usdc: market.usdc,
  agent_nft: market.agentNft,
  uniswap_v3_pool_usdc_weth_500: market.pool,
  token_registry_v3: fundSet.tokenRegistry,
  route_adapter_v3: fundSet.routeAdapter,
  executor_v3: executorSet.executor,
  executor_route_adapter_v3: executorSet.routeAdapter,
  protocol_registry_v3: executorSet.protocolRegistry,
  oracle_adapter_v3: executorSet.oracle,
  account_factory_v3: custody.factory,
  personal_account_v3_implementation: custody.personalAccountImplementation,
};
/** @type {Record<string, { address: string, codeSize: number }>} */
const contracts = {};
for (const [id, address] of Object.entries(deployed))
  contracts[id] = { address, codeSize: await codeSize(address) };
const external = {
  wmon: chain.weth,
  chainlink_eth_usd: chain.ethUsdFeed,
  chainlink_usdc_usd: chain.usdcUsdFeed,
  uniswap_v3_factory: chain.uniswapV3Factory,
  uniswap_v3_swap_router02: chain.swapRouter02,
  uniswap_v3_quoter_v2: chain.quoterV2,
  uniswap_v3_position_manager: chain.positionManager,
  pyth_entropy: chain.entropy,
  create2_deployer: TESTNET.create2Deployer,
};
const record = {
  unit: "CO-U1",
  chain: chainKey,
  chainId: TESTNET.chainId,
  recordedAt: new Date().toISOString(),
  startBlock,
  endBlock,
  policyHash: executorSet.policyHash,
  contracts,
  external,
};
mkdirSync(join(ROOT, "evidence/co-u1"), { recursive: true });
writeFileSync(
  join(ROOT, `evidence/co-u1/${chainKey}-deployment.json`),
  `${JSON.stringify(record, null, 2)}\n`,
);
// The address book's data for this chain (packages/domain/src/deployments/index.ts reads it).
const bookPath = join(ROOT, `packages/domain/src/deployments/${chainKey}.ts`);
writeFileSync(
  bookPath,
  `// Written by pnpm deploy:l2 ${chainKey} (CO-U1); do not edit by hand.\nexport const DEPLOYMENT = ${JSON.stringify({ chainId: TESTNET.chainId, block: startBlock, contracts, external }, null, 2)} as const;\n`,
);
console.log(
  `\nrecorded in evidence/co-u1/${chainKey}-deployment.json and packages/domain/src/deployments/${chainKey}.ts (blocks ${startBlock} to ${endBlock})`,
);
