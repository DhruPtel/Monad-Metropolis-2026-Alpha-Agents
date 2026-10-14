// @ts-check
// pnpm deploy:testnet:v3: F-U13's throwaway deployment of the whole current
// stack to Monad testnet, beside P2-EC's v2 set, in this order: the P2-EC
// market (found: the two TestnetFeeds, the pool seeder and the native
// MON/USDC pool), two more tokens with a feed and a seeded pool each, the new
// AgentNFT (34 species, 500/300/200, two mints per wallet), the fund set
// (TokenRegistry with USDC, WMON and the two tokens as class F, the
// ProtocolRegistryV3 with the three v4 pools, OracleAdapterV3, a
// RouteAdapter), Executor v3 and its set (the registered RouteAdapter and
// the ProtocolRegistryV3 it trades through, the OracleAdapterV3 over it),
// AccountFactoryV3 with the PersonalAccountV3 and StrategyVaultV3
// implementations, the Executor's binding, the attestation verifier, and the
// registry's SET_VERIFIER proposal (executable after the 9-day timelock,
// which a real chain never skips). Every salt carries the p2ec.testnet scope
// (D-249) at the sets' own versions, so nothing collides with P2-EC's v2
// contracts or with a later deployment's addresses. Each step finds what an
// earlier run deployed, so a rerun after a failure is safe. Writes
// evidence/f-u13/testnet-deployment.json. Prints no key and no RPC URL.
//
//   pnpm deploy:testnet:v3            deploy (or find) everything
//   pnpm deploy:testnet:v3 --dry-run  simulate the steps that need nothing on
//                                     chain yet, sending nothing; the whole
//                                     set is dry-run by pnpm test:testnet-fork
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "@alpha-agents/config";
import { FUND_VENUE, NATIVE_MON } from "@alpha-agents/domain";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadRootEnv } from "./lib/config.js";
import { ROOT } from "./lib/paths.js";
import {
  OWNER_PLAYTEST_WALLETS,
  SALT_SCOPE,
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

/** The P2-EC testnet market, found again: the seeder and the pool are the deployer's (evidence/p2-ec/ADDRESSES.md). */
const P2EC = JSON.parse(readFileSync(join(ROOT, "evidence/p2-ec/deployment.json"), "utf8"));
/** The two tokens' pools: 1 MON = 1 token, ticks -100 to 100 (about ±0.5%), liquidity 1e20 (about 0.4987 MON and 0.4987 token each). */
const TOKEN_SEED = {
  monWei: 500_000_000_000_000_000n,
  tokenWei: 500_000_000_000_000_000n,
  liquidity: 100_000_000_000_000_000_000n,
  tickLower: -100,
  tickUpper: 100,
};
/** The caps of the testnet custody v3 (USDC base units): 100 per personal account, 500 per vault, 2,000 across the platform. */
const CAPS = { personalE6: 100_000_000n, vaultE6: 500_000_000n, platformE6: 2_000_000_000n };
/**
 * The testnet feeds answer a fixed operator price and are re-dated on demand
 * (D-307); the v3 registry's max ages are 30 days here, so a trade through
 * Executor v3 never fails ORACLE_STALE between re-dates on a chain whose
 * price never moves. A real-chain difference the evidence records.
 */
const TESTNET_FEED_MAX_AGE = 30 * 24 * 3600;
/**
 * The legacy gas price every step pays (F-U13): testnet's base fee has held at
 * 100 gwei since P2-EC measured it, plus the 2 to 3 gwei tip the chain takes,
 * with headroom. forge's default EIP-1559 maximum (twice the base fee) would
 * ask the deployer to hold twice what a step charges.
 */
const GAS_PRICE_WEI = 110_000_000_000n;
/** The first run's start block, kept so a rerun's record still lists every step's transactions. */
const dryRun = process.argv.includes("--dry-run");
/**
 * Where the run's state and record go: evidence/f-u13 (the first deployment)
 * unless `--evidence <dir>` names another unit's directory, as NFT-U2's
 * redeploy of AgentNFT and the set that takes it does.
 */
const EVIDENCE_DIR = join(
  ROOT,
  process.argv.includes("--evidence")
    ? /** @type {string} */ (process.argv[process.argv.indexOf("--evidence") + 1])
    : "evidence/f-u13",
);
const RUN_STATE = join(EVIDENCE_DIR, "testnet-run.json");
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
    "TESTNET_SCREENER_PRIVATE_KEY",
    "TESTNET_ATTESTOR_PRIVATE_KEY",
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
  screener: addressOf(reveal(config, "TESTNET_SCREENER_PRIVATE_KEY")),
  attestor: addressOf(reveal(config, "TESTNET_ATTESTOR_PRIVATE_KEY")),
};
const allowlist = [roles.testWallet, ...OWNER_PLAYTEST_WALLETS];
const REGISTRY_ABI = parseAbi([
  "function verifier() view returns (address)",
  "function SET_VERIFIER() view returns (uint8)",
  "function RISK_TIMELOCK() view returns (uint256)",
  "function propose(uint8 action, bytes data) returns (bytes32)",
  "function changeId(uint8 action, bytes data) view returns (bytes32)",
  "function pending(bytes32 id) view returns (uint64 executableAt, uint64 expiresAt)",
]);

