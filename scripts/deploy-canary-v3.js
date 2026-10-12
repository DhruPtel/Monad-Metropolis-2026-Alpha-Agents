// @ts-check
// pnpm deploy:canary:v3: F-U13's fresh mainnet canary of the current trading
// contracts, the v3 set (D-250 to D-252, D-316), beside P2-EC's v2 canary and
// on its CanaryAgent: the fund set (a TokenRegistry with USDC and WMON as
// class F on the real Chainlink feeds, the ProtocolRegistryV3 with the three
// USDC/WMON core pools, OracleAdapterV3, a RouteAdapter), Executor v3 and its
// set (the registered RouteAdapter, the ProtocolRegistryV3 it trades through
// and the OracleAdapterV3 over it), AccountFactoryV3 with the two
// implementations (caps 10 USDC, only the canary owner on the allowlist,
// public vault deposits off) and the Executor's binding. Every salt carries
// the p2ec.canary scope (D-249) at the sets' own versions, so nothing
// collides with the v2 canary or with PB-U1's addresses. Each step finds what
// an earlier run deployed, so a rerun after a failure is safe. The chain is
// checked as 143 before each step, the mainnet facts are re-checked first,
// every step is simulated before it is sent, and the spend is held to the
// canary's budget (D-316). Writes evidence/f-u13/canary-deployment.json.
// Prints no key and no RPC URL.
//
//   CANARY_SIGNING_ENABLED=true pnpm deploy:canary:v3            deploy (or find) everything
//   CANARY_SIGNING_ENABLED=true pnpm deploy:canary:v3 --dry-run  simulate the fund set against mainnet, sending nothing
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, MONAD_MAINNET_CHAIN_ID } from "@alpha-agents/config";
import {
  CLASS_F_FEEDS,
  CORE_POOL_CANDIDATES,
  MONAD_BASE_TOKENS,
  NATIVE_MON,
  feedMaxAgeSeconds,
} from "@alpha-agents/domain";
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
import { addressOf, broadcastRecords, forgeScript, logged, loggedBytes32 } from "./lib/testnet.js";

/**
 * The most this deployment may spend of the rerun's 10 MON (D-316); the run
 * needs the rest. The v3 set is about three times the v2 canary's code
 * (the fund set alone simulated at 19.9M gas, 2.19 MON at 110 gwei).
 */
const DEPLOY_BUDGET_WEI = 8_500_000_000_000_000_000n;
/** The legacy gas price every step pays: mainnet's base fee holds at 100 gwei, plus the tip, with headroom (see scripts/lib/testnet.js). */
const GAS_PRICE_WEI = 110_000_000_000n;

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

/**
 * The FUND_CONFIG the fund and Executor v3 scripts read, for the canary: the
 * canary owner as admin and screener (the canary has no screener key and
 * registers nothing screened), the canary guardian, the real venues, USDC and
 * WMON on their Chainlink feeds with the reviewed max ages, and the three
 * USDC/WMON core pools (Uniswap v3 0.3%, PancakeSwap v3 0.05%, the v4 native
 * MON/USDC 0.05% launch pool).
 */
