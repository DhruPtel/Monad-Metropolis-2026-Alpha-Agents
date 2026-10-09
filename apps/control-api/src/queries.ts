import { randomUUID } from "node:crypto";
import { ownShare } from "@alpha-agents/accounting";
import {
  type AgentTable,
  type Db,
  dbAddress,
  readContributionWeights,
  sql,
} from "@alpha-agents/db";
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
  /**
   * What a refund pays the current owner now: only the owner's own share of
   * the spendable and held credits, by contributions (D-242).
   */
  readonly ownRefundUsdcE6: string;
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
  const held = owed("held_deposits");
  const agent = await db
    .selectFrom("indexer.agents")
    .select("owner")
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .executeTakeFirst();
  const own = agent
    ? ownShare(
        await readContributionWeights(db, chainId, agentId, agent.owner),
        spendable + (held > 0n ? held : 0n),
      ).amount
    : 0n;
  return {
    fundingAddress: getAddress(funding.address),
    creditsUsdcE6: credits.toString(),
    spendableUsdcE6: spendable.toString(),
    heldUsdcE6: held.toString(),
    unsettledUsdcE6: owed("usage_unsettled").toString(),
    ownRefundUsdcE6: own.toString(),
    restricted: spendable === 0n,
  };
}

export interface ActivityJson {
  readonly entryId: string;
  readonly kind: "scan" | "intent" | "arming" | "trade" | "blocked" | "runner" | "stage";
  /** The narrator's text, validated against its facts, or the fixed template's (D-217). */
  readonly text: string;
  readonly renderedBy: "narrator" | "template";
  readonly at: string;
}

/** An agent's activity entries, newest first. The facts behind them are never served. */
export async function readActivity(
  db: Db,
  chainId: number,
  agentId: number,
  limit = 20,
): Promise<ActivityJson[]> {
  const rows = await db
    .selectFrom("platform.activity_entries")
    .select(["entry_id", "kind", "text", "rendered_by", "created_at"])
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    entryId: r.entry_id,
    kind: r.kind,
    text: r.text,
    renderedBy: r.rendered_by,
    at: new Date(r.created_at).toISOString(),
  }));
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

// --- My Agents (P1-U9, D-218) ---------------------------------------------

/** What an owner sees an agent doing (D-218). */
export type RunStatus =
  "awaiting_reveal" | "provisioning" | "ready" | "running" | "restricted" | "failed" | "stopped";

export interface ChargeJson {
  readonly entryId: string;
  readonly at: string;
  /** A model call, a tool call, or a charge given back for a tool call that was not answered. */
  readonly kind: "model" | "tool" | "reversal";
  /** The model alias or the tool name. */
  readonly label: string;
  /** Credits taken (positive) or given back (negative), in USDC base units. */
  readonly amountUsdcE6: string;
}

export interface ScanJson {
  readonly taskId: string;
  readonly status: "queued" | "running" | "succeeded" | "failed";
  readonly stopReason: string | null;
  readonly error: string | null;
  readonly requestedBy: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface SummaryJson {
  readonly runStatus: RunStatus;
  readonly credits: CreditsJson | null;
  readonly spent24hUsdcE6: string;
  readonly charges: readonly ChargeJson[];
  readonly latestScan: ScanJson | null;
}

/** The run status from the index, the runtime, the agent's lease and its credits. */
export async function readRunStatus(
  db: Db,
  chainId: number,
  agentId: number,
  credits: CreditsJson | null,
): Promise<RunStatus> {
  const agent = await db
    .selectFrom("indexer.agents")
    .select("species")
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .executeTakeFirst();
  if (!agent || agent.species === 0) return "awaiting_reveal";
  const runtime = await db
    .selectFrom("platform.agent_runtimes")
    .select("status")
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .executeTakeFirst();
  if (!runtime || runtime.status === "provisioning") return "provisioning";
  if (runtime.status === "failed") return "failed";
  if (runtime.status !== "ready") return "stopped";
  const lease = await db
    .selectFrom("platform.sandbox_leases")
    .select("lease_id")
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (lease) return "running";
  return credits?.restricted !== false ? "restricted" : "ready";
}

/** Usage charges and their reversals, newest first, from the credit ledger. */
export async function readCharges(
  db: Db,
  chainId: number,
  agentId: number,
  limit = 20,
): Promise<ChargeJson[]> {
  const rows = await db
    .selectFrom("platform.ledger_entries as e")
    .innerJoin("platform.ledger_lines as l", (j) =>
      j.onRef("l.entry_id", "=", "e.entry_id").on("l.account", "=", "agent_credits"),
    )
    .leftJoin("platform.tool_calls as c", (j) =>
      j.on(sql<boolean>`c.call_id = e.source->>'callId'`),
    )
    .select([
      "e.entry_id",
      "e.kind",
      "e.created_at",
      "l.amount",
      sql<string | null>`e.source->>'kind'`.as("source_kind"),
      sql<string | null>`e.source->>'model'`.as("model"),
      "c.tool",
    ])
    .where("e.chain_id", "=", chainId)
    .where("e.agent_id", "=", agentId)
    .where("e.kind", "in", ["usage_metered", "usage_reversed"])
    .orderBy("e.created_at", "desc")
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    entryId: r.entry_id,
    at: new Date(r.created_at).toISOString(),
    kind:
      r.kind === "usage_reversed" ? "reversal" : r.source_kind === "tool_call" ? "tool" : "model",
    label: r.tool ?? r.model ?? "model",
    // A usage line adds to agent_credits (what the platform owes falls): a positive amount is a charge.
    amountUsdcE6: BigInt(r.amount).toString(),
  }));
}

