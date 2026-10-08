import { type Kysely, sql } from "kysely";

/**
 * P2-U5: the chain tools server.
 * - `platform.intents`: every swap an agent proposed, with its parameters, the
 *   agent's reason, the facts its pre-checks read and every reason code they
 *   gave. A passing proposal waits as `awaiting_approval` until the trade flow
 *   (P2-U6) approves and sends it; a failing one is kept as `rejected` (never
 *   pending), so "why the agent did not trade" can show it. The idempotency
 *   key makes one proposal in a run one intent. No calldata is ever stored.
 * - `platform.tool_calls.server` gains `chain`: the read tools are free, and
 *   are logged and rate limited per lease like the paid ones.
 * - `platform.activity_entries.kind` gains `intent`, one entry per proposal,
 *   and `platform.agent_tasks.kind` gains `chain_check`, the task that uses the
 *   chain tools from the console.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const pf = db.schema.withSchema("platform");
  await pf
    .createTable("intents")
    .addColumn("intent_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    .addColumn("lease_id", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull().check(sql`kind in ('swap')`))
    .addColumn("account", "text")
    .addColumn("sell", "text", (c) => c.notNull().check(sql`sell in ('USDC', 'WMON')`))
    .addColumn("buy", "text", (c) => c.notNull().check(sql`buy in ('USDC', 'WMON')`))
    .addColumn("amount_in", "numeric(78, 0)", (c) => c.notNull())
    /** The agent's own words: stored and shown to the owner, never executed. */
    .addColumn("reason", "text", (c) => c.notNull())
    .addColumn("client_request_id", "text")
    .addColumn("idempotency_key", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) =>
      c
        .notNull()
        .check(
          sql`status in ('awaiting_approval', 'rejected', 'expired', 'approved', 'submitted', 'settled', 'failed', 'cancelled')`,
        ),
    )
    .addColumn("reason_codes", "jsonb", (c) => c.notNull())
    /** What the pre-checks read: block, prices, balances, quote, floor. */
    .addColumn("checks", "jsonb", (c) => c.notNull())
    .addColumn("owner_epoch", "bigint")
    .addColumn("config_epoch", "bigint")
    /** The signer outbox row once P2-U6 sends it. */
    .addColumn("tx_id", "text")
    .addColumn("tx_hash", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("intents_idempotency", ["chain_id", "agent_id", "idempotency_key"])
    .execute();
  await pf
    .createIndex("intents_agent")
    .on("intents")
    .columns(["chain_id", "agent_id", "created_at"])
    .execute();
  await sql`alter table platform.tool_calls drop constraint tool_calls_server_check`.execute(db);
  await sql`alter table platform.tool_calls add constraint tool_calls_server_check
    check (server in ('data', 'platform', 'chain'))`.execute(db);
  await sql`alter table platform.activity_entries drop constraint activity_entries_kind_check`.execute(
    db,
  );
  await sql`alter table platform.activity_entries add constraint activity_entries_kind_check
    check (kind in ('scan', 'intent'))`.execute(db);
  await sql`alter table platform.agent_tasks drop constraint agent_tasks_kind_check`.execute(db);
  await sql`alter table platform.agent_tasks add constraint agent_tasks_kind_check
    check (kind in ('noop', 'scan', 'chain_check'))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from platform.agent_tasks where kind = 'chain_check'`.execute(db);
  await sql`alter table platform.agent_tasks drop constraint agent_tasks_kind_check`.execute(db);
  await sql`alter table platform.agent_tasks add constraint agent_tasks_kind_check
    check (kind in ('noop', 'scan'))`.execute(db);
  await sql`delete from platform.activity_entries where kind = 'intent'`.execute(db);
  await sql`alter table platform.activity_entries drop constraint activity_entries_kind_check`.execute(
    db,
  );
  await sql`alter table platform.activity_entries add constraint activity_entries_kind_check
    check (kind in ('scan'))`.execute(db);
  await sql`delete from platform.tool_calls where server = 'chain'`.execute(db);
  await sql`alter table platform.tool_calls drop constraint tool_calls_server_check`.execute(db);
  await sql`alter table platform.tool_calls add constraint tool_calls_server_check
    check (server in ('data', 'platform'))`.execute(db);
  await db.schema.withSchema("platform").dropTable("intents").execute();
}
