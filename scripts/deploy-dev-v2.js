// @ts-check
// pnpm deploy:dev: 2026-10-16, the monad-dev stack's own fresh set on Monad testnet (salt scope
// co.dev), trading the tokens that already exist on a Uniswap v2 family venue (nad.fun first):
// AgentNFT (the final deck), the fund set and Executor v3's set with nad.fun's factory listed as
// a v2 venue and the testnet price mode (QuoteOracleV3: each token priced by its own pair, each
// fill checked against the route's quote), every token pnpm dev:discover found (class F, its
// pricing pair as its "feed"), AccountFactoryV3 with a 100% one-token cap, and the binding.
// No pools of our own and no feeds: the deploy pays gas only. The judged stacks are untouched.
// The stack's role keys are its own (.env.monad-dev); the deployer pays and is the admin.
// Writes evidence/dev-nadfun/deployment.json. Prints no key and no RPC URL.
//
//   pnpm deploy:dev               deploy (or find) everything, each step balance-guarded
//   pnpm deploy:dev --dry-run     simulate every step, sending nothing
//   pnpm deploy:dev --rpc-env X   use the RPC in env var X (e.g. a local anvil fork)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FUND_VENUE, NADFUN_TESTNET } from "@alpha-agents/domain";
import { privateKeyToAccount } from "viem/accounts";
import { loadRootEnv } from "./lib/config.js";
import { ROOT } from "./lib/paths.js";
import {
  OWNER_PLAYTEST_WALLETS,
  TESTNET,
  addressOf,
  assertTestnet,
  forgeScript,
  logged,
  loggedBytes32,
  testnetRpc,
} from "./lib/testnet.js";

const SCOPE = "co.dev";
const EVIDENCE_DIR = join(ROOT, "evidence/dev-nadfun");
const dryRun = process.argv.includes("--dry-run");
const rpcEnv = process.argv.includes("--rpc-env")
  ? /** @type {string} */ (process.argv[process.argv.indexOf("--rpc-env") + 1])
  : null;
/** Monad's base fee holds at 100 gwei; the chain charges the gas limit at the price paid. */
const GAS_PRICE_WEI = 110_000_000_000n;
/** The dev caps (USDC base units): 1,000 per personal account, 5,000 per vault, 50,000 in all. */
const CAPS = { personalE6: 1_000_000_000n, vaultE6: 5_000_000_000n, platformE6: 50_000_000_000n };
/**
 * The owner's wide testnet limits (2026-10-16): one token up to 100%, slippage 3% against the
 * route's own quote, the pools within 10% of their own price, and 48 trades per 12 hours (96 a
 * day: the Executor's ring holds 48 per window).
 */
const DEV_POLICY = {
  maxTradeBps: 2_500,
  maxAssetBps: 10_000,
  minUsdcBps: 500,
  maxSlippageBps: 300,
  maxSlippageClassABps: 300,
  maxClassAPositionBps: 1_500,
  maxClassATotalBps: 5_000,
  maxTurnoverBps: 50_000,
  maxTradesPerWindow: 48,
  windowSeconds: 43_200,
  deadlineSeconds: 120,
};
const MAX_DEVIATION_BPS = 1_000;

