import type { ColumnType, Generated } from "kysely";

/**
 * The database as Kysely sees it (D-199). Two schemas:
 * - `indexer`: chain projections, written only by the indexer. Every record
 *   carries the block number and hash it came from, so a reorg can be rolled
 *   back exactly (P1-U4, D-197).
 * - `platform`: state the platform owns, such as the mint allowlist and the
 *   claims it issued, and the orchestrator's runtimes, leases and tasks (P1-U5).
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
  /** The agent's side of the transfer: its token-bound account or its funding address (P1-U6). */
  account: ColumnType<"tba" | "funding", "tba" | "funding" | undefined, "tba" | "funding">;
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

export type RuntimeStatus =
  "provisioning" | "ready" | "deprovisioning" | "deprovisioned" | "failed";

/** One provisioned agent (P1-U5, D-202). */
export interface AgentRuntimeTable {
  chain_id: number;
  agent_id: number;
  /** Bumped by a reset, so a reprovisioned agent gets a new key alias. */
  generation: number;
  status: RuntimeStatus;
  tier: number;
  species: number;
  /** The rendered, validated Hermes configuration document (no secrets). */
  config: ColumnType<Record<string, unknown>, string, string>;
  config_hash: string;
  key_alias: string;
  /** The LiteLLM virtual key, AES-256-GCM encrypted; null once deleted (D-203). */
  key_ciphertext: string | null;
  /** USD, numeric as a string. */
  budget_usd: ColumnType<string, string, string>;
  last_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  provisioned_at: Timestamp | null;
  deprovisioned_at: Timestamp | null;
}

/** A sandbox lease: at most one active per agent (partial unique index). */
export interface SandboxLeaseTable {
  lease_id: string;
  chain_id: number;
  agent_id: number;
  run_tag: string;
  namespace: string;
  purpose: string;
  sandbox_id: string | null;
  /** sha256 hex of the gate token; the token is never stored. */
  gate_token_hash: string;
  status: "active" | "ended";
  started_at: Timestamp;
  expires_at: Timestamp;
  ended_at: Timestamp | null;
  end_reason: string | null;
}

export interface AgentTaskTable {
  task_id: string;
  chain_id: number;
  agent_id: number;
  kind: "noop";
  status: "queued" | "running" | "succeeded" | "failed";
  lease_id: string | null;
  result: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  error: string | null;
  created_at: Timestamp;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
}

/** Each agent's funding address (D-207). */
export interface FundingAddressTable {
  chain_id: number;
  agent_id: number;
  address: string;
  derivation_path: string;
  created_at: Timestamp;
}

/** The double-entry credit ledger (D-208). */
export interface LedgerEntryTable {
  entry_id: string;
  chain_id: number;
  agent_id: number;
  kind: string;
  idempotency_key: string;
  occurred_at: Timestamp;
  source: ColumnType<Record<string, unknown>, string, string>;
  created_at: Timestamp;
}

export interface LedgerLineTable {
  entry_id: string;
  line_no: number;
  chain_id: number;
  agent_id: number | null;
  account: string;
  asset: string;
  /** Signed raw amount, numeric as a string. */
  amount: ColumnType<string, string, string>;
}

/** One metered LiteLLM request (FINAL_PLAN 4.3.5). */
export interface UsageReceiptTable {
  key_alias: string;
  request_id: string;
  chain_id: number;
  agent_id: number;
  model: string;
  provider_picos: ColumnType<string, string, string>;
  charge_usdc_e6: ColumnType<string, string, string>;
  called_at: Timestamp | null;
  entry_id: string;
  metered_at: Timestamp;
}

export type RefundStatus = "requested" | "signed" | "sent" | "refused" | "failed";

/** A refund request (D-210); the signed transaction is stored before it is broadcast. */
export interface RefundTable {
  refund_id: string;
  chain_id: number;
  agent_id: number;
  owner: string;
  owner_epoch: number;
  requested_by: "owner" | "console";
  status: RefundStatus;
  credits_usdc_e6: ColumnType<string | null, string | null, string | null>;
  held_usdc_e6: ColumnType<string | null, string | null, string | null>;
  raw_tx: string | null;
  tx_hash: string | null;
  reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
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
  "platform.agent_runtimes": AgentRuntimeTable;
  "platform.sandbox_leases": SandboxLeaseTable;
  "platform.agent_tasks": AgentTaskTable;
  "platform.funding_addresses": FundingAddressTable;
  "platform.ledger_entries": LedgerEntryTable;
  "platform.ledger_lines": LedgerLineTable;
  "platform.usage_receipts": UsageReceiptTable;
  "platform.refunds": RefundTable;
}
