import {
  MarketData,
  ResearchSources,
  viemMainnetLookup,
  viemMainnetReader,
  TokenDiscovery,
  readOnlyTransport,
  MARKET_CHAIN,
} from "@alpha-agents/market";
import { PgUsageStore } from "./usage-store.ts";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  isMonadTestnet,
  ConfigError,
  TESTNET_CHAIN,
  Secret,
  assertChainId,
  isForkEnvironment,
  loadConfig,
  type ConfigValue,
} from "@alpha-agents/config";
import {
  ViemChainReader,
  ViemChainReaderV3,
  contractsFor,
  contractsForV3,
  rpcTransport,
} from "@alpha-agents/chain-tools";
import { TavilyProvider } from "@alpha-agents/data-tools";
import { createDb, migrateToLatest } from "@alpha-agents/db";
import { localPaths, secretFragments, setMonBalance, startTestFork } from "@alpha-agents/devenv";
import { SPECIES, addressEntry } from "@alpha-agents/domain";
import { tradingProfileFor } from "@alpha-agents/policy";
import { REQUIRED_SOURCES } from "./cycle/research.ts";
import {
  zeroAddress,
  type Hex,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApi } from "./api.ts";
import { SignerWorker } from "./signer-worker.ts";
import { FundingKeys } from "./credits/funding.ts";
import { ViemRefundChain } from "./credits/refunds.ts";
import { LiteLLMAdmin } from "./gateway-admin.ts";
import { KEEPER_POLICY, RevealKeeper } from "./keeper.ts";
import { ViemRevealChain } from "./keeper-chain.ts";
import { Orchestrator } from "./orchestrator.ts";
import { NAMESPACE_PATTERN } from "./provisioner.ts";
import { E2BProvider } from "./sandbox.ts";
import { type RevealSteering, revealSteeringFor } from "./reveal-steer.ts";
import { DbSteerStore } from "./reveal-steer-store.ts";
import { localFeedRefresherFor } from "./local-feeds.ts";
import { localSentinelKey, viemSentinelChain } from "./sentinel-chain.ts";
import { Attestor, attestorKeyFrom, localAttestorKey } from "./attestor.ts";
import {
  REGISTRATIONS_PER_SWEEP,
  Registrar,
  localScreenerKey,
  viemScreenerChain,
} from "./tokens/registrar.ts";

/** F-T2: the registrar's background pass: 30 seconds after the start, then every five minutes. */
const REGISTRAR_FIRST_SWEEP_MS = 30_000;
const REGISTRAR_SWEEP_MS = 5 * 60_000;
import { geckoTerminalSource, poolSpotSource } from "./attestor-sources.ts";
import { ChainClock, withAttestedPrices } from "./attested-reader.ts";
import { Redactor, createLog, errorText } from "./secrets.ts";
import { OwnerKeyStore, TradeStore } from "@alpha-agents/trading";
import { Store } from "./store.ts";
import { findCloudflared } from "./tunnel.ts";
import { testnetGasTopUp } from "./testnet-gas.ts";
import { DeployerQueue } from "./deployer-queue.ts";
import { sweepKeysFrom, sweepPass } from "./gas-sweeper.ts";
import {
  MONAD_TESTNET_MARKET,
  monadOraclePrice,
  monadRecycleChain,
  recyclePass,
} from "./pool-recycler.ts";
import {
  BalanceAlarm,
  DEPLOYER_FLOOR_WEI,
  KEEPER_FLOOR_WEI,
  ntfyNotifier,
} from "./balance-alarm.ts";
import { swapGasCost } from "./trade-flow.ts";
import { testnetFeedsFor, viemFeedChain, withFreshFeeds } from "./testnet-feeds.ts";
import { TokenRegistry, secondaryFirst } from "./tokens/registry.ts";
import { SCREEN_FORK_PORT, ScreenFork } from "./tokens/screen-fork.ts";
import { TokenStore } from "./tokens/store.ts";

/**
 * The orchestrator process (P1-U5): `pnpm dev:orchestrator`.
 *
 *   --namespace=<name>  sweep namespace for tags, key aliases and the queue (default: APP_ENV)
 *   --no-keeper         do not run the reveal keeper
 *   --scan-interval-seconds=<n>  scheduled Scan cadence in seconds, local only (the live check)
 *
 * Reads DATABASE_URL, REDIS_URL, LITELLM_BASE_URL, LITELLM_MASTER_KEY,
 * ORCHESTRATOR_SECRET, ORCHESTRATOR_PORT, E2B_API_KEY,
 * REVEAL_KEEPER_PRIVATE_KEY, FUNDING_ADDRESS_SEED (P1-U6), TAVILY_API_KEY and
 * SCAN_INTERVAL_MINUTES (P1-U7), COINMARKETCAP_API_KEY and MONAD_RPC_URL for
 * research's read-only mainnet reads in every environment (P3-U2, P3-U9). Every secret value is registered with the log's
 * redactor before anything is logged, and none is ever printed.
 */
const ENV_PATH = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const redactor = new Redactor();
const log = createLog("orchestrator", redactor);
const die = (message: string): never => {
  console.error(`error: ${redactor.redact(message)}`);
  process.exit(1);
};
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function loadOrDie() {
  try {
    return loadConfig({
      name: "orchestrator",
      requires: [
        "DATABASE_URL",
        "REDIS_URL",
        "LITELLM_BASE_URL",
        "LITELLM_MASTER_KEY",
        "ORCHESTRATOR_SECRET",
        "ORCHESTRATOR_PORT",
      ],
    });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return die(err.message);
  }
}
const config = loadOrDie();
const values = config.values;
// Every credential-bearing part of every secret, except loopback hosts (not secrets, and in
// every local log line).
const protect = (value: string) => {
  for (const f of secretFragments(value))
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(f)) redactor.add(f);
};
for (const v of Object.values(values) as ConfigValue[])
  if (v instanceof Secret) protect(v.reveal());
