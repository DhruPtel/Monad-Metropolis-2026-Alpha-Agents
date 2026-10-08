import { type Kysely, sql } from "kysely";

/**
 * P2-U6: the trade flow.
 * - `platform.intents`: the states gain `confirmed` and `reconciled` in place
 *   of `settled`; the columns record who approved an intent and when, what was
 *   sent (minimum output, deadline, action ID, the outbox row) and every
 *   blocker as its own column, so "why the agent did not trade" reads one place.
 * - `platform.arming`: each arming of an agent by its owner, from the session
 *   grant to the end (expiry, sale, configuration change, revoked grant or
 *   disarm); at most one open arming per agent.
 * - `platform.activity_entries.kind` gains `arming`, `trade` and `blocked`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table platform.intents drop constraint intents_status_check`.execute(db);
  await sql`update platform.intents set status = 'reconciled' where status = 'settled'`.execute(db);
  await sql`alter table platform.intents add constraint intents_status_check check (status in
    ('awaiting_approval', 'approved', 'submitted', 'confirmed', 'reconciled', 'rejected', 'expired', 'failed', 'cancelled'))`.execute(
    db,
  );
  await db.schema
    .withSchema("platform")
    .alterTable("intents")
    .addColumn("blockers", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("approved_by", "text", (c) => c.check(sql`approved_by in ('owner', 'auto')`))
    .addColumn("approved_at", "timestamptz")
    .addColumn("submitted_at", "timestamptz")
    .addColumn("settled_at", "timestamptz")
    .addColumn("min_amount_out", "numeric(78, 0)")
    .addColumn("deadline", "bigint")
    .addColumn("action_id", "text")
    .addColumn("amount_out", "numeric(78, 0)")
    .addColumn("failure", "text")
    .execute();
  await sql`update platform.intents set blockers = coalesce(checks->'blockers', '[]'::jsonb)`.execute(
    db,
  );

  await db.schema
    .withSchema("platform")
    .createTable("arming")
    .addColumn("arming_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    .addColumn("owner", "text", (c) => c.notNull())
    .addColumn("owner_epoch", "bigint", (c) => c.notNull())
    .addColumn("config_epoch", "bigint", (c) => c.notNull())
    .addColumn("session_key", "text", (c) => c.notNull())
    .addColumn("valid_until", "bigint", (c) => c.notNull())
    .addColumn("status", "text", (c) =>
      c.notNull().check(sql`status in ('awaiting_first_trade', 'armed', 'ended')`),
    )
    .addColumn("ended_reason", "text", (c) =>
      c.check(sql`ended_reason in ('expired', 'sold', 'config_changed', 'revoked', 'disarmed')`),
    )
    .addColumn("first_intent_id", "text")
    .addColumn("revoked_onchain", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("reminded_at", "timestamptz")
    .addColumn("armed_at", "timestamptz")
    .addColumn("ended_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`create unique index arming_one_open on platform.arming (chain_id, agent_id)
    where status in ('awaiting_first_trade', 'armed')`.execute(db);

  await sql`alter table platform.activity_entries drop constraint activity_entries_kind_check`.execute(
    db,
  );
  await sql`alter table platform.activity_entries add constraint activity_entries_kind_check
    check (kind in ('scan', 'intent', 'arming', 'trade', 'blocked'))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from platform.activity_entries where kind in ('arming', 'trade', 'blocked')`.execute(
    db,
  );
  await sql`alter table platform.activity_entries drop constraint activity_entries_kind_check`.execute(
    db,
  );
  await sql`alter table platform.activity_entries add constraint activity_entries_kind_check
    check (kind in ('scan', 'intent'))`.execute(db);
  await db.schema.withSchema("platform").dropTable("arming").execute();
  await db.schema
    .withSchema("platform")
    .alterTable("intents")
    .dropColumn("blockers")
    .dropColumn("approved_by")
    .dropColumn("approved_at")
    .dropColumn("submitted_at")
    .dropColumn("settled_at")
    .dropColumn("min_amount_out")
    .dropColumn("deadline")
    .dropColumn("action_id")
    .dropColumn("amount_out")
    .dropColumn("failure")
    .execute();
  await sql`alter table platform.intents drop constraint intents_status_check`.execute(db);
  await sql`update platform.intents set status = 'settled' where status in ('confirmed', 'reconciled')`.execute(
    db,
  );
  await sql`alter table platform.intents add constraint intents_status_check check (status in
    ('awaiting_approval', 'rejected', 'expired', 'approved', 'submitted', 'settled', 'failed', 'cancelled'))`.execute(
    db,
  );
}
