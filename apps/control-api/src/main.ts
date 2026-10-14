import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  ConfigError,
  assertChainId,
  loadConfig,
  type Secret,
  isForkEnvironment,
} from "@alpha-agents/config";
import { type Db, createDb, migrateToLatest } from "@alpha-agents/db";
import { startUpstreamProxy } from "@alpha-agents/devenv";
import { AGENT_NFT_ABI, addressEntry, agentNftDeployment } from "@alpha-agents/domain";
import { createPublicClient, http, isAddressEqual, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "./app.ts";
import { orchestratorActivation } from "./activation.ts";
import { orchestratorResearchRun } from "./research-run.ts";
import { rpcMoneyEvents } from "./money-events.ts";
import { orchestratorWindow } from "./window.ts";
import { orchestratorResearch } from "./research.ts";
import {
  TradeStore,
  rpcAgentViewReader,
  rpcCustodyPathReader,
  rpcHoldingsReader,
  rpcPortfolioReader,
  rpcPortfolioReaderV3,
  rpcVaultReaderV3,
} from "@alpha-agents/trading";
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
      requires: ["DATABASE_URL", "API_SESSION_SECRET", "CONTROL_API_PORT", "ORCHESTRATOR_SECRET"],
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
// M-FAST: a fork environment (the local or the Base fork) may keep the local default.
if (!isForkEnvironment(env.id) && sessionSecret.startsWith("local-fork-only")) {
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
const chainRpcUrl = config.rpcUrl?.reveal();
// UX-U1: off the fork every read goes through the retrying relay over the environment's
// providers (the second one when set, D-254): the testnet provider answers 429 under the
// stack's load, and one refused call failed a whole owner route with "the control API hit an
// error". The relay retries rate limits, server errors and dropped connections with backoff,
// alternating providers, and logs by method and reason only (never a URL).
const secondaryRpcUrl = (values.MONAD_RPC_URL_SECONDARY as Secret | undefined)?.reveal() ?? null;
// One line a minute with the retries' count and reasons, not one per retry (the testnet
// provider refuses most first attempts, so the stack log would carry little else).
const relayReasons = new Map<string, number>();
let relayLogged = Date.now();
const relayLog = (line: string) => {
  const reason = line
    .replace(/attempt \d+/, "")
    .replace(/after \d+ ms/, "")
    .trim();
  relayReasons.set(reason, (relayReasons.get(reason) ?? 0) + 1);
  if (Date.now() - relayLogged < 60_000) return;
  relayLogged = Date.now();
  const total = [...relayReasons.values()].reduce((a, b) => a + b, 0);
  const top = [...relayReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  relayReasons.clear();
  log(
    `rpc relay: ${total} retries in the last minute (${top.map(([r, n]) => `${n}: ${r}`).join("; ")})`,
  );
};
const relay =
  chainRpcUrl && !isForkEnvironment(env.id)
    ? await startUpstreamProxy({
        upstreams: secondaryRpcUrl ? [chainRpcUrl, secondaryRpcUrl] : [chainRpcUrl],
        attempts: 6,
        baseDelayMs: 300,
        log: relayLog,
      })
    : null;
if (relay)
  log(`rpc relay on: ${secondaryRpcUrl ? "two providers" : "one provider"}, retries with backoff`);
const rpcUrl = relay?.url ?? chainRpcUrl;
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

// D-315: every balance at an agent's addresses, for every token this environment's book knows.
const holdingTokens = (["usdc", "wmon", "weth"] as const).flatMap((id) => {
  const e = addressEntry(env.id, id);
  return e.status === "verified" && e.verification.decimals !== undefined
    ? [{ symbol: e.label, address: e.address as Hex, decimals: e.verification.decimals }]
    : [];
});
const factoryEntry = addressEntry(env.id, "account_factory");
// P2-U6: the Executor the owner's wallet registers and revokes grants with, where it is deployed.
const executorEntry = addressEntry(env.id, "executor");
// F-U5 (D-367): the fund agent's set, where deployed; an agent on it arms against Executor v3.
const executorV3Entry = addressEntry(env.id, "executor_v3");
const factoryV3Entry = addressEntry(env.id, "account_factory_v3");
const oracleV3Entry = addressEntry(env.id, "oracle_adapter_v3");
const holdings =
  deployment && rpcUrl
    ? rpcHoldingsReader(rpcUrl, env.chainId, {
        agentNft: deployment.address,
        accountFactory: factoryEntry.status === "verified" ? (factoryEntry.address as Hex) : null,
        // A-80: where the fund set is deployed the v3 account is the trading account.
        accountFactoryV3:
          factoryV3Entry.status === "verified" ? (factoryV3Entry.address as Hex) : null,
        tokens: holdingTokens,
      })
    : null;
const db = createDb((values.DATABASE_URL as Secret).reveal());

/** The registered tokens the owner may deposit into a v3 account: core lane, class F, listed (PersonalAccountV3.deposit). */
async function depositableTokens(db: Db) {
  const rows = await db
    .selectFrom("platform.tokens")
    .select(["address", "symbol", "decimals", "price_class"])
    .where("chain_id", "=", env.chainId)
    .where("registry_lane", "=", "core")
    .where("price_class", "=", "F")
    .where("registry_status", "=", "listed")
    .orderBy("liquidity_usd", "desc")
    .limit(50)
    .execute();
  return rows.map((t) => ({
    symbol: t.symbol,
    address: t.address as Hex,
    decimals: t.decimals,
    priceClass: t.price_class,
  }));
}

const v3 =
  deployment &&
  rpcUrl &&
  // M-FAST: the v2 factory is optional; the Base fork has only the v3 set.
  executorV3Entry.status === "verified" &&
  factoryV3Entry.status === "verified"
    ? {
        executor: executorV3Entry.address as Hex,
        reader: rpcAgentViewReader(
          rpcUrl,
          {
            agentNft: deployment.address,
            executor: executorV3Entry.address as Hex,
            // P7-U2: an agent with a vault arms it with the grant without expiry (D-241).
            accountFactoryV3: factoryV3Entry.address as Hex,
          },
          // Step 0 (2026-10-12, A-90): unless its owner chose the personal account.
          { managedAccount: (agentId) => new TradeStore(db).managedAccount(env.chainId, agentId) },
        ),
        paths: rpcCustodyPathReader(rpcUrl, {
          agentNft: deployment.address,
          accountFactory: factoryEntry.status === "verified" ? (factoryEntry.address as Hex) : null,
          accountFactoryV3: factoryV3Entry.address as Hex,
        }),
        // P7-U4: the agent's vault, public, read with the same set.
        vault:
          oracleV3Entry.status === "verified"
            ? rpcVaultReaderV3(
                rpcUrl,
                env.chainId,
                {
                  agentNft: deployment.address,
                  accountFactory: factoryV3Entry.address as Hex,
                  oracle: oracleV3Entry.address as Hex,
                  usdc: addressEntry(env.id, "usdc").address as Hex,
                  wmon: addressEntry(env.id, "wmon").address as Hex,
                  executor: executorV3Entry.address as Hex,
                },
                { tokens: () => depositableTokens(db) },
              )
            : null,
        // A-80: the owner's portfolio on the fund set, with the v2 account as an older one.
        portfolio:
          oracleV3Entry.status === "verified"
            ? rpcPortfolioReaderV3(
                rpcUrl,
                env.chainId,
                {
                  agentNft: deployment.address,
                  accountFactory: factoryV3Entry.address as Hex,
                  accountFactoryV2:
                    factoryEntry.status === "verified" ? (factoryEntry.address as Hex) : null,
                  oracle: oracleV3Entry.address as Hex,
                  usdc: addressEntry(env.id, "usdc").address as Hex,
                  wmon: addressEntry(env.id, "wmon").address as Hex,
                  executor: executorV3Entry.address as Hex,
                },
                { tokens: () => depositableTokens(db) },
              )
            : null,
      }
    : null;
// M-FAST (A-98): where only the v3 set is deployed (the Base fork) Executor v3 stands in for the
// v2 views, which no agent there takes: every agent on that fork is on the v3 set (A-80).
const viewExecutor =
  executorEntry.status === "verified" ? (executorEntry.address as Hex) : (v3?.executor ?? null);
const trading =
  deployment && rpcUrl && viewExecutor
    ? {
        executor: viewExecutor,
        reader: rpcAgentViewReader(rpcUrl, {
          agentNft: deployment.address,
          executor: viewExecutor,
        }),
        portfolio: portfolioReader(deployment.address, viewExecutor),
        v3,
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
  // BK-U1: the owners' own data keys are sealed under the orchestrator's secret, which opens them.
  keySecret: (values.ORCHESTRATOR_SECRET as Secret).reveal(),
  allowOrigin: (origin) => (env.id === "local" ? LOOPBACK.test(origin) : origin === publicUrl),
  // HOST-U1 (D-383): the testnet demo lets any wallet mint within the per-wallet limit.
  mintOpen: values.MINT_OPEN === "on",
  now: () => Date.now(),
  randomNonce: () => `0x${randomBytes(32).toString("hex")}`,
  holdings,
  // F-U9: a proposal's approval re-runs the Test stage v2 through the orchestrator's plan check.
  ...(values.ORCHESTRATOR_URL
    ? {
        proposals: {
          recheck: async (agentId, params) => {
            const res = await fetch(
              `${String(values.ORCHESTRATOR_URL)}/v1/agents/${agentId}/plan/check`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  template: "target_portfolio@1",
                  positions: params.positions.map((p) => ({
                    token: p.token,
                    targetWeightBps: p.targetWeightBps,
                    bandBps: p.bandBps,
                    thesisId: p.thesisId,
                    exit: p.exit,
                  })),
                  cashTargetBps: params.cashTargetBps,
                  minTradeUsdcE6: params.minTradeUsdcE6.toString(),
                  volatilityBrakeBps: params.volatilityBrakeBps,
                  costHurdleBps: params.costHurdleBps,
                  maxLegBps: params.maxLegBps,
                }),
                signal: AbortSignal.timeout(60_000),
              },
            );
            if (!res.ok) return null;
            const body = (await res.json()) as {
              findings?: { code: string; field: string; message: string }[];
            };
            return body.findings ?? null;
          },
        },
      }
    : {}),
  // F-U10: the activation sweep is read and started through the orchestrator, which owns it.
  ...(values.ORCHESTRATOR_URL
    ? { activation: orchestratorActivation(String(values.ORCHESTRATOR_URL)) }
    : {}),
  // 2026-10-13: deposits and withdrawals from the trading account's and the vault's logs.
  ...(deployment && rpcUrl && factoryV3Entry.status === "verified"
    ? {
        moneyEvents: rpcMoneyEvents(rpcUrl, {
          agentNft: deployment.address,
          accountFactoryV3: factoryV3Entry.address as Hex,
          usdc: addressEntry(env.id, "usdc").address as Hex,
        }),
      }
    : {}),
  // 2026-10-13: the owner's Research now, a full research cycle through the orchestrator.
  ...(values.ORCHESTRATOR_URL
    ? { researchRun: orchestratorResearchRun(String(values.ORCHESTRATOR_URL)) }
    : {}),
  // F-U11: the window's live account reading comes from the orchestrator too.
  ...(values.ORCHESTRATOR_URL
    ? { window: orchestratorWindow(String(values.ORCHESTRATOR_URL)) }
    : {}),
  // P3-U10: the research loop and the agent terminal, owner-only, through the orchestrator.
  ...(values.ORCHESTRATOR_URL
    ? { research: orchestratorResearch(String(values.ORCHESTRATOR_URL)) }
    : {}),
  // P2-EC (D-307): testnet's feeds are re-dated by the orchestrator, which holds the feed key.
  ...(env.id === "testnet" && values.ORCHESTRATOR_URL
    ? {
        freshPrices: async () => {
          const res = await fetch(
            `${String(values.ORCHESTRATOR_URL)}/v1/feeds/fresh?reason=a%20deposit`,
            { method: "POST", signal: AbortSignal.timeout(90_000) },
          );
          if (!res.ok) throw new Error(`the orchestrator answered ${res.status}`);
          return (await res.json()) as { redated: unknown[]; error: string | null };
        },
      }
    : {}),
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