const rpcUrl = config.rpcUrl?.reveal() ?? die("the orchestrator needs the chain RPC");
protect(rpcUrl);
const reveal = (name: keyof typeof values) => (values[name] as Secret | undefined)?.reveal();

const env = config.environment;
const namespace = arg("namespace") ?? env.id;
if (!NAMESPACE_PATTERN.test(namespace)) die(`invalid --namespace ${namespace}`);
const secret = reveal("ORCHESTRATOR_SECRET") ?? die("ORCHESTRATOR_SECRET is not set");
if (!isForkEnvironment(env.id) && secret.startsWith("local-fork-only"))
  die(`ORCHESTRATOR_SECRET is the local default; set a random one for ${env.label}`);

// P2-EC: off the fork the environment's second provider takes over when the first fails
// (D-254); on testnet config reads it from MONAD_TESTNET_RPC_URL_SECONDARY.
const fallbackRpcUrl = isForkEnvironment(config.environment.id)
  ? null
  : (reveal("MONAD_RPC_URL_SECONDARY") ?? null);
if (fallbackRpcUrl) protect(fallbackRpcUrl);
const client = createPublicClient({ transport: rpcTransport(rpcUrl, fallbackRpcUrl) });
// 2026-10-16: off the fork the keeper, the signer and trade flow, and the sentinel take the second
// provider first, so their sends and receipt polls stop competing with the indexer and research
// for the first provider's rate limit (429s on Monad testnet); the first stays their fallback.
const sendRpcUrl = fallbackRpcUrl ?? rpcUrl;
const sendFallbackRpcUrl = fallbackRpcUrl ? rpcUrl : null;
const sendClient = fallbackRpcUrl
  ? createPublicClient({ transport: rpcTransport(sendRpcUrl, sendFallbackRpcUrl) })
  : client;
try {
  assertChainId(config, await client.getChainId());
  // The fallback must serve the same chain, or it is never used (P2-EC).
  if (fallbackRpcUrl)
    assertChainId(
      config,
      await createPublicClient({ transport: http(fallbackRpcUrl) }).getChainId(),
    );
} catch (err) {
  die(err instanceof ConfigError ? err.message : "could not reach the chain RPC");
}
const nft = addressEntry(env.id, "agent_nft");
if (nft.status !== "verified")
  die(`AgentNFT is not deployed on ${env.label} (address book: unverified)`);
const entropy = addressEntry(env.id, "pyth_entropy");

const litellmUrl = String(values.LITELLM_BASE_URL);
const gateway = new LiteLLMAdmin(litellmUrl, reveal("LITELLM_MASTER_KEY") ?? "");
let ready = false;
for (let i = 0; i < 15 && !(ready = await gateway.ready()); i += 1)
  await new Promise((r) => setTimeout(r, 2_000));
if (!ready)
  die(
    `LiteLLM is not answering at ${litellmUrl}. Start it with: ` +
      "docker compose -f infra/compose.yaml --env-file .env --profile agent up -d --wait litellm",
  );

const e2bKey = reveal("E2B_API_KEY");
const provider = e2bKey ? new E2BProvider(e2bKey) : null;
if (!provider) log("E2B_API_KEY is not set: provisioning runs, sandboxes and tasks do not");
let cloudflared: string | null = null;
try {
  cloudflared = findCloudflared();
} catch {
  log("cloudflared is not installed: sandboxes cannot reach the gate, so tasks will fail");
}

const db = createDb(reveal("DATABASE_URL") ?? "", { max: 10 });
await migrateToLatest(db);

// D-221: steered reveals on the local fork only; null in every other environment.
// Steers live in Postgres, so a restart keeps them.
let steering: RevealSteering | null = null;
try {
  steering = revealSteeringFor(
    env.id,
    values.LOCAL_FIRST_REVEAL_SPECIES as string | undefined,
    new DbSteerStore(db),
    env.chainId,
  );
} catch (err) {
  die(errorText(err, redactor));
}
if (steering)
  log(
    `local fork: agent #1 reveals as ${steering.firstSpecies === null ? "random" : (SPECIES[steering.firstSpecies - 1]?.name ?? "?")} on a fresh fork; the dev console can steer a wallet's or a pending agent's reveal`,
  );
let keeper: RevealKeeper | null = null;
const keeperKey = env.id === "beta" ? undefined : reveal("REVEAL_KEEPER_PRIVATE_KEY");
if (process.argv.includes("--no-keeper")) log("reveal keeper off (--no-keeper)");
// CO-U1: an L2 testnet's agents are the platform's copies, revealed at mint; nothing to reveal.
else if (env.id === "testnet" && !isMonadTestnet(TESTNET_CHAIN))
  log(`reveal keeper off: agents on ${TESTNET_CHAIN.name} are copies, revealed at mint`);
else if (!keeperKey) log("REVEAL_KEEPER_PRIVATE_KEY is not set: the reveal keeper is off");
else if (entropy.status !== "verified")
  log(`no Pyth Entropy on ${env.label}: the reveal keeper is off`);
