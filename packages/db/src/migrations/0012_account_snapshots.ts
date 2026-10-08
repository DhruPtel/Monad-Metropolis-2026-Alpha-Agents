import { type Kysely, sql } from "kysely";

/**
 * Phase 2 tuning: `platform.account_snapshots`, each PersonalAccount's value
 * in USDC, its USDC and WMON balances and its mode, recorded at a regular
 * interval and after every settled trade, per environment and chain. They feed
 * the portfolio charts of W-3; nothing reads them yet but the tests.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .createTable("account_snapshots")
    .addColumn("snapshot_id", "text", (c) => c.primaryKey())
    .addColumn("environment", "text", (c) => c.notNull())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("account", "text", (c) => c.notNull())
    .addColumn("block_number", "bigint", (c) => c.notNull())
    /** The block's time, unix seconds: the chain's clock, not ours. */
    .addColumn("block_time", "bigint", (c) => c.notNull())
    // Null while the WMON price is unusable and WMON is held.
    .addColumn("value_usdc_e6", "numeric(78, 0)")
    .addColumn("usdc_e6", "numeric(78, 0)", (c) => c.notNull())
    .addColumn("wmon_wei", "numeric(78, 0)", (c) => c.notNull())
    .addColumn("mode", "text", (c) =>
      c.notNull().check(sql`mode in ('NORMAL', 'REDUCE_ONLY', 'PAUSED', 'HANDOVER', 'WIND_DOWN')`),
    )
    .addColumn("reason", "text", (c) => c.notNull().check(sql`reason in ('interval', 'trade')`))
    .addColumn("intent_id", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .withSchema("platform")
    .createIndex("account_snapshots_by_agent")
    .on("account_snapshots")
    .columns(["environment", "chain_id", "agent_id", "block_time"])
    .execute();
  // One snapshot per settled trade, however often the recorder sees it.
  await sql`create unique index account_snapshots_one_per_trade on platform.account_snapshots (intent_id) where intent_id is not null`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("platform").dropTable("account_snapshots").execute();
}
