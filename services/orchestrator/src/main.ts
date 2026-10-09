import {
  MarketData,
  ResearchSources,
  viemMainnetLookup,
  viemMainnetReader,
  TokenDiscovery,
  readOnlyTransport,
} from "@alpha-agents/market";
import { PgUsageStore } from "./usage-store.ts";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  ConfigError,
  type ConfigValue,
  Secret,
  assertChainId,
  loadConfig,
} from "@alpha-agents/config";
import { ViemChainReader, contractsFor, rpcTransport } from "@alpha-agents/chain-tools";
import { TavilyProvider } from "@alpha-agents/data-tools";
import { createDb, migrateToLatest } from "@alpha-agents/db";
import { localPaths, secretFragments, setMonBalance, startTestFork } from "@alpha-agents/devenv";
import { MONAD_MAINNET_CHAIN_ID } from "@alpha-agents/config";
import { SPECIES, addressEntry } from "@alpha-agents/domain";
import { type Hex, type PublicClient, createPublicClient, http } from "viem";
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
import { Redactor, createLog, errorText } from "./secrets.ts";
import { Store } from "./store.ts";
import { findCloudflared } from "./tunnel.ts";
import { swapGasCost } from "./trade-flow.ts";
import { testnetFeedsFor, viemFeedChain, withFreshFeeds } from "./testnet-feeds.ts";
import { TokenRegistry } from "./tokens/registry.ts";
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
if (env.id !== "local" && secret.startsWith("local-fork-only"))
  die(`ORCHESTRATOR_SECRET is the local default; set a random one for ${env.label}`);

// P2-EC: off the fork the environment's second provider takes over when the first fails
// (D-254); on testnet config reads it from MONAD_TESTNET_RPC_URL_SECONDARY.
const fallbackRpcUrl =
  config.environment.id === "local" ? null : (reveal("MONAD_RPC_URL_SECONDARY") ?? null);
if (fallbackRpcUrl) protect(fallbackRpcUrl);
const client = createPublicClient({ transport: rpcTransport(rpcUrl, fallbackRpcUrl) });
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
else if (!keeperKey) log("REVEAL_KEEPER_PRIVATE_KEY is not set: the reveal keeper is off");
else if (entropy.status !== "verified")
  log(`no Pyth Entropy on ${env.label}: the reveal keeper is off`);
else {
  const chain = new ViemRevealChain({
    rpcUrl,
    fallbackRpcUrl,
    chainId: env.chainId,
    agentNft: nft.address as Hex,
    entropy: entropy.address as Hex,
    privateKey: keeperKey as Hex,
    localFork: env.id === "local",
    ...(steering ? { steering } : {}),
    log: createLog("keeper", redactor),
  });
  keeper = new RevealKeeper({
    chain,
    policy: env.id === "local" ? KEEPER_POLICY.local : KEEPER_POLICY.remote,
    log: createLog("keeper", redactor),
    redactor,
  });
  log(`reveal keeper on: wallet ${chain.address}, window ${env.id === "local" ? 10 : 60} s`);
}

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
      rpcUrl,
      ...(secondary ? { secondaryRpcUrl: secondary } : {}),
      seed: seed as Hex,
      ...(treasury ? { treasury: treasury as Hex } : {}),
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
// latest block of their own (never the playtest fork), forked from the same research URLs.
const tokenDiscovery =
  mainnetUrls.length > 0
    ? new TokenDiscovery({
        market,
        cmcApiKey: cmcKey,
        client: createPublicClient({ transport: readOnlyTransport(mainnetUrls) }) as PublicClient,
      })
    : null;
// --screen-fork-port lets a second orchestrator (the live run) keep its fork apart from dev's.
const screenForkPort = Number(arg("screen-fork-port") ?? SCREEN_FORK_PORT);
if (!Number.isInteger(screenForkPort) || screenForkPort <= 8545 || screenForkPort > 65_535)
  die("--screen-fork-port takes a port above 8545");
const screenFork =
  mainnetUrls.length > 0
    ? new ScreenFork({
        start: () =>
          startTestFork({
            port: screenForkPort,
            block: "latest",
            env: {
              MONAD_RPC_URL: mainnetUrls[0],
              ...(mainnetUrls[1] ? { MONAD_RPC_URL_SECONDARY: mainnetUrls[1] } : {}),
            },
          }),
      })
    : null;