else {
  const chain = new ViemRevealChain({
    rpcUrl: sendRpcUrl,
    fallbackRpcUrl: sendFallbackRpcUrl,
    chainId: env.chainId,
    agentNft: nft.address as Hex,
    entropy: entropy.address as Hex,
    privateKey: keeperKey as Hex,
    localFork: isForkEnvironment(env.id),
    ...(steering ? { steering } : {}),
    log: createLog("keeper", redactor),
  });
  keeper = new RevealKeeper({
    chain,
    policy: isForkEnvironment(env.id) ? KEEPER_POLICY.local : KEEPER_POLICY.remote,
    log: createLog("keeper", redactor),
    redactor,
  });
  log(`reveal keeper on: wallet ${chain.address}, window ${isForkEnvironment(env.id) ? 10 : 60} s`);
}

/** CO-U1: the deployer tops a session key up for a swap's gas on the testnet stacks (testnet-gas.ts). */
const testnetDeployerKey =
  env.id === "testnet" ? (reveal("TESTNET_DEPLOYER_PRIVATE_KEY") as Hex | undefined) : undefined;
const testnetDeployer = testnetDeployerKey ? privateKeyToAccount(testnetDeployerKey).address : null;
/**
 * 2026-10-18 (owner): Monad testnet's base fee sits at its floor, and the node holds a swap's
 * limit at its max fee against the key, so the max fee there is the base fee plus the tip;
 * elsewhere twice the base fee plus the tip (A-38).
 */
const feeBaseMultiple = env.id === "testnet" && isMonadTestnet(TESTNET_CHAIN) ? 1n : 2n;

const seed = env.id === "beta" ? undefined : reveal("FUNDING_ADDRESS_SEED");
// The signer (P2-U4): Executor swaps, and refunds and settlements (D-261), from session keys
// derived from the funding seed (D-243) on the fork and testnet; the beta waits for KMS keys
// (D-244, PB-U1). It starts before credits, which hand it every refund.
let signerWorker: SignerWorker | null = null;
if (!seed) log("signer off: FUNDING_ADDRESS_SEED is not set");
else if (env.id === "beta") log("signer off: the beta signs with KMS keys (D-244), bound in PB-U1");
else {
  try {
    const secondary = reveal("MONAD_RPC_URL_SECONDARY");
    const treasury = values.PLATFORM_TREASURY_ADDRESS as string | undefined;
    signerWorker = new SignerWorker({
      db,
      environment: env.id,
      rpcUrl: sendRpcUrl,
      ...(sendFallbackRpcUrl
        ? { secondaryRpcUrl: sendFallbackRpcUrl }
        : secondary
          ? { secondaryRpcUrl: secondary }
          : {}),
      seed: seed as Hex,
      ...(treasury ? { treasury: treasury as Hex } : {}),
      maxFeeBaseMultiple: feeBaseMultiple,
      ...(testnetDeployer ? { gasSweepTo: testnetDeployer } : {}),
      log: createLog("signer", redactor),
    });
    await signerWorker.start();
    log(
      `signer on: chain ${signerWorker.signer.pinnedChainId}, Executor swaps and USDC refunds${treasury ? " and settlements" : ""}`,
    );
  } catch (err) {
    signerWorker = null;
    log(`signer off: ${errorText(err, redactor)}`);
  }
}

// Credits (P1-U6): funding addresses from the seed, refunds through the signer (D-261).
const usdc = addressEntry(env.id, "usdc");
let credits = null;
if (!seed) log("FUNDING_ADDRESS_SEED is not set: credits, deposits and refunds are off");
else {
  const keys = new FundingKeys(seed as Hex);
  const refundChain =
    usdc.status === "verified"
      ? new ViemRefundChain({
          rpcUrl,
          fallbackRpcUrl,
          chainId: env.chainId,
          agentNft: nft.address as Hex,
          usdc: usdc.address as Hex,
        })
      : null;
  if (!refundChain) log(`no USDC in the address book for ${env.label}: refunds stay requested`);
  if (!signerWorker)
    log("refunds wait: the signer is off, and every refund goes through it (D-261)");
  credits = {
    keys,
    refundChain,
    refundSigner: signerWorker?.signer ?? null,
    environment: env.label,
  };
  log("credits on: funding addresses, deposits, metering, budgets and refunds");
}

// Tools (P1-U7): web_search and read_url through Tavily; Scans on the configured cadence.
const tavilyKey = reveal("TAVILY_API_KEY");
const web = tavilyKey ? new TavilyProvider(tavilyKey) : null;
if (!web)
  log("TAVILY_API_KEY is not set: web_search and read_url answer that they are not configured");