function fundConfig() {
  const usdc = MONAD_BASE_TOKENS.USDC;
  const wmon = MONAD_BASE_TOKENS.WMON;
  const feed = (/** @type {string} */ symbol) => {
    const f = CLASS_F_FEEDS.find((x) => x.symbol === symbol);
    if (!f) throw new Error(`no reviewed feed for ${symbol}`);
    const usd = f.legs[f.legs.length - 1];
    if (!usd) throw new Error(`no USD leg for ${symbol}`);
    return { proxy: usd.proxy, decimals: usd.decimals, maxAge: feedMaxAgeSeconds(usd) };
  };
  const seed = (
    /** @type {string} */ token,
    /** @type {string} */ symbol,
    /** @type {number} */ bps,
  ) => {
    const f = feed(symbol);
    return {
      token,
      maxPositionBps: bps,
      usdFeed: f.proxy,
      usdDecimals: f.decimals,
      usdMaxAge: f.maxAge,
      rateFeed: NATIVE_MON,
      rateDecimals: 0,
      rateMaxAge: 0,
    };
  };
  const held = (/** @type {string} */ a) => (a === NATIVE_MON ? wmon : a);
  /** @type {string[]} */
  const ours = [usdc, wmon];
  const pools = CORE_POOL_CANDIDATES.filter(
    (p) => ours.includes(held(p.pair[0])) && ours.includes(held(p.pair[1])),
  );
  if (pools.length === 0) throw new Error("no USDC/WMON core pool candidate");
  return {
    admin: roles.owner,
    guardian: roles.guardian,
    screener: roles.owner,
    usdc,
    wmon,
    uniswapV3Factory: canaryBook("uniswap_v3_factory").toLowerCase(),
    pancakeswapV3Factory: canaryBook("pancakeswap_v3_factory").toLowerCase(),
    poolManager: canaryBook("uniswap_v4_pool_manager").toLowerCase(),
    stateView: canaryBook("uniswap_v4_state_view").toLowerCase(),
    demoExecutor: roles.owner,
    maxDeviationBps: 200,
    seeds: [seed(usdc, "USDC", 10_000), seed(wmon, "WMON", 4_000)],
    pools: pools.map((p) => ({
      venue: p.venue,
      token0: p.pair[0],
      token1: p.pair[1],
      fee: p.fee,
      tickSpacing: p.tickSpacing,
      pool: p.pool,
    })),
  };
}

