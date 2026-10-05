import type { ColumnType, Generated } from "kysely";

/**
 * The database as Kysely sees it (D-199). Two schemas:
 * - `indexer`: chain projections, written only by the indexer. Every record
 *   carries the block number and hash it came from, so a reorg can be rolled
 *   back exactly (P1-U4, D-197).
 * - `platform`: state the platform owns, such as the mint allowlist and the
 *   claims it issued.
 *
 * Addresses and hashes are stored lowercase; the API checksums addresses on the
 * way out. Block numbers, agent IDs and epochs are int8, read back as JS
 * numbers (all far below 2^53); token amounts are numeric, read back as strings.
 */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface WatermarkTable {
  chain_id: number;
  /** What the watermark tracks, for example "agent_nft". */
  source: string;
  /** The last block fully processed, and its hash at the time. */
  block_number: number;
  block_hash: string;
  updated_at: Timestamp;
}

/** Hashes of processed blocks: every block with a record, and every range end. */
export interface IndexedBlockTable {
  chain_id: number;
  block_number: number;
  block_hash: string;
}

/** Every AgentNFT event, raw: the projections are rebuilt from these. */
export interface AgentNftEventTable {
  chain_id: number;
  contract: string;
  block_number: number;
  block_hash: string;
  tx_hash: string;
  log_index: number;
  event_name: string;
  /** Decoded arguments, bigints as decimal strings. */
  args: ColumnType<Record<string, unknown>, string, string>;
}

/** One row per agent, projected from AgentNFT's events. */
export interface AgentTable {
  chain_id: number;
  agent_id: number;
  owner: string;
  tba: string;
  /** 0 until revealed, then 1 to 25. */
  species: number;
  /** 0 until revealed, then 1 base, 2 medium, 3 pro. */
  tier: number;
  owner_epoch: number;
  minted_block: number;
  minted_tx: string;
  /** The block of the last event that changed this row, and its hash. */
  block_number: number;
  block_hash: string;
}

export interface UsdcTransferTable {
  chain_id: number;
  block_number: number;
  block_hash: string;
  tx_hash: string;
  log_index: number;
  from_address: string;
  to_address: string;
  /** Raw USDC units (6 decimals), as a decimal string. */
  value: ColumnType<string, string, string>;
  /** The agent whose token-bound account sent or received it. */
  agent_id: number;
  direction: "in" | "out";
}

/** Reorgs, rewinds and gaps the indexer found, kept for the console and the logs. */
export interface IncidentTable {
  id: Generated<number>;
  chain_id: number;
  kind: "reorg" | "rewind" | "gap";
  block_number: number;
  stored_hash: string | null;
  chain_hash: string | null;
  /** The block the indexer rolled back to. */
  rolled_back_to: number;
  detail: string;
  detected_at: Timestamp;
}

export interface MintAllowlistTable {
  wallet: string;
  note: string | null;
  added_at: Timestamp;
}

export interface MintClaimTable {
  nonce: string;
  wallet: string;
  chain_id: number;
  contract: string;
  deadline: number;
  /** The Privy user the claim was issued to. */
  user_id: string;
  issued_at: Timestamp;
}

export interface Database {
  "indexer.watermarks": WatermarkTable;
  "indexer.indexed_blocks": IndexedBlockTable;
  "indexer.agent_nft_events": AgentNftEventTable;
  "indexer.agents": AgentTable;
  "indexer.usdc_transfers": UsdcTransferTable;
  "indexer.incidents": IncidentTable;
  "platform.mint_allowlist": MintAllowlistTable;
  "platform.mint_claims": MintClaimTable;
}