// Market data (P3-U2): CoinMarketCap and DefiLlama, and research's mainnet reads (D-289), in one
// cache shared by every agent. A refused figure is logged; the log never carries a key or a URL.
const cmcKey = reveal("COINMARKETCAP_API_KEY") ?? null;
// D-289: research reads mainnet in every environment, testnet included, through the config's
// research-only URLs (never the environment's chain RPC) on a transport that refuses anything
// but a read. On testnet MONAD_RPC_URL_SECONDARY means the testnet's second provider, so the
// mainnet URLs come only from config.researchRpcUrls.
const mainnetUrls = config.researchRpcUrls.map((u) => u.reveal());
for (const u of mainnetUrls) protect(u);
// Daily budgets (CoinMarketCap credits, X posts, Dune requests) persist in Postgres (P3-U9).
const usage = new PgUsageStore(db);
const market = new MarketData({
  usage,
  cmcApiKey: cmcKey,
  mainnet: mainnetUrls.length > 0 ? viemMainnetReader(mainnetUrls) : null,
  onRefuse: (r) =>
    log(
      `market data: refused ${r.field} from ${r.source} (${String(r.value).slice(0, 40)}), outside ${r.range[0]} to ${r.range[1]}`,
    ),
});
log(
  `market data on: CoinMarketCap ${cmcKey ? "configured" : "not configured"}, DefiLlama, mainnet reads ${mainnetUrls.length > 0 ? "configured" : "not configured"}`,
);
// Research sources (P3-U9): X search, saved Dune queries and mainnet lookups, on the market
// service's cache and Postgres budgets. Each key is optional; without it the tool says so.
const xToken = reveal("X_BEARER_TOKEN") ?? null;
const duneKey = reveal("DUNE_API_KEY") ?? null;
const research = new ResearchSources({
  market,
  xBearerToken: xToken,
  duneApiKey: duneKey,
  lookup: mainnetUrls.length > 0 ? viemMainnetLookup(mainnetUrls) : null,
});
log(
  `research sources on: X ${xToken ? "configured" : "not configured"}, Dune ${duneKey ? "configured" : "not configured"}, mainnet lookups ${mainnetUrls.length > 0 ? "configured" : "not configured"}`,
);
// Token registry (F-U1): discovery from GeckoTerminal, CoinGecko and CoinMarketCap, every pool
// and token confirmed on mainnet through the read-only transport; screens on a fork of the
// latest block of their own (never the playtest fork), forked from the same research URLs,
// the secondary first so these reads stop competing with the forks and research for one key.
const tokenUrls = secondaryFirst(mainnetUrls);
const tokenDiscovery =
  mainnetUrls.length > 0
    ? new TokenDiscovery({
        market,
        cmcApiKey: cmcKey,
        client: createPublicClient({ transport: readOnlyTransport(tokenUrls) }) as PublicClient,
      })
    : null;
// --screen-fork-port lets a second orchestrator (the live run) keep its fork apart from dev's.
const screenForkPort = Number(arg("screen-fork-port") ?? SCREEN_FORK_PORT);
if (!Number.isInteger(screenForkPort) || screenForkPort <= 8545 || screenForkPort > 65_535)
  die("--screen-fork-port takes a port above 8545");
// M-FAST (A-98): devenv's test fork is a fork of Monad; the base environment runs no screens.
const screenFork =
  mainnetUrls.length > 0 && MARKET_CHAIN.key === "monad"
    ? new ScreenFork({
        start: () =>
          startTestFork({
            port: screenForkPort,
            block: "latest",
            env: {
              MONAD_RPC_URL: tokenUrls[0],
              ...(tokenUrls[1] ? { MONAD_RPC_URL_SECONDARY: tokenUrls[1] } : {}),
            },
          }),
      })
    : null;
const tokenRegistry = new TokenRegistry({
  // M-FAST: the chain researched (Monad's 143, or Base's 8453), the token table's chain id (L-216).
  chainId: MARKET_CHAIN.chainId,
  store: new TokenStore(db),
  market,
  discovery: tokenDiscovery,
  fork: screenFork,
});
// --token-loops=off keeps the registry for the tools and the console but runs no discovery or screens.
const tokenLoops = arg("token-loops") !== "off";
log(
  `token registry on: discovery ${tokenDiscovery ? "configured" : "not configured"}, screens ${screenFork ? `on a latest-block fork at port ${screenForkPort}` : "not configured"}, loops ${tokenLoops ? "on" : "off"}; GoPlus has no API key and runs keyless`,
);
const scanSeconds = arg("scan-interval-seconds");
if (
  scanSeconds !== undefined &&
  (!isForkEnvironment(env.id) || !/^[1-9]\d{0,5}$/.test(scanSeconds))
)
  die("--scan-interval-seconds takes a whole number of seconds, and only with APP_ENV=local");
const scanIntervalMs =
  scanSeconds !== undefined
    ? Number(scanSeconds) * 1_000
    : Number(values.SCAN_INTERVAL_MINUTES ?? 360) * 60_000;
// P2-EC: on testnet Scans run only when the owner starts one; nothing is scheduled.
// D-369: scheduled research runs only when the owner turns it on for the session (locally it is
// off by default, so a funded agent never spends model credit on its own while someone develops).
const scheduledResearch = (values.SCHEDULED_RESEARCH as string | undefined) === "on";
const scheduleScans = env.id !== "testnet" && scheduledResearch;
if (credits)
  log(
    scheduleScans
      ? "the research loop is on (P3-U10): activated agents research at their intensity's cadence under the day's budget, and the watcher's triggers start cycles"
      : env.id === "testnet"
        ? "scheduled Scans off on testnet: a Scan runs only when the owner starts one"
        : "the research loop is off (D-369): a Scan or cycle runs only when the owner starts one; SCHEDULED_RESEARCH=on turns the loop on for a session",
  );

// D-237: on the local fork only, keep the Chainlink feeds fresh so oracle checks pass.
const localFeeds = localFeedRefresherFor(env.id, rpcUrl);
if (localFeeds)
  log(
    `local fork: Chainlink feeds re-dated every ${localFeeds.everyMs / 1_000} s (LocalFeed, D-237)`,
  );

const store = new Store(db);
// Chain tools (P2-U5): every contract from this environment's address book, so the same
// server reads the fork, testnet and mainnet; where any is missing, every chain tool says so.
const chainContracts = contractsFor(env.id);
const chainReader = chainContracts.ok
  ? new ViemChainReader({
      chainId: env.chainId,
      rpcUrl,
      fallbackRpcUrl,
      contracts: chainContracts.contracts,
    })
  : null;
