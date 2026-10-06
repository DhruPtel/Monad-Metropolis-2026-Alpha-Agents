import { createConnection } from "node:net";
import type { Db } from "@alpha-agents/db";
import { loadConfig } from "@alpha-agents/config";
import { speciesByIndex, TIER_IDS, type Tier } from "@alpha-agents/domain";

/** Test helpers: indexed agents written the way the indexer writes them, and a Redis probe. */
export const CHAIN = 143143;

/** The first species index of a tier, so a test can reveal an agent as that tier. */
export function speciesOfTier(tier: Tier): number {
  for (let i = 1; i <= 25; i += 1) if (speciesByIndex(i).tier === tier) return i;
  throw new Error(`no species for ${tier}`);
}

export async function indexAgent(
  db: Db,
  agentId: number,
  tier: Tier | null,
  owner = "0x00000000000000000000000000000000000a11ce",
): Promise<void> {
  const species = tier ? speciesOfTier(tier) : 0;
  const values = {
    chain_id: CHAIN,
    agent_id: agentId,
    owner,
    tba: `0x${agentId.toString(16).padStart(40, "0")}`,
    species,
    tier: tier ? TIER_IDS.indexOf(tier) + 1 : 0,
    owner_epoch: 0,
    minted_block: 1,
    minted_tx: "0x01",
    block_number: 1,
    block_hash: "0x01",
  };
  await db
    .insertInto("indexer.agents")
    .values(values)
    .onConflict((oc) =>
      oc
        .columns(["chain_id", "agent_id"])
        .doUpdateSet({ species: values.species, tier: values.tier }),
    )
    .execute();
}

export async function unindexAgent(db: Db, agentId: number): Promise<void> {
  await db
    .deleteFrom("indexer.agents")
    .where("chain_id", "=", CHAIN)
    .where("agent_id", "=", agentId)
    .execute();
}

/** The configured Redis URL (REDIS_URL, or the local container's default). */
export function redisUrl(): string {
  const config = loadConfig({ name: "orchestrator tests", usesChain: false });
  const value = config.values.REDIS_URL;
  return typeof value === "object" && value !== null && "reveal" in value
    ? value.reveal()
    : String(value);
}

/** True when Redis answers PING at the configured URL. */
export async function redisAvailable(): Promise<boolean> {
  const url = new URL(redisUrl());
  return new Promise((resolve) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port || 6379) });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2_000, () => done(false));
    socket.on("error", () => done(false));
    socket.on("connect", () => socket.write("PING\r\n"));
    socket.on("data", (d) => done(d.toString().startsWith("+PONG")));
  });
}

/** The value, or a test failure naming what was missing. */
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) throw new Error(`expected a ${what}`);
  return value;
}
