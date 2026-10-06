import { randomUUID } from "node:crypto";
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

// --- Credits (P1-U6) ---------------------------------------------------------

export interface CreditsJson {
  readonly fundingAddress: string;
  /** USDC base units as decimal strings. Credits can be negative after an overshooting last call. */
  readonly creditsUsdcE6: string;
  readonly spendableUsdcE6: string;
  readonly heldUsdcE6: string;
  readonly unsettledUsdcE6: string;
  /** No spendable credits: LLM work is stopped and the agent is RESTRICTED (D-129). */
  readonly restricted: boolean;
}

/** An agent's funding address and balances, summed from the credit ledger (D-208). */
export async function readCredits(
  db: Db,
  chainId: number,
  agentId: number,
): Promise<CreditsJson | null> {
  const funding = await db
    .selectFrom("platform.funding_addresses")
    .select("address")
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .executeTakeFirst();
  if (!funding) return null;
  const rows = await db
    .selectFrom("platform.ledger_lines")
    .select(["account", sql<string>`sum(amount)`.as("total")])
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .groupBy("account")
    .execute();
  const owed = (account: string) => -BigInt(rows.find((r) => r.account === account)?.total ?? "0");
  const credits = owed("agent_credits");
  const spendable = credits > 0n ? credits : 0n;
  return {
    fundingAddress: getAddress(funding.address),
    creditsUsdcE6: credits.toString(),
    spendableUsdcE6: spendable.toString(),
    heldUsdcE6: owed("held_deposits").toString(),
    unsettledUsdcE6: owed("usage_unsettled").toString(),
    restricted: spendable === 0n,
  };
}

/** Records a refund request under the owner's wallet and epoch; "open" when one is in flight. */
export async function insertRefund(
  db: Db,
  chainId: number,
  agentId: number,
  wallet: string,
  epoch: bigint,
): Promise<string | "open"> {
  const refundId = randomUUID();
  try {
    await db
      .insertInto("platform.refunds")
      .values({
        refund_id: refundId,
        chain_id: chainId,
        agent_id: agentId,
        owner: dbAddress(wallet),
        owner_epoch: Number(epoch),
        requested_by: "owner",
        status: "requested",
      })
      .execute();
  } catch (err) {
    if (err instanceof Error && /refunds_one_open/.test(err.message)) return "open";
    throw err;
  }
  return refundId;
}

export async function readRefund(db: Db, chainId: number, agentId: number, refundId: string) {
  const r = await db
    .selectFrom("platform.refunds")
    .selectAll()
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .where("refund_id", "=", refundId)
    .executeTakeFirst();
  if (!r) return null;
  return {
    refundId: r.refund_id,
    agentId: String(r.agent_id),
    owner: getAddress(r.owner),
    ownerEpoch: String(r.owner_epoch),
    status: r.status,
    creditsUsdcE6: r.credits_usdc_e6,
    heldUsdcE6: r.held_usdc_e6,
    txHash: r.tx_hash,
    reason: r.reason,
  };
}