if (!chainContracts.ok)
  log(
    `chain tools: not deployed on ${env.label} (${chainContracts.missing.join(", ")} not in the address book); every chain tool says so`,
  );
// F-U5: the fund agent's v3 set; an agent whose owner opened a PersonalAccountV3 gets the v3 tools (D-367).
const chainContractsV3 = contractsForV3(env.id);
// Step 0 (2026-10-12, A-90): the reader resolves the agent's account by the owner's stored choice.
const managedAccounts = new TradeStore(store.db);
const ownerKeys = new OwnerKeyStore(store.db);
const plainReaderV3 = chainContractsV3.ok
  ? new ViemChainReaderV3({
      chainId: env.chainId,
      rpcUrl,
      fallbackRpcUrl,
      contracts: chainContractsV3.contracts,
      managedAccount: (agentId) => managedAccounts.managedAccount(env.chainId, agentId),
    })
  : null;
// F-U12: the price attestor signs class A prices as the median of the chain's own pools and
// GeckoTerminal, with anvil account 2 on the local fork and the testnet key where set; every
// reader of the market then sees class A tokens at the attestor's price.
const attestorKey = isForkEnvironment(env.id)
  ? localAttestorKey()
  : env.id === "testnet"
    ? ((reveal("TESTNET_ATTESTOR_PRIVATE_KEY") as Hex | undefined) ?? null)
    : null;
// The attestor's clock is the chain's (a local fork runs days ahead after the verifier's timelock).
const chainClock = new ChainClock();
const attestor =
  plainReaderV3 && attestorKey
    ? new Attestor({
        chainId: env.chainId,
        verifier: async () => {
          const v = (await plainReaderV3.market()).verifier;
          return v && v !== zeroAddress ? v : null;
        },
        key: attestorKeyFrom(attestorKey),
        sources: [poolSpotSource(plainReaderV3), geckoTerminalSource(market)],
        now: () => chainClock.now(),
        log: createLog("attestor", redactor),
      })
    : null;
const chainReaderV3 =
  plainReaderV3 && attestor
    ? withAttestedPrices(plainReaderV3, attestor, chainClock)
    : plainReaderV3;
// F-U12: the screened-lane registrar, on the screener key (anvil account 3 locally, D-342): a token
// that passes its screen joins the screened lane at once with its pools; a refused re-screen moves
// it to sell-only; the chain's lanes are mirrored into the token table at start and after each act.
const screenerKey = isForkEnvironment(env.id)
  ? localScreenerKey()
  : env.id === "testnet"
    ? ((reveal("TESTNET_SCREENER_PRIVATE_KEY") as Hex | undefined) ?? null)
    : null;
const registrar =
  plainReaderV3 && screenerKey && chainContractsV3.ok
    ? new Registrar({
        // The token table is keyed by Monad mainnet's chain id (the registry's), not the fork's (L-216).
        chainId: tokenRegistry.chainId,
        store: tokenRegistry.store,
        chain: viemScreenerChain({
          rpcUrl,
          chainId: env.chainId,
          privateKey: screenerKey,
          tokenRegistry: chainContractsV3.contracts.token_registry_v3,
          protocolRegistry: chainContractsV3.contracts.protocol_registry_v3,
        }),
        reader: plainReaderV3,
        log: createLog("registrar", redactor),
      })
    : null;
if (registrar) tokenRegistry.attachRegistrar(registrar);
log(
  registrar
    ? `screened-lane registrar on: screener ${registrar.address}; a passing screen registers the token at once`
    : "screened-lane registrar off: a passing screen registers nothing on chain here",
);
log(
  attestor
    ? `price attestor on: key ${attestor.address} (class A prices as the median of the pool and GeckoTerminal, 60 s)`
    : "price attestor off: class A tokens are not tradable here (set TESTNET_ATTESTOR_PRIVATE_KEY on testnet)",
);
if (!chainContractsV3.ok)
  log(
    `chain tools v3: not deployed on ${env.label} (${chainContractsV3.missing.join(", ")} not in the address book); agents stay on the v2 tools`,
  );
const chainSigner = signerWorker?.signer ?? null;

// P2-EC (D-307): on testnet the TestnetFeeds are re-dated on demand, before every market read
// of a proposal's or a submission's checks and before an owner's deposit; never on a timer.
// 2026-10-16: the dev stack prices by its pairs (QuoteOracleV3) and has no feeds; it must never
// re-date the judged Monad stack's feeds with the shared feed key.
const feedKey =
  env.id === "testnet" && TESTNET_CHAIN.standIns ? reveal("TESTNET_FEED_PRIVATE_KEY") : undefined;
const feedAddress = (id: "chainlink_mon_usd" | "chainlink_usdc_usd") => {
  const e = addressEntry(env.id, id);
  return e.status === "verified" ? (e.address as Hex) : null;
};
const testnetFeeds = testnetFeedsFor(env.id, {
  chain: feedKey ? viemFeedChain(rpcUrl, env.chainId, feedKey as Hex, fallbackRpcUrl) : null,
  monUsd: feedAddress("chainlink_mon_usd"),
  usdcUsd: feedAddress("chainlink_usdc_usd"),
  log: createLog("feeds", redactor),
});
if (env.id === "testnet" && !TESTNET_CHAIN.standIns)
  log("testnet feeds: none; the dev stack prices each token by its own pair (QuoteOracleV3)");
