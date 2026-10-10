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
  /** P3-U4: the stage run a cycle's lease is running now; null outside a cycle. */
  stage_run_id: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface AgentTaskTable {
  task_id: string;
  chain_id: number;
  agent_id: number;
  kind: "noop" | "scan" | "chain_check" | "research_check" | "cycle" | "token_check";
  status: "queued" | "running" | "succeeded" | "failed";
  /** P1-U9 (D-219): who asked for it; null for tasks from before 0005. */
  requested_by: ColumnType<
    "owner" | "console" | "schedule" | null,
    "owner" | "console" | "schedule" | null | undefined,
    "owner" | "console" | "schedule" | null
  >;
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
  /** Null when the call was wholly above its stage's ceiling: nothing was charged (P3-U4). */
  entry_id: string | null;
  metered_at: Timestamp;
  /** P3-U4: the stage the call ran under, and what the platform absorbed above its ceiling. */
  stage_run_id: ColumnType<string | null, string | null | undefined, string | null>;
  absorbed_usdc_e6: ColumnType<string, string | undefined, string>;
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
  /** The contributions this refund consumed (D-242); null before P2-U4. */
  contribution_basis_usdc_e6: ColumnType<string | null, string | null | undefined, string | null>;
  raw_tx: string | null;
  tx_hash: string | null;
  /** The signer outbox row that carries the transfer (P2-U5 step 0); null for refunds signed before it. */
  signer_tx_id: ColumnType<string | null, string | null | undefined, string | null>;
  reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** The intent statuses (P2-U5, P2-U6): packages/domain's INTENT_STATES (a test holds them equal). */
export type IntentStatus =
  | "awaiting_approval"
  | "approved"
  | "submitted"
  | "confirmed"
  | "reconciled"
  | "rejected"
  | "expired"
  | "failed"
  | "cancelled";

/** One swap an agent proposed through the chain tools (P2-U5). Never calldata. */
export interface IntentTable {
  intent_id: string;
  chain_id: number;
  agent_id: number;
  lease_id: string;
  kind: "swap";
  account: string | null;
  /** The assets by name: USDC or WMON on v2; the tokens' symbols on v3, with their addresses below (F-U5). */
  sell: string;
  buy: string;
  /** F-U5 (D-367): the custody set the intent trades on. */
  custody: ColumnType<"v2" | "v3", "v2" | "v3" | undefined, "v2" | "v3">;
  sell_token: string | null;
  buy_token: string | null;
  /** The route the proposal chose, registered pool IDs in order (v3). */
  route: ColumnType<string[] | null, string | null | undefined, string | null>;
  amount_in: string;
  reason: string;
  client_request_id: string | null;
  idempotency_key: string;
  status: IntentStatus;
  reason_codes: ColumnType<string[], string, string>;
  checks: ColumnType<Record<string, unknown>, string, string>;
  owner_epoch: ColumnType<string | null, string | number | null, string | number | null>;
  config_epoch: ColumnType<string | null, string | number | null, string | number | null>;
  /** P3-U1: the strategy epoch the intent was proposed under; null before any goal (D-281). */
  strategy_epoch: ColumnType<
    string | null,
    string | number | null | undefined,
    string | number | null
  >;
  tx_id: string | null;
  tx_hash: string | null;
  /** P3-U3: who proposed it, the agent (propose_swap) or the template runner (D-290). */
  source: ColumnType<"agent" | "template", "agent" | "template" | undefined, "agent" | "template">;
  /** P2-U6: every blocker the checks gave, at proposal or at submission. */
  blockers: ColumnType<Record<string, unknown>[], string | undefined, string>;
  approved_by: "owner" | "auto" | null;
  approved_at: Timestamp | null;
  submitted_at: Timestamp | null;
  settled_at: Timestamp | null;
  min_amount_out: string | null;
  deadline: string | null;
  action_id: string | null;
  amount_out: string | null;
  failure: string | null;
  created_at: Timestamp;
  expires_at: ColumnType<Date, Date, Date>;
  updated_at: Timestamp;
}

export type AgentStateName = "UNCONFIGURED" | "READY" | "RUNNING" | "RESTRICTED" | "INCIDENT";

/** P3-U1: one agent's offchain state (FINAL_PLAN 4.12) and its strategy epoch (D-281). */
export interface AgentStateTable {
  chain_id: number;
  agent_id: number;
  state: AgentStateName;
  strategy_epoch: ColumnType<string, string | number | undefined, string | number>;
  updated_at: Timestamp;
}

/** P3-U1: every change of an agent's state, with its reason. */
export interface AgentStateChangeTable {
  change_id: Generated<number>;
  chain_id: number;
  agent_id: number;
  from_state: AgentStateName;
  to_state: AgentStateName;
  reason: string;
  strategy_epoch: ColumnType<string, string | number, string | number>;
  created_at: Timestamp;
}

/** P3-U1: every goal an owner saved; one current per agent. */
export interface AgentGoalTable {
  goal_id: string;
  chain_id: number;
  agent_id: number;
  strategy_epoch: ColumnType<string, string | number, string | number>;
  owner_epoch: ColumnType<string, string | number, string | number>;
  saved_by: string;
  goal: ColumnType<Record<string, unknown>, string, string>;
  config: ColumnType<Record<string, unknown>, string, string>;
  policy_hash: string;
  soul_block: string;
  current: boolean;
  created_at: Timestamp;
}

/** One arming of an agent by its owner (P2-U6), from the session grant to its end. */
export interface ArmingTable {
  arming_id: string;
  chain_id: number;
  agent_id: number;
  owner: string;
  owner_epoch: ColumnType<string, string | number, string | number>;
  config_epoch: ColumnType<string, string | number, string | number>;
  session_key: string;
  /** Unix seconds, as the Executor stores it. */
  valid_until: ColumnType<string, string | number, string | number>;
  /** F-U5 (D-367): the custody set, and the Executor the grant is registered on. */
  custody: ColumnType<"v2" | "v3", "v2" | "v3" | undefined, "v2" | "v3">;
  executor: string | null;
  status: "awaiting_first_trade" | "armed" | "ended";
  ended_reason: "expired" | "sold" | "config_changed" | "revoked" | "disarmed" | null;
  first_intent_id: string | null;
  revoked_onchain: ColumnType<boolean, boolean | undefined, boolean>;
  reminded_at: Timestamp | null;
  armed_at: Timestamp | null;
  ended_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** A PersonalAccount's value and balances at one moment (Phase 2 tuning, for W-3's charts). */
export interface AccountSnapshotTable {
  snapshot_id: string;
  environment: string;
  chain_id: number;
  agent_id: number;
  account: string;
  block_number: ColumnType<string, string | number, string | number>;
  block_time: ColumnType<string, string | number, string | number>;
  value_usdc_e6: string | null;
  usdc_e6: string;
  wmon_wei: string;
  /** F-U5: the custody set, and for v3 every held token with its amount, price and value. */
  custody: ColumnType<"v2" | "v3", "v2" | "v3" | undefined, "v2" | "v3">;
  holdings: ColumnType<Record<string, unknown>[] | null, string | null | undefined, string | null>;
  mode: "NORMAL" | "REDUCE_ONLY" | "PAUSED" | "HANDOVER" | "WIND_DOWN";
  reason: "interval" | "trade";
  intent_id: string | null;
  created_at: Timestamp;
}

/** One agent's session key in the signer (P2-U4, D-243). */
export interface SignerKeyTable {
  chain_id: number;
  agent_id: number;
  address: string;
  provider: "local" | "kms" | "canary";
  kms_key_id: string | null;
  next_nonce: ColumnType<number, number | undefined, number>;
  writer_fence: ColumnType<number, number | undefined, number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** packages/domain's TRANSACTION_STATES (a signer test holds them equal, with the migration's check). */
export type SignerStatus =
  "accepted" | "signed" | "submitted" | "unknown" | "confirmed" | "reconciled" | "failed";

/** One transaction in the signer's outbox (P2-U4). */
export interface SignerOutboxTable {
  tx_id: string;
  environment: string;
  chain_id: number;
  agent_id: number;
  key_address: string;
  kind: "executor_swap" | "usdc_refund" | "usdc_settlement";
  action_id: string | null;
  request: ColumnType<Record<string, unknown>, string, string>;
  intent: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  status: SignerStatus;
  reason_code: string | null;
  reason: string | null;
  nonce: number | null;
  gas_limit: string | null;
  max_fee_per_gas: string | null;
  max_priority_fee_per_gas: string | null;
  raw_tx: string | null;
  tx_hash: string | null;
  submitted_at: Timestamp | null;
  unknown_since: Timestamp | null;
  block_number: number | null;
  block_hash: string | null;
  gas_used: string | null;
  amount_out: string | null;
  balances: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  ledger_entry_id: string | null;
  history: ColumnType<unknown[], string | undefined, string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** One tool call in the action log (D-213, D-215). */
export interface ToolCallTable {
  call_id: string;
  chain_id: number;
  agent_id: number;
  lease_id: string;
  server: "data" | "platform" | "chain";
  tool: string;
  input: ColumnType<Record<string, unknown>, string, string>;
  status: "running" | "succeeded" | "failed" | "refused";
  error_code: string | null;
  charge_usdc_e6: ColumnType<string, string | undefined, string>;
  entry_id: string | null;
  reversal_entry_id: string | null;
  cache_hit: ColumnType<boolean, boolean | undefined, boolean>;
  provider: string | null;
  summary: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  started_at: Timestamp;
  finished_at: Timestamp | null;
  /** P3-U4: the cycle's stage run the call was made in; null outside a cycle. */
  stage_run_id: ColumnType<string | null, string | null | undefined, string | null>;
}

/** One `complete_stage` call: once per stage run in a cycle, once per stage per lease outside one. */
export interface StageRecordTable {
  stage_id: string;
  chain_id: number;
  agent_id: number;
  lease_id: string;
  stage: string;
  outcome: string;
  candidates: ColumnType<unknown[], string, string>;
  created_at: Timestamp;
  stage_run_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** A Zoom out's decision (P3-U4): no change with its reason code, or a proposed plan. */
  decision: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
}

/** The `write_thesis` stub's notes: private research, never served to owners. */
export interface ThesisNoteTable {
  note_id: string;
  chain_id: number;
  agent_id: number;
  lease_id: string;
  stage: string;
  title: string;
  notes: string;
  sources: ColumnType<string[], string, string>;
  created_at: Timestamp;
  stage_run_id: ColumnType<string | null, string | null | undefined, string | null>;
}

/** An owner-readable activity entry (D-217). */
export interface ActivityEntryTable {
  entry_id: string;
  chain_id: number;
  agent_id: number;
  task_id: string;
  kind: "scan" | "intent" | "arming" | "trade" | "blocked" | "runner" | "stage";
  text: string;
  rendered_by: "narrator" | "template";
  facts: ColumnType<Record<string, unknown>, string, string>;
  rejections: ColumnType<string[], string, string>;
  model: string | null;
  created_at: Timestamp;
}

export type CycleKind = "ROUTINE" | "TRIGGERED" | "ACTIVATION";
export type StageName = "SCAN" | "DIVE" | "CHALLENGE" | "TEST" | "ZOOM_OUT";
type Numeric = ColumnType<string, string | undefined, string>;
type BigintCount = ColumnType<string, number | string | undefined, number | string>;

/** A research cycle (P3-U4): one task, one lease, its stages in order. */
export interface ResearchCycleTable {
  cycle_id: string;
  chain_id: number;
  agent_id: number;
  task_id: string;
  kind: CycleKind;
  status: "queued" | "running" | "completed" | "stopped" | "failed";
  stop_reason: string | null;
  reasoning_alias: string;
  lease_id: string | null;
  /** The marker planted in the cycle's SOUL.md that a brief must never contain. */
  canary: string;
  charged_usdc_e6: Numeric;
  absorbed_usdc_e6: Numeric;
  created_at: Timestamp;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
}

/** One stage of a cycle (P3-U4). */
export interface StageRunTable {
  stage_run_id: string;
  cycle_id: string;
  chain_id: number;
  agent_id: number;
  seq: number;
  stage: StageName;
  theme_code: string | null;
  idempotency_key: string;
  model_alias: string | null;
  caps: ColumnType<Record<string, unknown>, string, string>;
  ceiling_usdc_e6: Numeric;
  status: "pending" | "running" | "completed" | "capped" | "stopped" | "failed" | "skipped";
  stop_reason: string | null;
  run_id: string | null;
  session_id: string | null;
  outcome: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  model_calls: ColumnType<number, number | undefined, number>;
  input_tokens: BigintCount;
  output_tokens: BigintCount;
  cache_read_tokens: BigintCount;
  cache_write_tokens: BigintCount;
  charged_usdc_e6: Numeric;
  absorbed_usdc_e6: Numeric;
  created_at: Timestamp;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
}

/** A model call the gate forwarded (P3-U4), keyed by LiteLLM's request ID. */
export interface ModelCallTable {
  request_id: string;
  chain_id: number;
  agent_id: number;
  lease_id: string;
  stage_run_id: string | null;
  model: string;
  status: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  at: Timestamp;
}

/** A typed research brief (D-284): accepted ones are what owners may see. */
export interface ResearchBriefTable {
  brief_id: string;
  chain_id: number;
  agent_id: number;
  cycle_id: string;
  stage_run_id: string;
  kind: "SCAN" | "THEME" | "CHALLENGE" | "OVERVIEW" | "RATIONALE";
  status: "accepted" | "refused";
  body: ColumnType<Record<string, unknown>, string, string>;
  reasons: ColumnType<string[], string, string>;
  created_at: Timestamp;
}

/** What a cycle's tool call returned, bounded and platform-only (P3-U4). */
export interface ToolResultTable {
  call_id: string;
  cycle_id: string;
  stage_run_id: string;
  tool: string;
  result: ColumnType<unknown, string, string>;
  truncated: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Timestamp;
}

/** A steered reveal on the local fork (D-221), persisted so restarts keep it. */
export interface RevealSteerTable {
  steer_id: string;
  chain_id: number;
  target_kind: "wallet" | "agent";
  wallet: string | null;
  agent_id: number | null;
  agent_owner: string | null;
  species: number;
  status: "pending" | "applied" | "failed" | "cancelled";
  applied_agent_id: number | null;
  note: string | null;
  created_at: Timestamp;
  resolved_at: Timestamp | null;
}

/** P3-U9: a paid upstream's usage per UTC day, in its own unit. */
export interface ProviderUsageTable {
  provider: string;
  day: ColumnType<string, string, string>;
  used: ColumnType<number, number, number>;
  updated_at: Timestamp;
}

/** P3-U3: a plan set for an agent; one active per agent. */
export interface StrategyParamsTable {
  param_id: string;
  chain_id: number;
  agent_id: number;
  template: string;
  params: ColumnType<Record<string, unknown>, string, string>;
  params_hash: string;
  strategy_epoch: ColumnType<string, string | number, string | number>;
  set_by: "owner" | "console" | "agent" | "activation";
  set_by_address: string | null;
  active: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Timestamp;
  superseded_at: Timestamp | null;
}

/** P3-U3: one of the runner's decisions; a new row only when the outcome or reason changes. */
export interface RunnerDecisionTable {
  decision_id: Generated<number>;
  chain_id: number;
  agent_id: number;
  param_id: string | null;
  strategy_epoch: ColumnType<string, string | number, string | number>;
  outcome: "hold" | "leg";
  code: string;
  codes: ColumnType<string[], string, string>;
  leg: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  intent_id: string | null;
  facts: ColumnType<Record<string, unknown>, string, string>;
  block: ColumnType<string | null, string | number | null, string | number | null>;
  first_at: ColumnType<Date, Date | string, Date | string>;
  last_at: ColumnType<Date, Date | string, Date | string>;
  ticks: ColumnType<number, number | undefined, number>;
}

/** F-U1: a token in the platform's registry, keyed by chain and lowercase address. */
export interface TokenTable {
  chain_id: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  price_class: "F" | "A";
  feed: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  listings: ColumnType<Record<string, unknown>, string | undefined, string>;
  liquidity_usd: ColumnType<number, number | undefined, number>;
  volume_24h_usd: ColumnType<number, number | undefined, number>;
  deepest_pool: string | null;
  oldest_pool_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  latest_screen_id: string | null;
  screen_verdict: "passed" | "refused" | null;
  screened_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  screen_expires_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  registry_lane: "core" | "screened" | null;
  registry_status: "listed" | "sell_only" | "delisted" | null;
  /** F-U2 Step 0: `discovery`, `console` or `agent:<id>`, whoever first found the token. */
  found_by: ColumnType<string, string | undefined, string>;
  first_seen_at: Timestamp;
  last_seen_at: Timestamp;
}

/** F-U1: a pool seen on Uniswap v3, Uniswap v4 or PancakeSwap v3. */
export interface TokenPoolTable {
  chain_id: number;
  pool_id: string;
  dex: "uniswap_v3" | "uniswap_v4" | "pancakeswap_v3";
  token0: string;
  token1: string;
  fee: number | null;
  tick_spacing: number | null;
  hooks: string | null;
  routable: boolean;
  route_note: string;
  liquidity_usd: number;
  volume_24h_usd: number;
  pool_created_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  first_seen_at: Timestamp;
  last_seen_at: Timestamp;
}

/** F-U1: one screen of a token, kept as history. */
export interface TokenScreenTable {
  screen_id: string;
  chain_id: number;
  address: string;
  verdict: "passed" | "refused";
  checks: ColumnType<unknown[], string, string>;
  route: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  fork_block: number | null;
  requested_by: string;
  duration_ms: number;
  created_at: Timestamp;
  expires_at: ColumnType<Date, Date | string, Date | string>;
}

/** F-U1: one discovery pass. */
export interface TokenDiscoveryRunTable {
  run_id: string;
  chain_id: number;
  status: "running" | "completed" | "failed";
  pools_seen: ColumnType<number, number | undefined, number>;
  tokens_seen: ColumnType<number, number | undefined, number>;
  new_pools: ColumnType<number, number | undefined, number>;
  sources: ColumnType<Record<string, unknown>, string | undefined, string>;
  error: string | null;
  started_at: Timestamp;
  finished_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
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
  "platform.intents": IntentTable;
  "platform.arming": ArmingTable;
  "platform.agent_states": AgentStateTable;
  "platform.agent_state_changes": AgentStateChangeTable;
  "platform.agent_goals": AgentGoalTable;
  "platform.account_snapshots": AccountSnapshotTable;
  "platform.refunds": RefundTable;
  "platform.signer_keys": SignerKeyTable;
  "platform.signer_outbox": SignerOutboxTable;
  "platform.tool_calls": ToolCallTable;
  "platform.stage_records": StageRecordTable;
  "platform.thesis_notes": ThesisNoteTable;
  "platform.activity_entries": ActivityEntryTable;
  "platform.reveal_steers": RevealSteerTable;
  "platform.provider_usage": ProviderUsageTable;
  "platform.strategy_params": StrategyParamsTable;
  "platform.runner_decisions": RunnerDecisionTable;
  "platform.research_cycles": ResearchCycleTable;
  "platform.stage_runs": StageRunTable;
  "platform.model_calls": ModelCallTable;
  "platform.research_briefs": ResearchBriefTable;
  "platform.tool_results": ToolResultTable;
  "platform.tokens": TokenTable;
  "platform.token_pools": TokenPoolTable;
  "platform.token_screens": TokenScreenTable;
  "platform.token_discovery_runs": TokenDiscoveryRunTable;
}
