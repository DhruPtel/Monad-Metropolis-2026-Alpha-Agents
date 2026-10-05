import { type AgentTable, type Db, dbAddress, sql } from "@alpha-agents/db";
import { AGENT_MAX_SUPPLY, SPECIES, speciesByIndex } from "@alpha-agents/domain";
import { getAddress } from "viem";

/**
 * Reads from the indexer's projections (P1-U4). Every answer carries the
 * watermark it was read at, so a page can say how fresh it is (FINAL_PLAN 4.10).
 */
export interface WatermarkView {
  readonly block: number;
  readonly hash: string;
  readonly updatedAt: string;
}

export interface AgentJson {
  readonly agentId: string;
  readonly owner: string;
  readonly tba: string;
  /** 0 until revealed, then 1 to 25. */
  readonly species: number;
  readonly tier: "base" | "medium" | "pro" | null;
  readonly ownerEpoch: string;
  readonly mintedBlock: number;
  readonly mintedTx: string;
}

export interface SupplyJson {
  readonly maxSupply: number;
  readonly totalMinted: number;
  /** Slots left in the deck per species, 1 to 25 in SPECIES order (AgentNFT's remainingOf). */
  readonly remaining: number[];
}

export async function readWatermark(db: Db, chainId: number): Promise<WatermarkView | null> {
  const row = await db
    .selectFrom("indexer.watermarks")
    .select(["block_number", "block_hash", "updated_at"])
    .where("chain_id", "=", chainId)
    .where("source", "=", "agent_nft")
    .executeTakeFirst();
  return row
    ? {
        block: row.block_number,
        hash: row.block_hash,
        updatedAt: new Date(row.updated_at).toISOString(),
      }
    : null;
}

type AgentRow = AgentTable;

export function agentJson(row: AgentRow): AgentJson {
  return {
    agentId: String(row.agent_id),
    owner: getAddress(row.owner),
    tba: getAddress(row.tba),
    species: row.species,
    tier: row.species === 0 ? null : speciesByIndex(row.species).tier,
    ownerEpoch: String(row.owner_epoch),
    mintedBlock: row.minted_block,
    mintedTx: row.minted_tx,
  };
}

export interface AgentFilter {
  readonly owner?: string;
  /** The wallet that minted it, from its AgentMinted event. */
  readonly minter?: string;
  readonly limit?: number;
}

export async function listAgents(
  db: Db,
  chainId: number,
  filter: AgentFilter,
): Promise<AgentJson[]> {
  let q = db.selectFrom("indexer.agents").selectAll().where("chain_id", "=", chainId);
  if (filter.owner) q = q.where("owner", "=", dbAddress(filter.owner));
  if (filter.minter) {
    const minter = dbAddress(filter.minter);
    q = q.where("agent_id", "in", (eb) =>
      eb
        .selectFrom("indexer.agent_nft_events")
        .select(sql<number>`(args->>'agentId')::bigint`.as("id"))
        .where("chain_id", "=", chainId)
        .where("event_name", "=", "AgentMinted")
        .where(sql<string>`lower(args->>'owner')`, "=", minter),
    );
  }
  const rows = await q
    .orderBy("agent_id")
    .limit(filter.limit ?? 1_000)
    .execute();
  return rows.map(agentJson);
}

export async function getAgent(
  db: Db,
  chainId: number,
  agentId: number,
): Promise<AgentJson | null> {
  const row = await db
    .selectFrom("indexer.agents")
    .selectAll()
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .executeTakeFirst();
  return row ? agentJson(row) : null;
}

/**
 * The supply as AgentNFT would answer it: the minted count, and each species'
 * full count less the agents revealed as it. The deck shrinks at reveal, as
 * on chain, so this equals remainingOf for every species.
 */
export async function readSupply(db: Db, chainId: number): Promise<SupplyJson> {
  const rows = await db
    .selectFrom("indexer.agents")
    .select(["species", (eb) => eb.fn.countAll<string>().as("n")])
    .where("chain_id", "=", chainId)
    .groupBy("species")
    .execute();
  const bySpecies = new Map(rows.map((r) => [r.species, Number(r.n)]));
  const totalMinted = rows.reduce((sum, r) => sum + Number(r.n), 0);
  return {
    maxSupply: AGENT_MAX_SUPPLY,
    totalMinted,
    remaining: SPECIES.map((s) => s.count - (bySpecies.get(s.index) ?? 0)),
  };
}

export async function isAllowlisted(db: Db, wallet: string): Promise<boolean> {
  const row = await db
    .selectFrom("platform.mint_allowlist")
    .select("wallet")
    .where("wallet", "=", dbAddress(wallet))
    .executeTakeFirst();
  return row !== undefined;
}
