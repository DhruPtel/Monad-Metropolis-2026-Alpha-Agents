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

/** One held token of a v3 account at the snapshot (F-U5): amount, price and value as the account values it. */
export interface HoldingSnapshot {
  readonly token: Hex;
  readonly symbol: string;
  readonly decimals: number;
  readonly amountRaw: string;
  readonly priceE18: string | null;
  readonly valueUsdcE6: string | null;
  readonly costBasisUsdcE6: string | null;
}

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
  /** F-U5: a v3 account's own value (its navUsdc, null while unusable) and every held token. */
  readonly custody?: "v2" | "v3";
  readonly valueUsdcE6?: bigint | null;
  readonly holdings?: readonly HoldingSnapshot[];
  /**
   * F-U11: the value per unit (1e18) from the breaker: deposits mint units and
   * withdrawals burn them at the going value per unit, so neither moves it.
   * Null while the breaker's price is unusable.
   */
  readonly perUnitE18?: bigint | null;
}

/** The account's value in USDC base units, or null when WMON is held and has no usable price. */
export function accountValueUsdc(
  o: Pick<AccountObservation, "usdc" | "wmon" | "monUsdE18" | "custody" | "valueUsdcE6">,
) {
  if (o.custody === "v3") return o.valueUsdcE6 ?? null;
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
  readonly custody: "v2" | "v3";
  readonly holdings: readonly HoldingSnapshot[] | null;
  /** F-U11: the value per unit at the snapshot, or null. */
  readonly perUnit: bigint | null;
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
        custody: o.custody ?? "v2",
        holdings: o.holdings ? JSON.stringify(o.holdings) : null,
        per_unit_e18:
          o.perUnitE18 === undefined || o.perUnitE18 === null ? null : o.perUnitE18.toString(),
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
    return rows.map(snapshotRow);
  }

  /** F-U11: the agent's snapshots since a moment, oldest first, for the window's chart. */
  async since(chainId: number, agentId: number, from: Date, limit = 4_000): Promise<SnapshotRow[]> {
    const rows = await this.db
      .selectFrom("platform.account_snapshots")
      .selectAll()
      .where("environment", "=", this.environment)
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .where("created_at", ">=", from)
      .orderBy("created_at", "asc")
      .limit(limit)
      .execute();
    return rows.map(snapshotRow);
  }
}

const snapshotRow = (r: {
  agent_id: number;
  account: string;
  block_number: string;
  block_time: string;
  value_usdc_e6: string | null;
  usdc_e6: string;
  wmon_wei: string;
  custody: "v2" | "v3";
  holdings: Record<string, unknown>[] | null;
  per_unit_e18: string | null;
  mode: AccountMode;
  reason: "interval" | "trade";
  intent_id: string | null;
  created_at: Date | string;
}): SnapshotRow => ({
  agentId: r.agent_id,
  account: r.account as Hex,
  block: BigInt(r.block_number),
  blockTime: BigInt(r.block_time),
  valueUsdc: r.value_usdc_e6 === null ? null : BigInt(r.value_usdc_e6),
  usdc: BigInt(r.usdc_e6),
  wmon: BigInt(r.wmon_wei),
  custody: r.custody,
  holdings: (r.holdings as HoldingSnapshot[] | null) ?? null,
  perUnit: r.per_unit_e18 === null ? null : BigInt(r.per_unit_e18),
  mode: r.mode,
  reason: r.reason,
  intentId: r.intent_id,
  createdAt: new Date(r.created_at),
});