else if (env.id === "testnet")
  log(
    testnetFeeds
      ? "testnet feeds: re-dated on demand before checks, submissions and deposits (D-307)"
      : "testnet feeds: TESTNET_FEED_PRIVATE_KEY is not set, so nothing re-dates them; deposits and trades will be refused with ORACLE_STALE",
  );
const toolsReader =
  chainReader && testnetFeeds ? withFreshFeeds(chainReader, testnetFeeds) : chainReader;

// The trade flow (P2-U6) sends swaps through the signer; the local fork tops gas up and
// treats its receipts as final, every other chain settles a trade only once finalized.
const local = isForkEnvironment(env.id);
// P2-EC: off the fork every read is metered by the RPC provider, and the 2-second loops of the
// fork (the keeper, credits, the trade flow) together with the indexer exceeded a free plan's
// rate limit on testnet. Real chains poll these every 5 seconds.
const REMOTE_POLL_MS = 5_000;
/**
 * 2026-10-17: the TestnetFeeds' bound in OracleAdapterV3 on the stand-in testnets (the deployed
 * sets' usdMaxAge, evidence/co-u1-monad/testnet-deployment.json): 30 days.
 */
const TESTNET_SENTINEL_FEED_MAX_AGE_S = 30 * 24 * 3_600;
const deployerWallet = testnetDeployerKey
  ? createWalletClient({
      account: privateKeyToAccount(testnetDeployerKey),
      chain: {
        id: env.chainId,
        name: env.label,
        nativeCurrency: {
          name: TESTNET_CHAIN.native,
          symbol: TESTNET_CHAIN.native,
          decimals: 18,
        },
        rpcUrls: { default: { http: [] } },
      },
      transport: rpcTransport(sendRpcUrl, sendFallbackRpcUrl),
    })
  : null;
// 2026-10-18: the top-ups and the pool recycler send from the one deployer key, one at a time.
const deployerQueue = new DeployerQueue();
const testnetTopUp =
  deployerWallet && testnetDeployer
    ? testnetGasTopUp({
        chain: {
          deployer: testnetDeployer,
          balance: (address) => sendClient.getBalance({ address }),
          blockNumber: () => sendClient.getBlockNumber({ cacheTime: 0 }),
          send: (to, value) =>
            deployerQueue.run(async () => {
              // A plain transfer, and Monad bills the limit: 21,000, never a wrapper's estimate (L-270).
              const hash = await deployerWallet.sendTransaction({ to, value, gas: 21_000n });
              const receipt = await sendClient.waitForTransactionReceipt({
                hash,
                timeout: 120_000,
              });
              return { hash, status: receipt.status, blockNumber: receipt.blockNumber };
            }),
        },
        log,
      })
    : null;

const trading = chainSigner
  ? {
      signer: chainSigner,
      ...(local ? {} : { everyMs: REMOTE_POLL_MS }),
      gas: {
        balance: (address: Hex) => sendClient.getBalance({ address }),
        swapCost: async (gas?: bigint) => {
          const [block, tip] = await Promise.all([
            sendClient.getBlock(),
            sendClient.estimateMaxPriorityFeePerGas().catch(() => 0n),
          ]);
          return swapGasCost(block.baseFeePerGas ?? 0n, tip, gas, feeBaseMultiple);
        },
        ...(local
          ? { topUp: (address: Hex, wei: bigint) => setMonBalance(address, wei, rpcUrl) }
          : testnetTopUp
            ? { topUp: testnetTopUp }
            : {}),
      },
      // CO-U1: an L2's finalized block trails by L1 finality (about 20 minutes on Base and
      // Arbitrum Sepolia), so a trade there settles at the safe block instead.
      finalizedBlock: async () =>
        local
          ? null
          : (
              await sendClient.getBlock({
                blockTag:
                  env.id === "testnet" && !isMonadTestnet(TESTNET_CHAIN) ? "safe" : "finalized",
              })
            ).number,
    }
  : null;
if (!trading) log("trade flow: off (no signer); proposals wait and nothing is sent");

// P4-U2: the Risk Sentinel's key: anvil account 5 on the local fork (D-230), the testnet key
// where set; the beta's KMS key is bound in PB-U1. Without one the sentinel sets agent states only.
const sentinelKey = isForkEnvironment(env.id)
  ? localSentinelKey()
  : env.id === "testnet"
    ? ((reveal("TESTNET_SENTINEL_PRIVATE_KEY") as Hex | undefined) ?? null)
    : null;
const sentinelChain = sentinelKey
  ? viemSentinelChain({
      rpcUrl: sendRpcUrl,
      fallbackRpcUrl: sendFallbackRpcUrl,
      chainId: env.chainId,
      privateKey: sentinelKey,
    })
  : null;
log(
  sentinelChain
    ? `risk sentinel on: key ${sentinelChain.address} (tighten-only, D-138), every 30 s`
    : "risk sentinel on without a key: agent states only (set TESTNET_SENTINEL_PRIVATE_KEY to tighten accounts)",
);

// HOST-U1: the demo's spending guard, from DEMO_RESEARCH_ALLOWLIST and DEMO_DAILY_MODEL_BUDGET_USD.
const demoAllowlist = String(values.DEMO_RESEARCH_ALLOWLIST ?? "")
  .split(",")
  .map((w) => w.trim())
  .filter((w) => /^0x[0-9a-fA-F]{40}$/.test(w)) as Hex[];
const demoBudgetRaw = values.DEMO_DAILY_MODEL_BUDGET_USD;
const demoBudget = demoBudgetRaw === undefined ? null : Number(demoBudgetRaw);
const demo =
  demoAllowlist.length > 0 || demoBudget !== null
    ? { allowlist: demoAllowlist.length > 0 ? demoAllowlist : null, dailyBudgetUsd: demoBudget }
    : undefined;