/** The forge simulation's own estimate of a step, when it printed one. @param {string} output */
function estimate(output) {
  const gas = /Estimated total gas used for script: (\d+)/.exec(output)?.[1];
  const monText = /Estimated amount required: ([\d.]+) (?:ETH|MON)/.exec(output)?.[1];
  return gas ? { gas: Number(gas), mon: Number(monText ?? 0) } : null;
}

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
  const env = { DEPLOYER_PRIVATE_KEY: ownerKey, CANARY_SIGNING_ENABLED: "true" };
  const canaryAgent = canaryBook("agent_nft");
  if ((await mainnetRpc(url, "eth_getCode", [canaryAgent, "latest"])) === "0x")
    throw new Error("CanaryAgent has no code on mainnet; run pnpm deploy:canary first");
  /** @type {Record<string, { gas: number, mon: number } | null>} */
  const estimates = {};

  /**
   * One step: chain 143 checked, simulated first, its estimate held against the
   * budget and the owner's balance, then sent (unless a dry run).
   * @param {string} name @param {string} script @param {Record<string, string>} stepEnv
   */
  const step = async (name, script, stepEnv) => {
    await assertMainnet(url);
    const simulated = forgeScript(script, {
      url,
      secrets,
      broadcast: false,
      scope: CANARY_SCOPE,
      env: { ...env, ...stepEnv },
      gasPriceWei: GAS_PRICE_WEI,
    });
    const e = estimate(simulated);
    estimates[name] = e;
    if (!e || dryRun) return simulated;
    const spent = await spentWei(url, keys, startWei);
    const balance = BigInt(await mainnetRpc(url, "eth_getBalance", [roles.owner, "latest"]));
    const needWei = BigInt(Math.ceil(e.mon * 1e6)) * 10n ** 12n;
    if (spent + needWei > DEPLOY_BUDGET_WEI)
      throw new Error(
        `${name} could cost up to ${e.mon.toFixed(4)} MON and ${mon(spent)} is spent of the ${mon(DEPLOY_BUDGET_WEI)} deployment budget; stopping, every step so far stands`,
      );
    if (balance < needWei)
      throw new Error(
        `${name} needs about ${e.mon.toFixed(4)} MON at the maximum fee and the canary owner ${roles.owner} holds ${mon(balance)}: send at least ${mon(needWei - balance + 10n ** 17n)} to ${roles.owner} on Monad mainnet (chain 143) and run again`,
      );
    console.log(
      `   estimate ${e.gas} gas, at most ${e.mon.toFixed(4)} MON; spent so far ${mon(spent)}`,
    );
    return forgeScript(script, {
      url,
      secrets,
      broadcast: true,
      scope: CANARY_SCOPE,
      env: { ...env, ...stepEnv },
      gasPriceWei: GAS_PRICE_WEI,
    });
  };

  console.log(
    "\n1. The fund set on CanaryAgent: TokenRegistry, ProtocolRegistryV3, OracleAdapterV3, RouteAdapter",
  );
  const fund = fundConfig();
  const fundOut = await step("1 fund set", "script/DeployFund.s.sol:DeployFund", {
    FUND_CONFIG: JSON.stringify(fund),
  });
  const fundSet = {
    tokenRegistry: logged(fundOut, "TOKEN_REGISTRY_ADDRESS"),
    protocolRegistry: logged(fundOut, "PROTOCOL_REGISTRY_V3_ADDRESS"),
    oracle: logged(fundOut, "ORACLE_ADAPTER_V3_ADDRESS"),
    routeAdapter: logged(fundOut, "ROUTE_ADAPTER_ADDRESS"),
    coreTokens: Number(logged(fundOut, "CORE_TOKENS")),
    corePools: Number(logged(fundOut, "CORE_POOLS")),
  };
  if (
    dryRun &&
    (await mainnetRpc(url, "eth_getCode", [fundSet.tokenRegistry, "latest"])) === "0x"
  ) {
    console.log(
      "\ndry run: Executor v3 needs the TokenRegistry on chain, so steps 2 and 3 are not simulated here (pnpm test:canary-fork runs them all on a fork); nothing was sent",
    );
    for (const [name, e] of Object.entries(estimates))
      console.log(
        `   ${name}: ${e ? `${e.gas} gas, at most ${e.mon.toFixed(4)} MON` : "nothing to send"}`,
      );
    process.exit(0);
  }

  console.log(
    "\n2. Executor v3, its RouteAdapter and ProtocolRegistryV3, and the OracleAdapterV3 over it",
  );
  const execOut = await step("2 executor v3", "script/DeployExecutorV3.s.sol:DeployExecutorV3", {
    FUND_CONFIG: JSON.stringify(fund),
    EXECUTOR_V3_TOKEN_REGISTRY: fundSet.tokenRegistry,
    EXECUTOR_V3_AGENT_NFT: canaryAgent,
  });
  const executorSet = {
    executor: logged(execOut, "EXECUTOR_V3_ADDRESS"),
    routeAdapter: logged(execOut, "EXECUTOR_ROUTE_ADAPTER_V3_ADDRESS"),
    protocolRegistry: logged(execOut, "PROTOCOL_REGISTRY_V3_ADDRESS"),
    oracle: logged(execOut, "ORACLE_ADAPTER_V3_ADDRESS"),
    setDeployer: logged(execOut, "EXECUTOR_SET_DEPLOYER_ADDRESS"),
    corePools: Number(logged(execOut, "CORE_POOLS")),
    policyHash: loggedBytes32(execOut, "EXECUTOR_V3_POLICY_HASH"),
  };

  console.log("\n3. AccountFactoryV3 with the Executor given, and the Executor's binding");
  const custodyOut = await step("3 custody v3", "script/DeployCustodyV3.s.sol:DeployCustodyV3", {
    CUSTODY_V3_ADMIN: roles.owner,
    CUSTODY_V3_GUARDIAN: roles.guardian,
    CUSTODY_V3_SENTINEL: "0x0000000000000000000000000000000000000000",
    CUSTODY_V3_AGENT_NFT: canaryAgent,
    CUSTODY_V3_USDC: canaryBook("usdc"),
    CUSTODY_V3_TOKEN_REGISTRY: fundSet.tokenRegistry,
    CUSTODY_V3_ORACLE: executorSet.oracle,
    CUSTODY_V3_EXECUTOR: executorSet.executor,
    CUSTODY_V3_PERSONAL_CAP: CANARY_LIMITS.capE6.toString(),
    CUSTODY_V3_VAULT_CAP: CANARY_LIMITS.capE6.toString(),
    CUSTODY_V3_PLATFORM_CAP: CANARY_LIMITS.capE6.toString(),
    CUSTODY_V3_DEPOSITS_ENABLED: "false",
    CUSTODY_V3_ALLOWLIST: roles.owner,
  });
  const custody = {
    factory: logged(custodyOut, "ACCOUNT_FACTORY_V3_ADDRESS"),
    personalAccountImplementation: logged(custodyOut, "PERSONAL_ACCOUNT_V3_IMPLEMENTATION"),
    vaultImplementation: logged(custodyOut, "STRATEGY_VAULT_V3_IMPLEMENTATION"),
  };
  const bindOut = await step("3 bind", "script/BindExecutorV3.s.sol:BindExecutorV3", {
    EXECUTOR_V3: executorSet.executor,
    EXECUTOR_V3_FACTORY: custody.factory,
    EXECUTOR_V3_POOLS: executorSet.protocolRegistry,
  });
  if (logged(bindOut, "EXECUTOR_V3_BOUND_FACTORY").toLowerCase() !== custody.factory.toLowerCase())
    throw new Error("Executor v3 is bound to another factory");
  if (dryRun) {
    console.log("\ndry run: nothing was sent");
    process.exit(0);
  }

  const transactions = [
    ...(await broadcastRecords(url, "DeployFund.s.sol", MONAD_MAINNET_CHAIN_ID)),
    ...(await broadcastRecords(url, "DeployExecutorV3.s.sol", MONAD_MAINNET_CHAIN_ID)),
    ...(await broadcastRecords(url, "DeployCustodyV3.s.sol", MONAD_MAINNET_CHAIN_ID)),
    ...(await broadcastRecords(url, "BindExecutorV3.s.sol", MONAD_MAINNET_CHAIN_ID)),
  ]
    .filter((t) => t.block >= startBlock)
    .map((t) => ({ ...t, link: txLink(t.hash) }));
  const spent = await spentWei(url, keys, startWei);
  const record = {
    unit: "F-U13",
    chainId: MONAD_MAINNET_CHAIN_ID,
    label:
      "mainnet-canary, throwaway (D-247, D-249, D-250); the v3 trading set on P2-EC's CanaryAgent",
    saltScope: CANARY_SCOPE,
    recordedAt: new Date().toISOString(),
    startBlock,
    roles,
    allowlist: [roles.owner],
    capsE6: {
      personal: CANARY_LIMITS.capE6.toString(),
      vault: CANARY_LIMITS.capE6.toString(),
      platform: CANARY_LIMITS.capE6.toString(),
    },
    facts,
    canaryAgent,
    fund: { ...fundSet, config: fund },
    executorV3: executorSet,
    custodyV3: custody,
    links: Object.fromEntries(
      Object.entries({ canaryAgent, ...fundSet, ...executorSet, ...custody })
        .filter(([, a]) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a))
        .map(([k, a]) => [k, addressLink(/** @type {string} */ (a))]),
    ),
    estimates,
    transactions,
    spentWei: spent.toString(),
  };
  const dir = join(ROOT, "evidence/f-u13");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "canary-deployment.json");
  if (transactions.length > 0) writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\n${transactions.length} transactions; the canary keys spent ${mon(spent)}`);
  for (const t of transactions) console.log(`   ${t.what.padEnd(26)} ${t.link}`);
  console.log(
    `TokenRegistry ${fundSet.tokenRegistry}\nExecutor v3 ${executorSet.executor}\nAccountFactoryV3 ${custody.factory}`,
  );
  if (transactions.length > 0) console.log(`recorded in ${file}`);
  if (spent > DEPLOY_BUDGET_WEI) throw new Error(`the deployment spent ${mon(spent)}, over budget`);
} catch (err) {
  console.error(
    `error: ${(err instanceof Error ? err.message : String(err)).replaceAll(url, "<rpc>")}`,
  );
  process.exit(1);
}
