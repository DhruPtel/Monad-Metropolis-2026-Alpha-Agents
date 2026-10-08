import { randomUUID } from "node:crypto";
import { type Db, dbAddress } from "@alpha-agents/db";
import type { AccountMode } from "@alpha-agents/domain";
import type { Hex } from "viem";

/**
 * Value snapshots (Phase 2 tuning): each PersonalAccount's value in USDC, its
 * USDC and WMON balances and its mode, recorded at a regular interval and
 * after every settled trade, per environment, for W-3's charts. Built from
 * the reads the platform already makes (the account and the oracle price, as
 * the portfolio route reads them); recording adds no read of its own.
 */

/** A-49: one interval snapshot per account at most this often. */
export const SNAPSHOT_INTERVAL_MS = 15 * 60_000;

export interface AccountObservation {
  readonly agentId: number;
  readonly account: Hex;
  readonly block: bigint;
  /** The block's time, unix seconds. */
  readonly timestamp: bigint;
  readonly usdc: bigint;
  readonly wmon: bigint;
  readonly mode: AccountMode;
  /** MON/USD at 1e18; null while the oracle's price is unusable. */
  readonly monUsdE18: bigint | null;
}

/** The account's value in USDC base units, or null when WMON is held and has no usable price. */
export function accountValueUsdc(o: Pick<AccountObservation, "usdc" | "wmon" | "monUsdE18">) {
  if (o.wmon === 0n) return o.usdc;
  if (o.monUsdE18 === null) return null;
  return o.usdc + (o.wmon * o.monUsdE18) / 10n ** 30n;
}

export interface SnapshotRow {
  readonly agentId: number;
  readonly account: Hex;
  readonly block: bigint;
  readonly blockTime: bigint;
  readonly valueUsdc: bigint | null;
  readonly usdc: bigint;
  readonly wmon: bigint;
  readonly mode: AccountMode;
  readonly reason: "interval" | "trade";
  readonly intentId: string | null;
  readonly createdAt: Date;
}

export class SnapshotStore {
  readonly db: Db;
  private readonly environment: string;
  private readonly now: () => Date;

  constructor(db: Db, environment: string, now: () => Date = () => new Date()) {
    this.db = db;
    this.environment = environment;
    this.now = now;
  }

  /** Records one snapshot; false when this trade's snapshot already exists. */
  async record(
    chainId: number,
    o: AccountObservation,
    reason: "interval" | "trade",
    intentId: string | null = null,
  ): Promise<boolean> {
    const value = accountValueUsdc(o);
    const r = await this.db
      .insertInto("platform.account_snapshots")
      .values({
        snapshot_id: `snap-${randomUUID()}`,
        environment: this.environment,
        chain_id: chainId,
        agent_id: o.agentId,
        account: dbAddress(o.account),
        block_number: o.block.toString(),
        block_time: o.timestamp.toString(),
        value_usdc_e6: value === null ? null : value.toString(),
        usdc_e6: o.usdc.toString(),
        wmon_wei: o.wmon.toString(),
        mode: o.mode,
        reason,
        intent_id: intentId,
        created_at: this.now(),
      })
      .onConflict((oc) => oc.column("intent_id").where("intent_id", "is not", null).doNothing())
      .executeTakeFirst();
    return Number(r.numInsertedOrUpdatedRows ?? 0n) === 1;
  }

  /** Whether the agent's account is due an interval snapshot: none yet, or the last is older than `everyMs`. */
  async due(chainId: number, agentId: number, everyMs = SNAPSHOT_INTERVAL_MS): Promise<boolean> {
    const last = await this.db
      .selectFrom("platform.account_snapshots")
      .select("created_at")
      .where("environment", "=", this.environment)
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("reason", "=", "interval")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return !last || this.now().getTime() - new Date(last.created_at).getTime() >= everyMs;
  }

  /** The agent's snapshots, newest first. */
  async list(chainId: number, agentId: number, limit = 100): Promise<SnapshotRow[]> {
    const rows = await this.db
      .selectFrom("platform.account_snapshots")
      .selectAll()
      .where("environment", "=", this.environment)
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      agentId: r.agent_id,
      account: r.account as Hex,
      block: BigInt(r.block_number),
      blockTime: BigInt(r.block_time),
      valueUsdc: r.value_usdc_e6 === null ? null : BigInt(r.value_usdc_e6),
      usdc: BigInt(r.usdc_e6),
      wmon: BigInt(r.wmon_wei),
      mode: r.mode,
      reason: r.reason,
      intentId: r.intent_id,
      createdAt: new Date(r.created_at),
    }));
  }
}