if (demo)
  log(
    `demo guard on: research for ${demo.allowlist ? `${demo.allowlist.length} allowlisted owner wallets` : "every owner"}${demo.dailyBudgetUsd !== null ? `, under ${demo.dailyBudgetUsd} USD of model spend a day` : ""}`,
  );
const orchestrator = new Orchestrator({
  store,
  gateway,
  provider,
  keeper,
  localFeeds,
  attestor,
  sentinel: {
    chain: sentinelChain,
    ...(local ? {} : { everyMs: 60_000 }),
    // 2026-10-17: on a stand-in testnet the feeds are TestnetFeeds, re-dated only on demand
    // before a check or a trade (D-307), so between trades they are hours or days old while
    // the oracle still accepts them (its bound is 30 days on this deploy). The sentinel judges
    // them by the oracle's bound, not by the 1-hour rule meant for Chainlink: with the 1-hour
    // rule it set agent #2's account to reduce-only the morning after its trades (STALE_FEED)
    // and would do so again right after the owner resumed it.
    ...(local
      ? { rules: { chainMaxAgeSeconds: null } }
      : env.id === "testnet" && TESTNET_CHAIN.standIns
        ? { rules: { feedMaxAgeSeconds: TESTNET_SENTINEL_FEED_MAX_AGE_S } }
        : {}),
    ...(signerWorker
      ? {
          fundingAddressOf: (agentId: number) => signerWorker.signer.keyAddress(agentId),
          signerAlive: () => signerWorker.alive(),
        }
      : {}),
    gas: {
      balance: (address: Hex) => sendClient.getBalance({ address }),
      swapCost: async () => {
        const [block, tip] = await Promise.all([
          sendClient.getBlock(),
          sendClient.estimateMaxPriorityFeePerGas().catch(() => 0n),
        ]);
        return swapGasCost(block.baseFeePerGas ?? 0n, tip, undefined, feeBaseMultiple);
      },
    },
  },
  chainId: env.chainId,
  namespace,
  redisUrl: reveal("REDIS_URL") ?? "",
  secret,
  litellmUrl,
  devDir: localPaths().devDir,
  cloudflared,
  startingBudgetUsd: 1,
  redactor,
  log,
  credits,
  web,
  market,
  research,
  // BK-U1: an owner's own Dune key, opened from its sealed row for that agent's calls alone and
  // registered with the redactor the moment it is opened; it never reaches the sandbox.
  ownerKey: async (identity, provider) => {
    const key = await ownerKeys.open(identity.chainId, identity.agentId, provider, secret);
    if (key) redactor.add(key);
    return key;
  },
  tokens: {
    registry: tokenRegistry,
    // P-SWEEP (D-384): research also studies Base's tokens (scripts' research discovery writes them).
    researchChains:
      MARKET_CHAIN.key === "monad"
        ? [
            {
              chainId: 8453,
              name: "Base",
              whyNot: "research only: on Base, where this owner has no trading account (D-384)",
            },
          ]
        : [],
    ...(tokenLoops ? {} : { discoverEveryMs: 0, screenEveryMs: 0 }),
  },
  // P3-U3: the runner's buy brake reads MON's 24-hour volatility from the shared market data
  // (DefiLlama's recorded price, D-289); a refused or stale figure counts as unreadable.
  runner: {
    volatility24hPct: async () => {
      const f = (await market.volatility()).value.windows["24h"];
      return f.value === null || f.warnings.some((w) => w.code === "STALE") ? null : f.value;
    },
    // 2026-10-13: the testnet profile on testnet alone (no minimum trade, gas in the cost);
    // never on mainnet or the beta. Gas is priced at MON's real price, mainnet Chainlink MON/USD,
    // since the testnet feed's MON price is not a market price.
    profile: tradingProfileFor(env.id),
    // CO-U1 (owner): on the testnet stacks a missing MON volatility reading defaults to 100%
    // annualized, with a warning, and buys go ahead; elsewhere it still holds them.
    fallbackVolatility24hPct: env.id === "testnet" ? 100 : null,
    // CO-U1 (owner, 2026-10-15): on the testnet stacks the runner looks every 10 seconds, so the
    // next leg goes out within seconds of the previous one confirming; elsewhere every minute.
    ...(env.id === "testnet" ? { everyMs: 10_000 } : {}),
    gasMonUsdE18: async () => {
      const f = (await market.oracleVsPool()).value.chainlinkMonUsd;
      if (f.value === null || f.warnings.some((w) => w.code === "STALE")) return null;
      return parseUnits(f.value.toFixed(12), 18);
    },
  },
  scanIntervalMs,
  // 2026-10-13 (owner): a Scan and each Dive search the web and X at least once.
  requiredSources: REQUIRED_SOURCES,
  requireScanTokens: true,
  ...(scheduleScans ? {} : { scheduleMs: 0 }),
  ...(local ? {} : { keeperMs: REMOTE_POLL_MS, creditsMs: REMOTE_POLL_MS }),
  revealSteering: steering,
  snapshotReader: chainReader,
  chain: {
    reader: toolsReader,
    readerV3: chainReaderV3,
    ...(chainSigner ? { sessionKeyOf: (agentId: number) => chainSigner.createKey(agentId) } : {}),
  },
  trading,
  ...(demo ? { demo } : {}),
});
await orchestrator.start();
// F-T2: the registrar's background pass, with the token loops: every fresh passing token joins the
// screened lane without waiting for a sweep to screen it, at most REGISTRATIONS_PER_SWEEP a pass.
if (registrar && tokenLoops) {
  const pass = () =>
    registrar
      .sweep(REGISTRATIONS_PER_SWEEP)
      .then((actions) => {
        if (actions.length > 0)
          log(
            `registrar: sweep: ${actions.map((a) => `${a.action} ${a.token}${a.gasUsed !== null ? ` (${a.gasUsed} gas)` : ""}`).join(", ")}`,
          );
      })
      .catch((err: unknown) => log(`registrar: sweep failed: ${errorText(err, redactor)}`));
  setTimeout(() => void pass(), REGISTRAR_FIRST_SWEEP_MS).unref();
  setInterval(() => void pass(), REGISTRAR_SWEEP_MS).unref();
  log(
    `registrar: a background pass every ${REGISTRAR_SWEEP_MS / 60_000} minutes registers up to ${REGISTRATIONS_PER_SWEEP} passing tokens`,
  );
}
// 2026-10-18 (owner): the testnet deployer funds gas only. Each key keeps one leg's most gas
// (gas-sweeper.ts), the pool recycler keeps Monad testnet's MON/USDC centred from the stand-in
// pools (pool-recycler.ts), and an ntfy alarm watches the deployer and the reveal keeper.
const background = (name: string, everyMs: number, firstMs: number, fn: () => Promise<void>) => {
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    void fn()
      .catch((err: unknown) => log(`${name}: pass failed: ${errorText(err, redactor)}`))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(pass, firstMs).unref();
  setInterval(pass, everyMs).unref();
};
if (env.id === "testnet" && signerWorker && testnetDeployer && trading) {
  const sweeper = signerWorker.signer;
  background("gas sweep", 60_000, 20_000, async () => {
    await sweepPass({
      keys: () => sweepKeysFrom(db, env.chainId),
      sweep: (agentId, o) => sweeper.sweepGas(agentId, o),
      swapCost: (gas) => trading.gas.swapCost(gas),
      log,
    });
  });
  log(
    `gas sweep on: every minute, a key's MON above one leg's most gas goes back to ${testnetDeployer}`,
  );
}
if (env.id === "testnet" && isMonadTestnet(TESTNET_CHAIN) && deployerWallet && testnetDeployer) {
  const chain = monadRecycleChain({
    reader: sendClient as PublicClient,
    wallet: deployerWallet,
    deployer: testnetDeployer,
    queue: deployerQueue,
  });
  background("pool recycler", 5 * 60_000, 2 * 60_000, async () => {
    const run = await recyclePass({
      chain,
      standIns: MONAD_TESTNET_MARKET.standIns,
      oraclePrice: () => monadOraclePrice(sendClient as PublicClient),
      log,
    });
    if (run.stopped) log(`pool recycler: ${run.plan.why}; stopped: ${run.stopped}`);
  });
  log("pool recycler on: every 5 minutes, MON/USDC re-centred from the stand-in pools");
}
const ntfyTopic = env.id === "testnet" ? reveal("NTFY_TOPIC") : undefined;
if (env.id === "testnet" && !ntfyTopic) log("balance alarm off: NTFY_TOPIC is not set");
else if (ntfyTopic) {
  redactor.add(ntfyTopic);
  const watched = [
    ...(testnetDeployer
      ? [{ label: "deployer", address: testnetDeployer, floorWei: DEPLOYER_FLOOR_WEI }]
      : []),
    ...(keeperKey
      ? [
          {
            label: "reveal keeper",
            address: privateKeyToAccount(keeperKey as Hex).address,
            floorWei: KEEPER_FLOOR_WEI,
          },
        ]
      : []),
  ];
  const alarm = new BalanceAlarm({
    watched,
    balance: (address) => sendClient.getBalance({ address }),
    notify: ntfyNotifier(
      (values.NTFY_SERVER as string | undefined) ?? "https://ntfy.sh",
      ntfyTopic,
    ),
    chainLabel: env.label,
    log,
  });
  background("balance alarm", 5 * 60_000, 30_000, async () => {
    await alarm.check();
  });
  log(`balance alarm on: ${watched.map((w) => w.label).join(" and ")}, every 5 minutes`);
}
if (registrar)
  void registrar
    .sync()
    .then((n) => log(`registrar: ${n} registered tokens' lanes mirrored into the token table`))
    .catch((err: unknown) => log(`registrar: sync failed: ${errorText(err, redactor)}`));

const port = Number(values.ORCHESTRATOR_PORT);
const api = createApi({
  orchestrator,
  store,
  chainId: env.chainId,
  devActions: isForkEnvironment(env.id),
  operatorActions: env.id !== "beta",
  feeds: testnetFeeds,
  signer: signerWorker,
  forkUrl: local ? rpcUrl : null,
  market,
  research,
  tokens: tokenRegistry,
});
const server = serve({ fetch: api.fetch, port, hostname: "127.0.0.1" });
log(
  `internal API on http://127.0.0.1:${port} (dev actions ${isForkEnvironment(env.id) ? "on" : "off"}, operator actions ${env.id === "beta" ? "off" : "on"})`,
);

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return process.exit(1);
  stopping = true;
  log(`${signal}: stopping (send it again to exit at once)`);
  try {
    server.close();
    await signerWorker?.stop();
    await orchestrator.stop();
    await db.destroy();
  } catch (err) {
    log(`shutdown error: ${errorText(err, redactor)}`);
  }
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