loadRootEnv();
const devEnv = Object.fromEntries(
  readFileSync(join(ROOT, ".env.monad-dev"), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const url = (
  rpcEnv
    ? process.env[rpcEnv]
    : process.env.MONAD_TESTNET_RPC_URL_SECONDARY || process.env.MONAD_TESTNET_RPC_URL
)?.trim();
if (!url) throw new Error("no Monad testnet RPC is set");
const deployerKey = /** @type {string} */ (process.env.TESTNET_DEPLOYER_PRIVATE_KEY?.trim());
if (!deployerKey) throw new Error("TESTNET_DEPLOYER_PRIVATE_KEY is not set");
const secrets = [deployerKey, ...Object.values(devEnv)];
const deployer = addressOf(deployerKey);
const role = (/** @type {string} */ name) => {
  const k = devEnv[name];
  if (!k) throw new Error(`${name} is missing from .env.monad-dev`);
  return privateKeyToAccount(/** @type {`0x${string}`} */ (k)).address;
};
const roles = {
  deployer,
  admin: deployer,
  guardian: role("TESTNET_GUARDIAN_PRIVATE_KEY"),
  sentinel: role("TESTNET_SENTINEL_PRIVATE_KEY"),
  claimSigner: role("TESTNET_CLAIM_SIGNER_PRIVATE_KEY"),
  screener: role("TESTNET_SCREENER_PRIVATE_KEY"),
  testWallet: role("TESTNET_TEST_WALLET_PRIVATE_KEY"),
  keeper: role("REVEAL_KEEPER_PRIVATE_KEY"),
  gas: role("DEV_GAS_PRIVATE_KEY"),
};
const allowlist = [roles.testWallet, ...OWNER_PLAYTEST_WALLETS];
const keyEnv = { PRIVATE_KEY: deployerKey, DEPLOYER_PRIVATE_KEY: deployerKey };

const discovery = JSON.parse(readFileSync(join(EVIDENCE_DIR, "discovery.json"), "utf8"));
const venue = NADFUN_TESTNET;
const usdc = venue.bases.usdc;
const wmon = venue.bases.wmon;
const sorted = (/** @type {string} */ a, /** @type {string} */ b) =>
  a.toLowerCase() < b.toLowerCase() ? [a.toLowerCase(), b.toLowerCase()] : [b.toLowerCase(), a.toLowerCase()];

/** A class F seed whose "feed" is its pricing pair (the testnet price mode). */
const seed = (/** @type {string} */ token, /** @type {string} */ pricingPair) => ({
  token: token.toLowerCase(),
  maxPositionBps: 10_000,
  usdFeed: pricingPair.toLowerCase(),
  usdDecimals: 18,
  usdMaxAge: 1,
  rateFeed: "0x0000000000000000000000000000000000000000",
  rateDecimals: 0,
  rateMaxAge: 0,
});
const v2Pool = (/** @type {string} */ a, /** @type {string} */ b, /** @type {string} */ pair, /** @type {number} */ fee) => {
  const [token0, token1] = sorted(a, b);
  return { venue: FUND_VENUE.UNISWAP_V2, token0, token1, fee, tickSpacing: 0, pool: pair.toLowerCase() };
};
const chosen = /** @type {{ token: string, symbol: string, pair: string, base: "USDC" | "WMON", feePpm: number }[]} */ (
  discovery.chosen
);
const fund = {
  admin: roles.admin,
  guardian: roles.guardian,
  screener: roles.screener,
  usdc,
  wmon,
  // Testnet has no Uniswap v3 or PancakeSwap v3: the CREATE2 deployer stands in (no v3 pool is listed).
  uniswapV3Factory: TESTNET.create2Deployer,
  pancakeswapV3Factory: TESTNET.create2Deployer,
  poolManager: TESTNET.poolManager,
  stateView: TESTNET.stateView,
  demoExecutor: roles.deployer,
  maxDeviationBps: MAX_DEVIATION_BPS,
  quoteMode: true,
  v2Factories: [venue.factory],
  // nad.fun's pairs quote themselves (its sells charge the fee on the output): the adapter takes that quote.
  v2QuoteSelectors: [venue.pairQuoteSelector ?? "0x00000000"],
  policy: DEV_POLICY,
  seeds: [
    seed(usdc, discovery.bases.pair),
    seed(wmon, discovery.bases.pair),
    ...chosen.map((t) => seed(t.token, t.pair)),
  ],
  pools: [
    v2Pool(usdc, wmon, discovery.bases.pair, discovery.bases.feePpm),
    ...chosen.map((t) => v2Pool(t.token, t.base === "USDC" ? usdc : wmon, t.pair, t.feePpm)),
  ],
};

/** The forge simulation's estimate. @param {string} output */
function estimate(output) {
  const gas = /Estimated total gas used for script: (\d+)/.exec(output)?.[1];
  const mon = /Estimated amount required: ([\d.]+) (?:ETH|MON)/.exec(output)?.[1];
  return gas ? { gas: Number(gas), mon: Number(mon ?? 0) } : null;
}

/** Each step simulated first; nothing is sent unless the deployer covers forge's own estimate. */
async function step(/** @type {string} */ name, /** @type {string} */ script, /** @type {Record<string, string>} */ env) {
  const simulated = forgeScript(script, { url: /** @type {string} */ (url), secrets, broadcast: false, env, gasPriceWei: GAS_PRICE_WEI, scope: SCOPE });
  const e = estimate(simulated);
  if (/Error|revert/i.test(simulated) && !/Script ran successfully/.test(simulated))
    throw new Error(`${name}: the simulation failed:\n${simulated.slice(-1500)}`);
  if (!e || dryRun) {
    console.log(`   ${name}: ${e ? `${e.gas} gas, about ${e.mon.toFixed(4)} MON` : "nothing to send"}`);
    return { output: simulated, estimate: e };
  }
  const balance = Number(await testnetRpc(/** @type {string} */ (url), "eth_getBalance", [deployer, "latest"])) / 1e18;
  if (balance < e.mon)
    throw new Error(
      `BLOCKED: ${name} needs about ${e.mon.toFixed(4)} MON and the deployer ${deployer} holds ${balance.toFixed(4)}: send at least ${(e.mon - balance + 0.05).toFixed(4)} MON on Monad testnet and run pnpm deploy:dev again; every step so far stands`,
    );
  console.log(`   ${name}: ${e.gas} gas, at most ${e.mon.toFixed(4)} MON; the deployer holds ${balance.toFixed(4)}`);
  const output = forgeScript(script, { url: /** @type {string} */ (url), secrets, broadcast: true, env, gasPriceWei: GAS_PRICE_WEI, scope: SCOPE });
  return { output, estimate: e };
}

try {
  await assertTestnet(url);
  const balanceBefore = BigInt(await testnetRpc(url, "eth_getBalance", [deployer, "latest"]));
  const startBlock = Number(await testnetRpc(url, "eth_blockNumber"));
  console.log(
    `monad-dev on ${venue.name}: ${chosen.length} tokens, ${fund.pools.length} pairs; the deployer holds ${Number(balanceBefore) / 1e18} MON${dryRun ? " (dry run)" : ""}`,
  );

  console.log("\n1. AgentNFT (the final deck)");
  const nft = await step("agent nft", "script/DeployAgentNFT.s.sol:DeployAgentNFT", {
    ...keyEnv,
    AGENT_NFT_ADMIN: roles.admin,
    AGENT_NFT_CLAIM_SIGNER: roles.claimSigner,
    AGENT_NFT_TREASURY: roles.admin,
    AGENT_NFT_IMAGE_BASE_URI: "ipfs://alpha-agents-images-pending/",
    AGENT_NFT_ENTROPY: TESTNET.entropy,
  });
  const agentNft = logged(nft.output, "AGENT_NFT_ADDRESS");

  console.log("\n2. The fund set's TokenRegistry (every discovered token, class F by its pair)");
  // The fund set's own registry and adapter carry no pools: Executor v3's set (step 3) is the one traded through.
  const fundOnly = { ...fund, pools: [] };
  const fundStep = await step("fund set", "script/DeployFund.s.sol:DeployFund", {
    ...keyEnv,
    FUND_CONFIG: JSON.stringify(fundOnly),
  });
  const tokenRegistry = logged(fundStep.output, "TOKEN_REGISTRY_ADDRESS");

  console.log("\n3. Executor v3, its RouteAdapter and ProtocolRegistryV3 (nad.fun listed), and the QuoteOracleV3");
  const exec = await step("executor v3", "script/DeployExecutorV3.s.sol:DeployExecutorV3", {
    ...keyEnv,
    FUND_CONFIG: JSON.stringify(fund),
    EXECUTOR_V3_TOKEN_REGISTRY: tokenRegistry,
    EXECUTOR_V3_AGENT_NFT: agentNft,
  });
  const executorSet = {
    executor: logged(exec.output, "EXECUTOR_V3_ADDRESS"),
    routeAdapter: logged(exec.output, "EXECUTOR_ROUTE_ADAPTER_V3_ADDRESS"),
    protocolRegistry: logged(exec.output, "PROTOCOL_REGISTRY_V3_ADDRESS"),
    oracle: logged(exec.output, "ORACLE_ADAPTER_V3_ADDRESS"),
    corePools: Number(logged(exec.output, "CORE_POOLS")),
    policyHash: loggedBytes32(exec.output, "EXECUTOR_V3_POLICY_HASH"),
  };

  console.log("\n4. AccountFactoryV3 (one token up to 100%) and the Executor's binding");
  const custodyStep = await step("custody v3", "script/DeployCustodyV3.s.sol:DeployCustodyV3", {
    ...keyEnv,
    CUSTODY_V3_ADMIN: roles.admin,
    CUSTODY_V3_GUARDIAN: roles.guardian,
    CUSTODY_V3_SENTINEL: roles.sentinel,
    CUSTODY_V3_AGENT_NFT: agentNft,
    CUSTODY_V3_USDC: usdc,
    CUSTODY_V3_TOKEN_REGISTRY: tokenRegistry,
    CUSTODY_V3_ORACLE: executorSet.oracle,
    CUSTODY_V3_EXECUTOR: executorSet.executor,
    CUSTODY_V3_PERSONAL_CAP: CAPS.personalE6.toString(),
    CUSTODY_V3_VAULT_CAP: CAPS.vaultE6.toString(),
    CUSTODY_V3_PLATFORM_CAP: CAPS.platformE6.toString(),
    CUSTODY_V3_DEPOSITS_ENABLED: "true",
    CUSTODY_V3_ALLOWLIST: allowlist.join(","),
    CUSTODY_V3_MAX_ASSET_BPS: "10000",
    // The custody core's own backstop on value lost a trade: nad.fun's launch pairs charge 1.6% a hop.
    CUSTODY_V3_MAX_SLIPPAGE_BPS: "800",
  });
  const custody = {
    factory: logged(custodyStep.output, "ACCOUNT_FACTORY_V3_ADDRESS"),
    personalAccountImplementation: logged(custodyStep.output, "PERSONAL_ACCOUNT_V3_IMPLEMENTATION"),
    vaultImplementation: logged(custodyStep.output, "STRATEGY_VAULT_V3_IMPLEMENTATION"),
  };
  const bind = await step("bind", "script/BindExecutorV3.s.sol:BindExecutorV3", {
    ...keyEnv,
    EXECUTOR_V3: executorSet.executor,
    EXECUTOR_V3_FACTORY: custody.factory,
    EXECUTOR_V3_POOLS: executorSet.protocolRegistry,
  });
  if (!dryRun && logged(bind.output, "EXECUTOR_V3_BOUND_FACTORY").toLowerCase() !== custody.factory.toLowerCase())
    throw new Error("Executor v3 is bound to another factory");

  const balanceAfter = BigInt(await testnetRpc(url, "eth_getBalance", [deployer, "latest"]));
  const record = {
    unit: "CO-U1",
    stack: "monad-dev",
    chainId: TESTNET.chainId,
    label: "the monad-dev stack: nad.fun's tokens through the Uniswap v2 family venue, the testnet price mode",
    saltScope: SCOPE,
    recordedAt: new Date().toISOString(),
    startBlock,
    roles,
    allowlist,
    caps: Object.fromEntries(Object.entries(CAPS).map(([k, v]) => [k, v.toString()])),
    policy: DEV_POLICY,
    maxDeviationBps: MAX_DEVIATION_BPS,
    venue: { id: venue.id, name: venue.name, factory: venue.factory, usdc, wmon, basePair: discovery.bases.pair },
    tokens: chosen,
    agentNft,
    tokenRegistry,
    executorV3: executorSet,
    custodyV3: custody,
    deployerMonSpentWei: (balanceBefore - balanceAfter).toString(),
    gasPriceWei: GAS_PRICE_WEI.toString(),
  };
  if (!dryRun) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(EVIDENCE_DIR, rpcEnv ? "fork-deployment.json" : "deployment.json"), `${JSON.stringify(record, null, 2)}\n`);
  }
  console.log(
    `\n${dryRun ? "dry run: nothing was sent" : `the deployer spent ${Number(balanceBefore - balanceAfter) / 1e18} MON`}\nAgentNFT ${agentNft}\nTokenRegistry ${tokenRegistry}\nExecutor v3 ${executorSet.executor}\nAccountFactoryV3 ${custody.factory}\nQuoteOracleV3 ${executorSet.oracle}`,
  );
  void existsSync;
} catch (err) {
  console.error(`error: ${(err instanceof Error ? err.message : String(err)).replaceAll(url, "<rpc>")}`);
  process.exit(1);
}
