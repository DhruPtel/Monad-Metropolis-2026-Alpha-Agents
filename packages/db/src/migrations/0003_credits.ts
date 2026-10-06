import { type Kysely, sql } from "kysely";

/**
 * P1-U6: credits (D-207, D-208, D-210).
 *
 * - `indexer.usdc_transfers.account`: whether the agent's side of a transfer
 *   is its token-bound account or its funding address.
 * - `platform.funding_addresses`: each agent's derived funding address.
 * - `platform.ledger_entries` and `platform.ledger_lines`: the double-entry
 *   credit ledger, one idempotency key per source event.
 * - `platform.usage_receipts`: one row per metered LiteLLM request.
 * - `platform.refunds`: refund requests, with the signed transaction stored
 *   before it is broadcast.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("indexer")
    .alterTable("usdc_transfers")
    .addColumn("account", "text", (c) =>
      c
        .notNull()
        .defaultTo("tba")
        .check(sql`account in ('tba', 'funding')`),
    )
    .execute();

  const pf = db.schema.withSchema("platform");

  await pf
    .createTable("funding_addresses")
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    .addColumn("address", "text", (c) => c.notNull().check(sql`address ~ '^0x[0-9a-f]{40}$'`))
    .addColumn("derivation_path", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("funding_addresses_pk", ["chain_id", "agent_id"])
    .addUniqueConstraint("funding_addresses_address", ["chain_id", "address"])
    .execute();

  await pf
    .createTable("ledger_entries")
    .addColumn("entry_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("idempotency_key", "text", (c) => c.notNull().unique())
    .addColumn("occurred_at", "timestamptz", (c) => c.notNull())
    /** What caused it: a transfer, a request, a refund, a reversed entry. */
    .addColumn("source", "jsonb", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await pf
    .createIndex("ledger_entries_agent")
    .on("ledger_entries")
    .columns(["chain_id", "agent_id", "created_at"])
    .execute();

  await pf
    .createTable("ledger_lines")
    .addColumn("entry_id", "text", (c) =>
      c.notNull().references("platform.ledger_entries.entry_id").onDelete("restrict"),
    )
    .addColumn("line_no", "integer", (c) => c.notNull())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint")
    .addColumn("account", "text", (c) => c.notNull())
    .addColumn("asset", "text", (c) => c.notNull())
    .addColumn("amount", "numeric(78, 0)", (c) => c.notNull())
    .addPrimaryKeyConstraint("ledger_lines_pk", ["entry_id", "line_no"])
    .execute();
  await pf
    .createIndex("ledger_lines_agent_account")
    .on("ledger_lines")
    .columns(["chain_id", "agent_id", "account"])
    .execute();

  await pf
    .createTable("usage_receipts")
    .addColumn("key_alias", "text", (c) => c.notNull())
    .addColumn("request_id", "text", (c) => c.notNull())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    .addColumn("model", "text", (c) => c.notNull())
    .addColumn("provider_picos", "numeric(78, 0)", (c) => c.notNull())
    .addColumn("charge_usdc_e6", "numeric(78, 0)", (c) => c.notNull())
    .addColumn("called_at", "timestamptz")
    .addColumn("entry_id", "text", (c) => c.notNull())
    .addColumn("metered_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("usage_receipts_pk", ["key_alias", "request_id"])
    .execute();
  await pf
    .createIndex("usage_receipts_agent")
    .on("usage_receipts")
    .columns(["chain_id", "agent_id", "metered_at"])
    .execute();

  await pf
    .createTable("refunds")
    .addColumn("refund_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    /** The owner and ownership epoch the request was made under. */
    .addColumn("owner", "text", (c) => c.notNull())
    .addColumn("owner_epoch", "bigint", (c) => c.notNull())
    .addColumn("requested_by", "text", (c) =>
      c.notNull().check(sql`requested_by in ('owner', 'console')`),
    )
    .addColumn("status", "text", (c) =>
      c.notNull().check(sql`status in ('requested', 'signed', 'sent', 'refused', 'failed')`),
    )
    .addColumn("credits_usdc_e6", "numeric(78, 0)")
    .addColumn("held_usdc_e6", "numeric(78, 0)")
    .addColumn("raw_tx", "text")
    .addColumn("tx_hash", "text")
    .addColumn("reason", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  // One refund in flight per agent: a second request waits for the first to finish.
  await sql`create unique index refunds_one_open on platform.refunds (chain_id, agent_id) where status in ('requested', 'signed')`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const pf = db.schema.withSchema("platform");
  await pf.dropTable("refunds").ifExists().execute();
  await pf.dropTable("usage_receipts").ifExists().execute();
  await pf.dropTable("ledger_lines").ifExists().execute();
  await pf.dropTable("ledger_entries").ifExists().execute();
  await pf.dropTable("funding_addresses").ifExists().execute();
  await db.schema
    .withSchema("indexer")
    .alterTable("usdc_transfers")
    .dropColumn("account")
    .execute();
}
