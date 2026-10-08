import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { ConfigError, assertChainId, loadConfig, type Secret } from "@alpha-agents/config";
import { createDb, migrateToLatest } from "@alpha-agents/db";
import { AGENT_NFT_ABI, addressEntry, agentNftDeployment } from "@alpha-agents/domain";
import { createPublicClient, http, isAddressEqual, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "./app.ts";
import { rpcAgentViewReader, rpcPortfolioReader } from "@alpha-agents/trading";
import { rpcChainReader } from "./chain.ts";
import { MOCK_IDENTITY_FLAG, mockIdentity, privyIdentity } from "./identity.ts";

/**
 * The control API process (P1-U4): `pnpm dev:api`. Reads DATABASE_URL, the
 * environment's RPC (on local, the fork on LOCAL_FORK_PORT), the Privy keys,
 * API_SESSION_SECRET and CLAIM_SIGNER_PRIVATE_KEY; prints none of them.
 */
const ENV_PATH = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);
const log = (line: string) => console.log(`${new Date().toISOString()} control-api: ${line}`);
const die = (message: string): never => {
  console.error(`error: ${message}`);
  process.exit(1);
};

function loadOrDie() {
  try {
    return loadConfig({
      name: "control API",
      requires: ["DATABASE_URL", "API_SESSION_SECRET", "CONTROL_API_PORT"],
    });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return die(err.message);
  }
}
const config = loadOrDie();
const env = config.environment;
const values = config.values;
const sessionSecret = (values.API_SESSION_SECRET as Secret).reveal();
if (env.id !== "local" && sessionSecret.startsWith("local-fork-only")) {
  die(`API_SESSION_SECRET is the local default; set a random one for ${env.label}`);
}

// Identity: Privy, or the web test build's mock wallet on a local test stack only.
const mock = process.env[MOCK_IDENTITY_FLAG]?.trim() === "1";
if (mock && env.id !== "local") die(`${MOCK_IDENTITY_FLAG}=1 is for local test stacks only`);
const identity = mock
  ? mockIdentity()
  : values.PRIVY_APP_ID && values.PRIVY_APP_SECRET
    ? privyIdentity(String(values.PRIVY_APP_ID), (values.PRIVY_APP_SECRET as Secret).reveal())
    : null;

// The claim signer: a configured key on local and testnet; KMS before the beta (D-198).
if (!values.CLAIM_SIGNER_PRIVATE_KEY && process.env.LOCAL_CLAIM_SIGNER_PRIVATE_KEY) {
  die("LOCAL_CLAIM_SIGNER_PRIVATE_KEY was renamed CLAIM_SIGNER_PRIVATE_KEY; rename it in .env");
}
const signer = values.CLAIM_SIGNER_PRIVATE_KEY
  ? privateKeyToAccount((values.CLAIM_SIGNER_PRIVATE_KEY as Secret).reveal() as Hex)
  : null;

const deployment = agentNftDeployment(env.id);
const rpcUrl = config.rpcUrl?.reveal();
const chain = deployment && rpcUrl ? rpcChainReader(rpcUrl, deployment.address) : null;
// P2-U7: the owner's portfolio, where every custody contract is in this environment's book.
function portfolioReader(agentNft: Hex, executor: Hex) {
  const ids = ["account_factory", "oracle_adapter", "usdc", "wmon"] as const;
  const entries = ids.map((id) => addressEntry(env.id, id));
  if (!rpcUrl || entries.some((e) => e.status !== "verified")) return null;
  const [accountFactory, oracle, usdc, wmon] = entries.map((e) => e.address as Hex) as [
    Hex,
    Hex,
    Hex,
    Hex,
  ];
  return rpcPortfolioReader(rpcUrl, env.chainId, {
    agentNft,
    accountFactory,
    oracle,
    usdc,
    wmon,
    executor,
  });
}

// P2-U6: the Executor the owner's wallet registers and revokes grants with, where it is deployed.
const executorEntry = addressEntry(env.id, "executor");
const trading =
  deployment && rpcUrl && executorEntry.status === "verified"
    ? {
        executor: executorEntry.address as Hex,
        reader: rpcAgentViewReader(rpcUrl, {
          agentNft: deployment.address,
          executor: executorEntry.address as Hex,
        }),
        portfolio: portfolioReader(deployment.address, executorEntry.address as Hex),
      }
    : null;
if (rpcUrl) {
  const client = createPublicClient({ transport: http(rpcUrl) });
  try {
    assertChainId(config, await client.getChainId());
  } catch (err) {
    die(err instanceof ConfigError ? err.message : "could not reach the chain RPC");
  }
  if (deployment && signer) {
    const onChain = await client
      .readContract({
        address: deployment.address,
        abi: AGENT_NFT_ABI,
        functionName: "claimSigner",
      })
      .catch(() => null);
    if (onChain && !isAddressEqual(onChain, signer.address)) {
      log(
        `warning: CLAIM_SIGNER_PRIVATE_KEY is not AgentNFT's claimSigner; its claims will be refused on chain`,
      );
    } else if (!onChain) {
      log(
        `warning: could not read AgentNFT's claimSigner (is AgentNFT deployed? pnpm deploy:agent-nft)`,
      );
    }
  }
}

const publicUrl = values.APP_PUBLIC_URL ? new URL(String(values.APP_PUBLIC_URL)).origin : null;
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const db = createDb((values.DATABASE_URL as Secret).reveal());
await migrateToLatest(db);

const app = createApp({
  db,
  environment: env,
  deployment,
  chain,
  trading,
  identity,
  signer,
  sessionSecret,
  allowOrigin: (origin) => (env.id === "local" ? LOOPBACK.test(origin) : origin === publicUrl),
  now: () => Date.now(),
  randomNonce: () => `0x${randomBytes(32).toString("hex")}`,
});

const port = Number(values.CONTROL_API_PORT);
const server = serve({
  fetch: app.fetch,
  port,
  hostname: env.id === "local" ? "127.0.0.1" : "0.0.0.0",
});
log(
  `${env.label} (chain ${env.chainId}) on port ${port}; AgentNFT ${deployment?.address ?? "not deployed"}; ` +
    `login ${mock ? "MOCK (test stack)" : identity ? "Privy" : "not configured"}; ` +
    `claim signer ${signer ? signer.address : "not configured"}`,
);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    void db.destroy().then(() => process.exit(0));
  });
}