/**
 * The FUND_CONFIG the fund and Executor v3 scripts read (scripts/lib/fund.js
 * builds the local one): the testnet roles and venues, the four class F
 * seeds on the TestnetFeeds, and the three native MON v4 pools. Testnet has
 * no Uniswap v3 or PancakeSwap v3: the registry pins a venue by its code hash
 * and refuses a zero address, so the CREATE2 deployer (code on every chain)
 * stands in for both factories; no v3 pool is ever listed on testnet.
 * @param {{ monUsdFeed: string, usdcUsdFeed: string }} market
 * @param {{ alpha: { token: string, feed: string }, beta: { token: string, feed: string } }} tokens
 */
function fundConfig(market, tokens) {
  const seed = (
    /** @type {string} */ token,
    /** @type {string} */ usdFeed,
    /** @type {number} */ maxPositionBps,
  ) => ({
    token: token.toLowerCase(),
    maxPositionBps,
    usdFeed,
    usdDecimals: 8,
    usdMaxAge: TESTNET_FEED_MAX_AGE,
    rateFeed: NATIVE_MON,
    rateDecimals: 0,
    rateMaxAge: 0,
  });
  const pool = (/** @type {string} */ token1) => ({
    venue: FUND_VENUE.UNISWAP_V4,
    token0: NATIVE_MON,
    token1: token1.toLowerCase(),
    fee: 500,
    tickSpacing: 10,
    pool: NATIVE_MON,
  });
  return {
    admin: roles.admin,
    guardian: roles.guardian,
    screener: roles.screener,
    usdc: TESTNET.usdc,
    wmon: TESTNET.wmon,
    uniswapV3Factory: TESTNET.create2Deployer,
    pancakeswapV3Factory: TESTNET.create2Deployer,
    poolManager: TESTNET.poolManager,
    stateView: TESTNET.stateView,
    demoExecutor: roles.deployer,
    maxDeviationBps: 200,
    seeds: [
      seed(TESTNET.usdc, market.usdcUsdFeed, 10_000),
      seed(TESTNET.wmon, market.monUsdFeed, 4_000),
      seed(tokens.alpha.token, tokens.alpha.feed, 4_000),
      seed(tokens.beta.token, tokens.beta.feed, 4_000),
    ],
    pools: [pool(TESTNET.usdc), pool(tokens.alpha.token), pool(tokens.beta.token)],
  };
}

/** The forge simulation's own estimate of a step, when it printed one. @param {string} output */
function estimate(output) {
  const gas = /Estimated total gas used for script: (\d+)/.exec(output)?.[1];
  const mon = /Estimated amount required: ([\d.]+) (?:ETH|MON)/.exec(output)?.[1];
  return gas ? { gas: Number(gas), mon: Number(mon ?? 0) } : null;
}

/** The balance guard's stop: every step so far stands, and the record says where it stopped. */
class GuardStop extends Error {}

