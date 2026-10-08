import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConfigError, assertChainId, loadConfig, type Secret } from "@alpha-agents/config";
import { createDb, migrateToLatest } from "@alpha-agents/db";
import { addressEntry } from "@alpha-agents/domain";
import type { Hex } from "viem";
import { Indexer } from "./indexer.ts";
import { RpcLogSource } from "./rpc-source.ts";

/**
 * The indexer process (P1-U4): `pnpm dev:indexer` locally, `--once` to catch up
 * and exit. Reads the environment's RPC (on local, the fork on LOCAL_FORK_PORT)
 * and DATABASE_URL; neither is ever printed.
 */
const ENV_PATH = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const once = process.argv.includes("--once");
const log = (line: string) => console.log(`${new Date().toISOString()} indexer: ${line}`);

let config;
try {
  config = loadConfig({ name: "indexer", requires: ["DATABASE_URL"] });
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const env = config.environment;
const nft = addressEntry(env.id, "agent_nft");
if (nft.status !== "verified") {
  log(`AgentNFT is not deployed on ${env.label} (address book: unverified); nothing to index`);
  process.exit(0);
}
const usdc = addressEntry(env.id, "usdc");
const remote = env.id !== "local";

const source = new RpcLogSource({ url: (config.rpcUrl as Secret).reveal() });
try {
  assertChainId(config, await source.chainId());
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const db = createDb((config.values.DATABASE_URL as Secret).reveal(), { max: 4 });
await migrateToLatest(db);
const indexer = new Indexer({
  db,
  source,
  target: {
    chainId: env.chainId,
    agentNft: nft.address as Hex,
    usdc: usdc.status === "verified" ? (usdc.address as Hex) : null,
    // Our contracts are deployed after the block the address book checked them at.
    startBlock: nft.verification.block + 1,
  },
  // Public Monad RPCs cap eth_getLogs ranges; the indexer halves on refusal anyway.
  maxRange: remote ? 100 : 2_000,
  // P2-EC: at most one indexing step every 2 s on a real chain (about 5 blocks a step).
  minStepMs: remote ? 2_000 : 0,
  confirmations: remote ? 2 : 0,
  log,
});

const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => controller.abort());

try {
  const wm = await indexer.watermark();
  log(`${env.label} (chain ${env.chainId}): AgentNFT ${nft.address}, from block ${wm.number + 1}`);
  if (once) {
    await indexer.catchUp();
    log(`caught up at block ${(await indexer.watermark()).number}`);
  } else {
    await indexer.run(controller.signal, remote ? 2_000 : 1_000);
  }
} finally {
  await db.destroy();
}