/** Net credits spent in the last 24 hours: charges less reversals. */
export async function readSpent24h(db: Db, chainId: number, agentId: number): Promise<bigint> {
  const row = await db
    .selectFrom("platform.ledger_entries as e")
    .innerJoin("platform.ledger_lines as l", (j) =>
      j.onRef("l.entry_id", "=", "e.entry_id").on("l.account", "=", "agent_credits"),
    )
    .select(sql<string | null>`sum(l.amount)`.as("total"))
    .where("e.chain_id", "=", chainId)
    .where("e.agent_id", "=", agentId)
    .where("e.kind", "in", ["usage_metered", "usage_reversed"])
    .where("e.created_at", ">", new Date(Date.now() - 24 * 3_600_000))
    .executeTakeFirst();
  return BigInt(row?.total ?? "0");
}

export async function readLatestScan(
  db: Db,
  chainId: number,
  agentId: number,
): Promise<ScanJson | null> {
  const row = await db
    .selectFrom("platform.agent_tasks")
    .selectAll()
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .where("kind", "=", "scan")
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return {
    taskId: row.task_id,
    status: row.status,
    stopReason:
      typeof (row.result as { stopReason?: unknown } | null)?.stopReason === "string"
        ? String((row.result as { stopReason: string }).stopReason)
        : null,
    error: row.error,
    requestedBy: row.requested_by,
    createdAt: new Date(row.created_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
  };
}

export async function readSummary(db: Db, chainId: number, agentId: number): Promise<SummaryJson> {
  const credits = await readCredits(db, chainId, agentId);
  return {
    runStatus: await readRunStatus(db, chainId, agentId, credits),
    credits,
    spent24hUsdcE6: (await readSpent24h(db, chainId, agentId)).toString(),
    charges: await readCharges(db, chainId, agentId),
    latestScan: await readLatestScan(db, chainId, agentId),
  };
}

export type ScanRequest =
  | { readonly taskId: string }
  | { readonly refused: "not_provisioned" | "credits_low" | "scan_open" };

/** Records an owner's Scan for the orchestrator to queue (D-219), after its checks. */
export async function requestScan(
  db: Db,
  chainId: number,
  agentId: number,
  minimumUsdcE6: bigint,
): Promise<ScanRequest> {
  const runtime = await db
    .selectFrom("platform.agent_runtimes")
    .select("status")
    .where("chain_id", "=", chainId)
    .where("agent_id", "=", agentId)
    .executeTakeFirst();
  if (runtime?.status !== "ready") return { refused: "not_provisioned" };
  const credits = await readCredits(db, chainId, agentId);
  if (!credits || BigInt(credits.spendableUsdcE6) < minimumUsdcE6)
    return { refused: "credits_low" };
  const taskId = randomUUID();
  try {
    await db
      .insertInto("platform.agent_tasks")
      .values({
        task_id: taskId,
        chain_id: chainId,
        agent_id: agentId,
        kind: "scan",
        status: "queued",
        requested_by: "owner",
      })
      .execute();
  } catch (err) {
    if (err instanceof Error && /agent_tasks_one_open_scan/.test(err.message))
      return { refused: "scan_open" };
    throw err;
  }
  return { taskId };
}