/**
 * The owner's rule for F-U13: nothing is spent before the balance is checked
 * against the estimate. Each step is simulated first; when the deployer
 * cannot cover forge's own estimate for it (the gas at the maximum fee, the
 * most the step can charge), the run stops and says how much is needed and
 * where to send it. A step that needs nothing is skipped.
 * @param {string} name @param {string} script @param {Record<string, string>} env
 * @returns {Promise<{ output: string, estimate: { gas: number, mon: number } | null }>}
 */
async function guardedStep(name, script, env, scope = SALT_SCOPE) {
  const simulated = forgeScript(script, {
    url,
    secrets,
    broadcast: false,
    env,
    gasPriceWei: GAS_PRICE_WEI,
    scope,
  });
  const e = estimate(simulated);
  if (!e || dryRun) return { output: simulated, estimate: e };
  const balance = Number(await testnetRpc(url, "eth_getBalance", [deployer, "latest"])) / 1e18;
  if (balance < e.mon)
    throw new GuardStop(
      `${name} needs about ${e.mon.toFixed(4)} MON at the maximum fee and the deployer ${deployer} holds ${balance.toFixed(4)} MON: send at least ${(e.mon - balance + 0.05).toFixed(4)} MON to ${deployer} on Monad testnet (chain 10143) and run pnpm deploy:testnet:v3 again; every step so far stands`,
    );
  console.log(
    `   estimate ${e.gas} gas, at most ${e.mon.toFixed(4)} MON; the deployer holds ${balance.toFixed(4)} MON`,
  );
  return {
    output: forgeScript(script, {
      url,
      secrets,
      broadcast: true,
      env,
      gasPriceWei: GAS_PRICE_WEI,
      scope,
    }),
    estimate: e,
  };
}

/** What the steps so far deployed, for the record a guard stop leaves (NFT-U2). */
/** @type {Record<string, unknown>} */
const progress = {};
/** @type {number} */
let runStartBlock = 0;
/** @type {bigint} */
let runBalanceBefore = 0n;
const ALL_SCRIPTS = [
  "DeployTestnetMarket.s.sol",
  "DeployTestnetTokens.s.sol",
  "DeployAgentNFT.s.sol",
  "DeployFund.s.sol",
  "DeployExecutorV3.s.sol",
  "DeployCustodyV3.s.sol",
  "BindExecutorV3.s.sol",
  "DeployAttestor.s.sol",
];
async function transactionsSince(/** @type {number} */ block) {
  /** @type {any[]} */
  const all = [];
  for (const script of ALL_SCRIPTS) all.push(...(await broadcastRecords(url, script)));
  return all.filter((t) => t.block >= block);
}

