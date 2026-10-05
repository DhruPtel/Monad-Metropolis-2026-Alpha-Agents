import { type Kysely, sql } from "kysely";

/**
 * P1-U4: the indexer's chain projections and the platform's mint allowlist
 * and issued claims (D-199).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createSchema("indexer").ifNotExists().execute();
  await db.schema.createSchema("platform").ifNotExists().execute();
  const ix = db.schema.withSchema("indexer");
  const pf = db.schema.withSchema("platform");

  await ix
    .createTable("watermarks")
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("source", "text", (c) => c.notNull())
    .addColumn("block_number", "bigint", (c) => c.notNull())
    .addColumn("block_hash", "text", (c) => c.notNull())
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("watermarks_pk", ["chain_id", "source"])
    .execute();

  await ix
    .createTable("indexed_blocks")
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("block_number", "bigint", (c) => c.notNull())
    .addColumn("block_hash", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint("indexed_blocks_pk", ["chain_id", "block_number"])
    .execute();

  await ix
    .createTable("agent_nft_events")
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("contract", "text", (c) => c.notNull())
    .addColumn("block_number", "bigint", (c) => c.notNull())
    .addColumn("block_hash", "text", (c) => c.notNull())
    .addColumn("tx_hash", "text", (c) => c.notNull())
    .addColumn("log_index", "integer", (c) => c.notNull())
    .addColumn("event_name", "text", (c) => c.notNull())
    .addColumn("args", "jsonb", (c) => c.notNull())
    .addPrimaryKeyConstraint("agent_nft_events_pk", ["chain_id", "tx_hash", "log_index"])
    .execute();
  await ix
    .createIndex("agent_nft_events_block")
    .on("agent_nft_events")
    .columns(["chain_id", "block_number", "log_index"])
    .execute();

  await ix
    .createTable("agents")
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    .addColumn("owner", "text", (c) => c.notNull())
    .addColumn("tba", "text", (c) => c.notNull())
    .addColumn("species", "smallint", (c) => c.notNull())
    .addColumn("tier", "smallint", (c) => c.notNull())
    .addColumn("owner_epoch", "bigint", (c) => c.notNull())
    .addColumn("minted_block", "bigint", (c) => c.notNull())
    .addColumn("minted_tx", "text", (c) => c.notNull())
    .addColumn("block_number", "bigint", (c) => c.notNull())
    .addColumn("block_hash", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint("agents_pk", ["chain_id", "agent_id"])
    .execute();
  await ix.createIndex("agents_owner").on("agents").columns(["chain_id", "owner"]).execute();
  await ix.createIndex("agents_tba").on("agents").columns(["chain_id", "tba"]).execute();

  await ix
    .createTable("usdc_transfers")
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("block_number", "bigint", (c) => c.notNull())
    .addColumn("block_hash", "text", (c) => c.notNull())
    .addColumn("tx_hash", "text", (c) => c.notNull())
    .addColumn("log_index", "integer", (c) => c.notNull())
    .addColumn("from_address", "text", (c) => c.notNull())
    .addColumn("to_address", "text", (c) => c.notNull())
    .addColumn("value", "numeric(78, 0)", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    .addColumn("direction", "text", (c) => c.notNull().check(sql`direction in ('in', 'out')`))
    // A transfer between two agents' accounts is one row per side.
    .addPrimaryKeyConstraint("usdc_transfers_pk", ["chain_id", "tx_hash", "log_index", "direction"])
    .execute();
  await ix
    .createIndex("usdc_transfers_agent")
    .on("usdc_transfers")
    .columns(["chain_id", "agent_id", "block_number"])
    .execute();

  await ix
    .createTable("incidents")
    .addColumn("id", "serial", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull().check(sql`kind in ('reorg', 'rewind', 'gap')`))
    .addColumn("block_number", "bigint", (c) => c.notNull())
    .addColumn("stored_hash", "text")
    .addColumn("chain_hash", "text")
    .addColumn("rolled_back_to", "bigint", (c) => c.notNull())
    .addColumn("detail", "text", (c) => c.notNull())
    .addColumn("detected_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await pf
    .createTable("mint_allowlist")
    .addColumn("wallet", "text", (c) => c.primaryKey().check(sql`wallet ~ '^0x[0-9a-f]{40}$'`))
    .addColumn("note", "text")
    .addColumn("added_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await pf
    .createTable("mint_claims")
    .addColumn("nonce", "text", (c) => c.primaryKey())
    .addColumn("wallet", "text", (c) => c.notNull())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("contract", "text", (c) => c.notNull())
    .addColumn("deadline", "bigint", (c) => c.notNull())
    .addColumn("user_id", "text", (c) => c.notNull())
    .addColumn("issued_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await pf.createIndex("mint_claims_wallet").on("mint_claims").column("wallet").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropSchema("platform").ifExists().cascade().execute();
  await db.schema.dropSchema("indexer").ifExists().cascade().execute();
}
