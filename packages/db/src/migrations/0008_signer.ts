import { type Kysely, sql } from "kysely";

/**
 * P2-U4: the signer (D-243 to D-246).
 *
 * - `platform.signer_keys`: one session key per agent, its provider, the next
 *   nonce it will use and the fence of the one writer allowed to use it. The
 *   nonce is allocated in the same database transaction that stores the
 *   signed transaction, so a restart neither reuses nor skips one.
 * - `platform.signer_outbox`: every transaction the signer is asked for, from
 *   accepted to reconciled or failed. An Executor action ID appears once per
 *   chain, so a duplicate request converges on the first. The signed bytes are
 *   stored before they are broadcast.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const pf = db.schema.withSchema("platform");

  await pf
    .createTable("signer_keys")
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    .addColumn("address", "text", (c) => c.notNull().check(sql`address ~ '^0x[0-9a-f]{40}$'`))
    .addColumn("provider", "text", (c) => c.notNull().check(sql`provider in ('local', 'kms')`))
    /** The KMS key's ID (not secret: KMS signs only for authorized callers). */
    .addColumn("kms_key_id", "text")
    .addColumn("next_nonce", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("writer_fence", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("signer_keys_pk", ["chain_id", "agent_id"])
    .addUniqueConstraint("signer_keys_address", ["chain_id", "address"])
    .execute();

  await pf
    .createTable("signer_outbox")
    .addColumn("tx_id", "text", (c) => c.primaryKey())
    .addColumn("environment", "text", (c) => c.notNull())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    .addColumn("key_address", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull().check(sql`kind in ('executor_swap')`))
    .addColumn("action_id", "text")
    /** The call as requested: to, data and value. */
    .addColumn("request", "jsonb", (c) => c.notNull())
    /** The decoded swap intent, amounts as decimal strings; null when it does not decode. */
    .addColumn("intent", "jsonb")
    .addColumn("status", "text", (c) =>
      c
        .notNull()
        .check(
          sql`status in ('accepted', 'signed', 'submitted', 'unknown', 'confirmed', 'reconciled', 'failed')`,
        ),
    )
    .addColumn("reason_code", "text")
    .addColumn("reason", "text")
    .addColumn("nonce", "bigint")
    .addColumn("gas_limit", "numeric(78, 0)")
    .addColumn("max_fee_per_gas", "numeric(78, 0)")
    .addColumn("max_priority_fee_per_gas", "numeric(78, 0)")
    .addColumn("raw_tx", "text")
    .addColumn("tx_hash", "text")
    .addColumn("submitted_at", "timestamptz")
    .addColumn("unknown_since", "timestamptz")
    .addColumn("block_number", "bigint")
    .addColumn("block_hash", "text")
    .addColumn("gas_used", "numeric(78, 0)")
    .addColumn("amount_out", "numeric(78, 0)")
    /** The account's tokenIn and tokenOut balances before and after the swap's block, read from the chain. */
    .addColumn("balances", "jsonb")
    .addColumn("ledger_entry_id", "text")
    /** Every state change, oldest first: { status, at, detail }. */
    .addColumn("history", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("signer_outbox_action", ["chain_id", "action_id"])
    .addUniqueConstraint("signer_outbox_nonce", ["chain_id", "key_address", "nonce"])
    .execute();
  await pf
    .createIndex("signer_outbox_open")
    .on("signer_outbox")
    .columns(["status", "created_at"])
    .execute();
  await pf
    .createIndex("signer_outbox_agent")
    .on("signer_outbox")
    .columns(["chain_id", "agent_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const pf = db.schema.withSchema("platform");
  await pf.dropTable("signer_outbox").execute();
  await pf.dropTable("signer_keys").execute();
}