try {
  await assertTestnet(url);
  const nowBlock = Number(await testnetRpc(url, "eth_blockNumber"));
  /** @type {{ startBlock: number, startedAt: string, balanceBeforeWei: string } | null} */
  const earlier = existsSync(RUN_STATE) ? JSON.parse(readFileSync(RUN_STATE, "utf8")) : null;
  const balanceNow = BigInt(await testnetRpc(url, "eth_getBalance", [deployer, "latest"]));
  const startBlock = earlier?.startBlock ?? nowBlock;
  const balanceBefore = earlier ? BigInt(earlier.balanceBeforeWei) : balanceNow;
  runStartBlock = startBlock;
  runBalanceBefore = balanceBefore;
  if (!earlier && !dryRun) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(
      RUN_STATE,
      `${JSON.stringify({ startBlock, startedAt: new Date().toISOString(), balanceBeforeWei: balanceNow.toString() }, null, 2)}\n`,
    );
  }
  console.log(
    `Monad testnet (10143) at block ${nowBlock}; deployer ${deployer} holds ${Number(balanceNow) / 1e18} MON${earlier ? ` (continuing the run started at block ${startBlock})` : ""}`,
  );
  const keyEnv = { DEPLOYER_PRIVATE_KEY: deployerKey };
  /** @type {Record<string, { gas: number, mon: number } | null>} */
  const estimates = {};

  console.log(
    "\n1. The P2-EC market, found: the two TestnetFeeds, the pool seeder and the MON/USDC pool",
  );
  const seed = P2EC.market.seed;
  const marketStep = await guardedStep(
    "1 market",
    "script/DeployTestnetMarket.s.sol:DeployTestnetMarket",
    {
      ...keyEnv,
      TESTNET_FEED_WRITER: roles.feedWriter,
      TESTNET_USDC: TESTNET.usdc,
      TESTNET_POOL_MANAGER: TESTNET.poolManager,
      TESTNET_STATE_VIEW: TESTNET.stateView,
      SEED_MON_WEI: seed.monWei,
      SEED_USDC_RAW: seed.usdcRaw,
      SEED_LIQUIDITY: seed.liquidity,
      SEED_TICK_LOWER: String(seed.tickLower),
      SEED_TICK_UPPER: String(seed.tickUpper),
    },
    // CO-U1: the market and its tokens are found under P2-EC's scope; a clean redeploy
    // (TESTNET_SALT_SCOPE=co.testnet) takes fresh addresses for everything after them.
    "p2ec.testnet",
  );
  const marketOut = marketStep.output;
  estimates.market = marketStep.estimate;
  const market = {
    monUsdFeed: logged(marketOut, "TESTNET_FEED_MON_USD_ADDRESS"),
    usdcUsdFeed: logged(marketOut, "TESTNET_FEED_USDC_USD_ADDRESS"),
    seeder: logged(marketOut, "POOL_SEEDER_ADDRESS"),
    poolId: loggedBytes32(marketOut, "POOL_ID"),
    poolLiquidity: logged(marketOut, "POOL_LIQUIDITY"),
  };
  progress.market = market;
  if (market.seeder.toLowerCase() !== String(P2EC.market.seeder).toLowerCase())
    throw new Error("the pool seeder found is not P2-EC's");

  console.log("\n2. Two more tokens, each with a feed and a seeded native MON pool");
  const tokensStep = await guardedStep(
    "2 tokens",
    "script/DeployTestnetTokens.s.sol:DeployTestnetTokens",
    {
      ...keyEnv,
      TESTNET_FEED_WRITER: roles.feedWriter,
      TESTNET_POOL_MANAGER: TESTNET.poolManager,
      TESTNET_STATE_VIEW: TESTNET.stateView,
      POOL_SEEDER: market.seeder,
      TOKEN_SEED_MON_WEI: TOKEN_SEED.monWei.toString(),
      TOKEN_SEED_TOKEN_WEI: TOKEN_SEED.tokenWei.toString(),
      TOKEN_SEED_LIQUIDITY: TOKEN_SEED.liquidity.toString(),
      TOKEN_SEED_TICK_LOWER: String(TOKEN_SEED.tickLower),
      TOKEN_SEED_TICK_UPPER: String(TOKEN_SEED.tickUpper),
    },
    "p2ec.testnet",
  );
  const tokensOut = tokensStep.output;
  estimates.tokens = tokensStep.estimate;
  const tokens = {
    alpha: {
      token: logged(tokensOut, "TESTNET_TOKEN_ALPHA_ADDRESS"),
      feed: logged(tokensOut, "TESTNET_FEED_ALPHA_USD_ADDRESS"),
      poolId: loggedBytes32(tokensOut, "TESTNET_POOL_ALPHA_ID"),
      poolLiquidity: logged(tokensOut, "TESTNET_POOL_ALPHA_LIQUIDITY"),
    },
    beta: {
      token: logged(tokensOut, "TESTNET_TOKEN_BETA_ADDRESS"),
      feed: logged(tokensOut, "TESTNET_FEED_BETA_USD_ADDRESS"),
      poolId: loggedBytes32(tokensOut, "TESTNET_POOL_BETA_ID"),
      poolLiquidity: logged(tokensOut, "TESTNET_POOL_BETA_LIQUIDITY"),
    },
  };
  progress.tokens = tokens;

  console.log("\n3. AgentNFT (34 species, 500/300/200, two mints per wallet)");
  const nftStep = await guardedStep("3 agent nft", "script/DeployAgentNFT.s.sol:DeployAgentNFT", {
    ...keyEnv,
    AGENT_NFT_ADMIN: roles.admin,
    AGENT_NFT_CLAIM_SIGNER: roles.claimSigner,
    AGENT_NFT_TREASURY: roles.admin,
    AGENT_NFT_IMAGE_BASE_URI: "ipfs://alpha-agents-images-pending/",
    AGENT_NFT_ENTROPY: TESTNET.entropy,
  });
  const nftOut = nftStep.output;
  estimates.agentNft = nftStep.estimate;
  const agentNft = logged(nftOut, "AGENT_NFT_ADDRESS");
  progress.agentNft = agentNft;
  const hasCode = async (/** @type {string} */ a) =>
    (await testnetRpc(url, "eth_getCode", [a, "latest"])) !== "0x";
  if (dryRun && !((await hasCode(tokens.alpha.token)) && (await hasCode(agentNft)))) {
    console.log(
      "\ndry run: the fund set needs the tokens and AgentNFT on chain, so steps 4 to 7 are not simulated here (pnpm test:testnet-fork runs them all on a fork); nothing was sent",
    );
    for (const [step, e] of Object.entries(estimates))
      console.log(`   ${step}: ${e ? `${e.gas} gas, about ${e.mon} MON` : "nothing to send"}`);
    process.exit(0);
  }

  console.log(
    "\n4. The fund set: TokenRegistry, ProtocolRegistryV3, OracleAdapterV3, RouteAdapter",
  );
  const fund = fundConfig(market, tokens);
  const fundStep = await guardedStep("4 fund set", "script/DeployFund.s.sol:DeployFund", {
    ...keyEnv,
    FUND_CONFIG: JSON.stringify(fund),
  });
  const fundOut = fundStep.output;
  estimates.fund = fundStep.estimate;
  const fundSet = {
    tokenRegistry: logged(fundOut, "TOKEN_REGISTRY_ADDRESS"),
    protocolRegistry: logged(fundOut, "PROTOCOL_REGISTRY_V3_ADDRESS"),
    oracle: logged(fundOut, "ORACLE_ADAPTER_V3_ADDRESS"),
    routeAdapter: logged(fundOut, "ROUTE_ADAPTER_ADDRESS"),
    coreTokens: Number(logged(fundOut, "CORE_TOKENS")),
    corePools: Number(logged(fundOut, "CORE_POOLS")),
  };
  progress.fundSet = fundSet;

  console.log(
    "\n5. Executor v3, its RouteAdapter and ProtocolRegistryV3, and the OracleAdapterV3 over it",
  );
  const execStep = await guardedStep(
    "5 executor v3",
    "script/DeployExecutorV3.s.sol:DeployExecutorV3",
    {
      ...keyEnv,
      FUND_CONFIG: JSON.stringify(fund),
      EXECUTOR_V3_TOKEN_REGISTRY: fundSet.tokenRegistry,
      EXECUTOR_V3_AGENT_NFT: agentNft,
    },
  );
  const execOut = execStep.output;
  estimates.executor = execStep.estimate;
  const executorSet = {
    executor: logged(execOut, "EXECUTOR_V3_ADDRESS"),
    routeAdapter: logged(execOut, "EXECUTOR_ROUTE_ADAPTER_V3_ADDRESS"),
    protocolRegistry: logged(execOut, "PROTOCOL_REGISTRY_V3_ADDRESS"),
    oracle: logged(execOut, "ORACLE_ADAPTER_V3_ADDRESS"),
    setDeployer: logged(execOut, "EXECUTOR_SET_DEPLOYER_ADDRESS"),
    corePools: Number(logged(execOut, "CORE_POOLS")),
    policyHash: loggedBytes32(execOut, "EXECUTOR_V3_POLICY_HASH"),
  };
  progress.executorSet = executorSet;

  console.log("\n6. AccountFactoryV3 with the Executor given, and the Executor's binding");
  const custodyStep = await guardedStep(
    "6 custody v3",
    "script/DeployCustodyV3.s.sol:DeployCustodyV3",
    {
      ...keyEnv,
      CUSTODY_V3_ADMIN: roles.admin,
      CUSTODY_V3_GUARDIAN: roles.guardian,
      CUSTODY_V3_SENTINEL: roles.sentinel,
      CUSTODY_V3_AGENT_NFT: agentNft,
      CUSTODY_V3_USDC: TESTNET.usdc,
      CUSTODY_V3_TOKEN_REGISTRY: fundSet.tokenRegistry,
      CUSTODY_V3_ORACLE: executorSet.oracle,
      CUSTODY_V3_EXECUTOR: executorSet.executor,
      CUSTODY_V3_PERSONAL_CAP: CAPS.personalE6.toString(),
      CUSTODY_V3_VAULT_CAP: CAPS.vaultE6.toString(),
      CUSTODY_V3_PLATFORM_CAP: CAPS.platformE6.toString(),
      CUSTODY_V3_DEPOSITS_ENABLED: "false",
      CUSTODY_V3_ALLOWLIST: allowlist.join(","),
    },
  );
  const custodyOut = custodyStep.output;
  estimates.custody = custodyStep.estimate;
  const custody = {
    factory: logged(custodyOut, "ACCOUNT_FACTORY_V3_ADDRESS"),
    personalAccountImplementation: logged(custodyOut, "PERSONAL_ACCOUNT_V3_IMPLEMENTATION"),
    vaultImplementation: logged(custodyOut, "STRATEGY_VAULT_V3_IMPLEMENTATION"),
  };
  progress.custody = custody;
  const bindStep = await guardedStep("6 bind", "script/BindExecutorV3.s.sol:BindExecutorV3", {
    ...keyEnv,
    EXECUTOR_V3: executorSet.executor,
    EXECUTOR_V3_FACTORY: custody.factory,
    EXECUTOR_V3_POOLS: executorSet.protocolRegistry,
  });
  const bindOut = bindStep.output;
  estimates.bind = bindStep.estimate;
  if (logged(bindOut, "EXECUTOR_V3_BOUND_FACTORY").toLowerCase() !== custody.factory.toLowerCase())
    throw new Error("Executor v3 is bound to another factory");

  console.log("\n7. The attestation verifier, and the registry's SET_VERIFIER proposal");
  const verifierStep = await guardedStep(
    "7 verifier",
    "script/DeployAttestor.s.sol:DeployAttestor",
    {
      ...keyEnv,
      ATTESTOR_ADDRESS: roles.attestor,
    },
  );
  const verifierOut = verifierStep.output;
  estimates.verifier = verifierStep.estimate;
  const verifier = logged(verifierOut, "ATTESTATION_VERIFIER_ADDRESS");
  progress.verifier = verifier;
  const client = createPublicClient({ transport: http(url, { retryCount: 0 }) });
  const registry = /** @type {`0x${string}`} */ (fundSet.tokenRegistry);
  const action = await client.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "SET_VERIFIER",
  });
  const data = encodeAbiParameters(
    [{ type: "address" }],
    [/** @type {`0x${string}`} */ (verifier)],
  );
  const changeId = await client.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "changeId",
    args: [action, data],
  });
  let [executableAt] = await client.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "pending",
    args: [changeId],
  });
  const current = await client.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "verifier",
  });
  /** @type {string | null} */
  let proposalTx = null;
  if (current.toLowerCase() !== verifier.toLowerCase() && executableAt === 0n && !dryRun) {
    const wallet = createWalletClient({
      account: privateKeyToAccount(/** @type {`0x${string}`} */ (deployerKey)),
      transport: http(url, { retryCount: 0 }),
    });
    const hash = await wallet.sendTransaction({
      chain: null,
      to: registry,
      data: encodeFunctionData({
        abi: REGISTRY_ABI,
        functionName: "propose",
        args: [action, data],
      }),
    });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error("the SET_VERIFIER proposal reverted");
    proposalTx = hash;
    [executableAt] = await client.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "pending",
      args: [changeId],
    });
  }
  const delay = await client.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "RISK_TIMELOCK",
  });
  console.log(
    `   verifier ${verifier} for attestor ${roles.attestor}; SET_VERIFIER ${
      current.toLowerCase() === verifier.toLowerCase()
        ? "already set"
        : executableAt === 0n
          ? "not proposed (dry run)"
          : `proposed, executable at ${new Date(Number(executableAt) * 1000).toISOString()} (the ${Number(delay) / 86_400}-day timelock)`
    }`,
  );

  if (dryRun) {
    console.log("\ndry run: nothing was sent");
    for (const [step, e] of Object.entries(estimates))
      console.log(`   ${step}: ${e ? `${e.gas} gas, about ${e.mon} MON` : "nothing to send"}`);
    process.exit(0);
  }

  const transactions = await transactionsSince(startBlock);
  const balanceAfter = BigInt(await testnetRpc(url, "eth_getBalance", [deployer, "latest"]));
  const record = {
    unit: "F-U13",
    chainId: TESTNET.chainId,
    label: "testnet, throwaway (D-247, D-249); the whole v3 stack beside P2-EC's v2",
    saltScope: SALT_SCOPE,
    recordedAt: new Date().toISOString(),
    startBlock,
    roles,
    allowlist,
    caps: {
      personalE6: CAPS.personalE6.toString(),
      vaultE6: CAPS.vaultE6.toString(),
      platformE6: CAPS.platformE6.toString(),
    },
    feedMaxAgeSeconds: TESTNET_FEED_MAX_AGE,
    market,
    tokens: {
      alpha: tokens.alpha,
      beta: tokens.beta,
      seed: {
        monWei: TOKEN_SEED.monWei.toString(),
        tokenWei: TOKEN_SEED.tokenWei.toString(),
        liquidity: TOKEN_SEED.liquidity.toString(),
        tickLower: TOKEN_SEED.tickLower,
        tickUpper: TOKEN_SEED.tickUpper,
      },
    },
    agentNft,
    fund: { ...fundSet, config: fund },
    executorV3: executorSet,
    custodyV3: custody,
    attestation: {
      verifier,
      attestor: roles.attestor,
      proposalTx,
      executableAt: Number(executableAt),
      timelockSeconds: Number(delay),
    },
    transactions,
    deployerMonSpentWei: (balanceBefore - balanceAfter).toString(),
    gasPriceWei: GAS_PRICE_WEI.toString(),
  };
  const dir = EVIDENCE_DIR;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "testnet-deployment.json");
  if (transactions.length > 0) writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    `\n${transactions.length} transactions; the deployer spent ${Number(balanceBefore - balanceAfter) / 1e18} MON`,
  );
  console.log(
    `AgentNFT ${agentNft}\nTokenRegistry ${fundSet.tokenRegistry}\nExecutor v3 ${executorSet.executor}\nAccountFactoryV3 ${custody.factory}\nAttestationVerifier ${verifier}`,
  );
  if (transactions.length > 0) console.log(`recorded in ${file}`);
} catch (err) {
  if (err instanceof GuardStop && !dryRun) {
    // Every step so far stands: record what is on chain, so the handoff and
    // the verification have it before the run continues.
    try {
      const transactions = await transactionsSince(runStartBlock);
      const balanceAfter = BigInt(await testnetRpc(url, "eth_getBalance", [deployer, "latest"]));
      const partial = {
        unit: "F-U13",
        partial: true,
        stoppedBy: err.message.replaceAll(url, "<rpc>"),
        chainId: TESTNET.chainId,
        recordedAt: new Date().toISOString(),
        startBlock: runStartBlock,
        roles,
        ...progress,
        transactions,
        deployerMonSpentWei: (runBalanceBefore - balanceAfter).toString(),
        gasPriceWei: GAS_PRICE_WEI.toString(),
      };
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      const file = join(EVIDENCE_DIR, "testnet-deployment.json");
      writeFileSync(file, `${JSON.stringify(partial, null, 2)}\n`);
      console.log(`partial record (${transactions.length} transactions so far) in ${file}`);
    } catch (recordErr) {
      console.error(
        `the partial record could not be written: ${recordErr instanceof Error ? recordErr.message : String(recordErr)}`.replaceAll(
          url,
          "<rpc>",
        ),
      );
    }
  }
  console.error(
    `error: ${(err instanceof Error ? err.message : String(err)).replaceAll(url, "<rpc>")}`,
  );
  process.exit(1);
}