const tokenRegistry = new TokenRegistry({
  chainId: MONAD_MAINNET_CHAIN_ID,
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
if (scanSeconds !== undefined && (env.id !== "local" || !/^[1-9]\d{0,5}$/.test(scanSeconds)))
  die("--scan-interval-seconds takes a whole number of seconds, and only with APP_ENV=local");
const scanIntervalMs =
  scanSeconds !== undefined
    ? Number(scanSeconds) * 1_000
    : Number(values.SCAN_INTERVAL_MINUTES ?? 360) * 60_000;
// P2-EC: on testnet Scans run only when the owner starts one; nothing is scheduled.
const scheduleScans = env.id !== "testnet";
if (credits)
  log(
    scheduleScans
      ? `scheduled Scans every ${scanIntervalMs / 1_000} seconds for agents with credits`
      : "scheduled Scans off on testnet: a Scan runs only when the owner starts one",
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
const chainSigner = signerWorker?.signer ?? null;

// P2-EC (D-307): on testnet the TestnetFeeds are re-dated on demand, before every market read
// of a proposal's or a submission's checks and before an owner's deposit; never on a timer.
const feedKey = env.id === "testnet" ? reveal("TESTNET_FEED_PRIVATE_KEY") : undefined;
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
if (env.id === "testnet")
  log(
    testnetFeeds
      ? "testnet feeds: re-dated on demand before checks, submissions and deposits (D-307)"
      : "testnet feeds: TESTNET_FEED_PRIVATE_KEY is not set, so nothing re-dates them; deposits and trades will be refused with ORACLE_STALE",
  );
const toolsReader =
  chainReader && testnetFeeds ? withFreshFeeds(chainReader, testnetFeeds) : chainReader;

// The trade flow (P2-U6) sends swaps through the signer; the local fork tops gas up and
// treats its receipts as final, every other chain settles a trade only once finalized.
const local = env.id === "local";
// P2-EC: off the fork every read is metered by the RPC provider, and the 2-second loops of the
// fork (the keeper, credits, the trade flow) together with the indexer exceeded a free plan's
// rate limit on testnet. Real chains poll these every 5 seconds.
const REMOTE_POLL_MS = 5_000;
const trading = chainSigner
  ? {
      signer: chainSigner,
      ...(local ? {} : { everyMs: REMOTE_POLL_MS }),
      gas: {
        balance: (address: Hex) => client.getBalance({ address }),
        swapCost: async () => {
          const [block, tip] = await Promise.all([
            client.getBlock(),
            client.estimateMaxPriorityFeePerGas().catch(() => 0n),
          ]);
          return swapGasCost(block.baseFeePerGas ?? 0n, tip);
        },
        ...(local
          ? { topUp: (address: Hex, wei: bigint) => setMonBalance(address, wei, rpcUrl) }
          : {}),
      },
      finalizedBlock: async () =>
        local ? null : (await client.getBlock({ blockTag: "finalized" })).number,
    }
  : null;
if (!trading) log("trade flow: off (no signer); proposals wait and nothing is sent");

const orchestrator = new Orchestrator({
  store,
  gateway,
  provider,
  keeper,
  localFeeds,
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
  tokens: {
    registry: tokenRegistry,
    ...(tokenLoops ? {} : { discoverEveryMs: 0, screenEveryMs: 0 }),
  },
  // P3-U3: the runner's buy brake reads MON's 24-hour volatility from the shared market data
  // (DefiLlama's recorded price, D-289); a refused or stale figure counts as unreadable.
  runner: {
    volatility24hPct: async () => {
      const f = (await market.volatility()).value.windows["24h"];
      return f.value === null || f.warnings.some((w) => w.code === "STALE") ? null : f.value;
    },
  },
  scanIntervalMs,
  ...(scheduleScans ? {} : { scheduleMs: 0 }),
  ...(local ? {} : { keeperMs: REMOTE_POLL_MS, creditsMs: REMOTE_POLL_MS }),
  revealSteering: steering,
  snapshotReader: chainReader,
  chain: {
    reader: toolsReader,
    ...(chainSigner ? { sessionKeyOf: (agentId: number) => chainSigner.createKey(agentId) } : {}),
  },
  trading,
});
await orchestrator.start();

const port = Number(values.ORCHESTRATOR_PORT);
const api = createApi({
  orchestrator,
  store,
  chainId: env.chainId,
  devActions: env.id === "local",
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
  `internal API on http://127.0.0.1:${port} (dev actions ${env.id === "local" ? "on" : "off"}, operator actions ${env.id === "beta" ? "off" : "on"})`,
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
