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
import { TavilyProvider } from "@alpha-agents/data-tools";
import { createDb, migrateToLatest } from "@alpha-agents/db";
import { localPaths, secretFragments } from "@alpha-agents/devenv";
import { SPECIES, addressEntry } from "@alpha-agents/domain";
import { type Hex, createPublicClient, http } from "viem";
import { createApi } from "./api.ts";
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
 * SCAN_INTERVAL_MINUTES (P1-U7). Every secret value is registered with the log's
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

const client = createPublicClient({ transport: http(rpcUrl) });
try {
  assertChainId(config, await client.getChainId());
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

// Credits (P1-U6): funding addresses from the seed, refunds through the chain.
const seed = env.id === "beta" ? undefined : reveal("FUNDING_ADDRESS_SEED");
const usdc = addressEntry(env.id, "usdc");
let credits = null;
if (!seed) log("FUNDING_ADDRESS_SEED is not set: credits, deposits and refunds are off");
else {
  const keys = new FundingKeys(seed as Hex);
  const refundChain =
    usdc.status === "verified"
      ? new ViemRefundChain({
          rpcUrl,
          chainId: env.chainId,
          agentNft: nft.address as Hex,
          usdc: usdc.address as Hex,
          localFork: env.id === "local",
        })
      : null;
  if (!refundChain) log(`no USDC in the address book for ${env.label}: refunds stay requested`);
  credits = { keys, refundChain, environment: env.label };
  log("credits on: funding addresses, deposits, metering, budgets and refunds");
}

// Tools (P1-U7): web_search and read_url through Tavily; Scans on the configured cadence.
const tavilyKey = reveal("TAVILY_API_KEY");
const web = tavilyKey ? new TavilyProvider(tavilyKey) : null;
if (!web)
  log("TAVILY_API_KEY is not set: web_search and read_url answer that they are not configured");
const scanSeconds = arg("scan-interval-seconds");
if (scanSeconds !== undefined && (env.id !== "local" || !/^[1-9]\d{0,5}$/.test(scanSeconds)))
  die("--scan-interval-seconds takes a whole number of seconds, and only with APP_ENV=local");
const scanIntervalMs =
  scanSeconds !== undefined
    ? Number(scanSeconds) * 1_000
    : Number(values.SCAN_INTERVAL_MINUTES ?? 360) * 60_000;
if (credits) log(`scheduled Scans every ${scanIntervalMs / 1_000} seconds for agents with credits`);

// D-237: on the local fork only, keep the Chainlink feeds fresh so oracle checks pass.
const localFeeds = localFeedRefresherFor(env.id, rpcUrl);
if (localFeeds)
  log(
    `local fork: Chainlink feeds re-dated every ${localFeeds.everyMs / 1_000} s (LocalFeed, D-237)`,
  );

const store = new Store(db);
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
  scanIntervalMs,
  revealSteering: steering,
});
await orchestrator.start();

const port = Number(values.ORCHESTRATOR_PORT);
const api = createApi({
  orchestrator,
  store,
  chainId: env.chainId,
  devActions: env.id === "local",
});
const server = serve({ fetch: api.fetch, port, hostname: "127.0.0.1" });
log(`internal API on http://127.0.0.1:${port} (dev actions ${env.id === "local" ? "on" : "off"})`);

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return process.exit(1);
  stopping = true;
  log(`${signal}: stopping (send it again to exit at once)`);
  try {
    server.close();
    await orchestrator.stop();
    await db.destroy();
  } catch (err) {
    log(`shutdown error: ${errorText(err, redactor)}`);
  }
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
