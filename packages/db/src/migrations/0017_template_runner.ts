import { type Kysely, sql } from "kysely";

/**
 * P3-U3: the template runner.
 *
 * - `platform.strategy_params`: every plan set for an agent (template,
 *   parameters, their hash, the strategy epoch it was set at and who set it),
 *   one active per agent, recorded by hash until BuildRegistry exists.
 * - `platform.runner_decisions`: the runner's decisions per agent, a new row
 *   only when the outcome or its reason changes; an unchanged decision moves
 *   the row's `last_at` and `ticks`, so the table does not grow every minute.
 * - `platform.intents.source`: who proposed an intent, the agent through
 *   `propose_swap` or the template runner (D-290).
 * - `platform.activity_entries.kind` gains `runner`: the narrator's entries
 *   for the runner's legs and notable holds.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .createTable("strategy_params")
    .addColumn("param_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("template", "text", (c) => c.notNull())
    .addColumn("params", "jsonb", (c) => c.notNull())
    .addColumn("params_hash", "text", (c) => c.notNull())
    .addColumn("strategy_epoch", "bigint", (c) => c.notNull())
    .addColumn("set_by", "text", (c) =>
      c.notNull().check(sql`set_by in ('owner', 'console', 'agent', 'activation')`),
    )
    .addColumn("set_by_address", "text")
    .addColumn("active", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("superseded_at", "timestamptz")
    .execute();
  await sql`create unique index strategy_params_one_active on platform.strategy_params (chain_id, agent_id) where active`.execute(
    db,
  );

  await db.schema
    .withSchema("platform")
    .createTable("runner_decisions")
    .addColumn("decision_id", "bigserial", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("param_id", "text")
    .addColumn("strategy_epoch", "bigint", (c) => c.notNull())
    .addColumn("outcome", "text", (c) => c.notNull().check(sql`outcome in ('hold', 'leg')`))
    .addColumn("code", "text", (c) => c.notNull())
    .addColumn("codes", "jsonb", (c) => c.notNull())
    .addColumn("leg", "jsonb")
    .addColumn("intent_id", "text")
    .addColumn("facts", "jsonb", (c) => c.notNull())
    .addColumn("block", "bigint")
    .addColumn("first_at", "timestamptz", (c) => c.notNull())
    .addColumn("last_at", "timestamptz", (c) => c.notNull())
    .addColumn("ticks", "integer", (c) => c.notNull().defaultTo(1))
    .execute();
  await db.schema
    .withSchema("platform")
    .createIndex("runner_decisions_by_agent")
    .on("runner_decisions")
    .columns(["chain_id", "agent_id", "decision_id"])
    .execute();

  await db.schema
    .withSchema("platform")
    .alterTable("intents")
    .addColumn("source", "text", (c) =>
      c
        .notNull()
        .defaultTo("agent")
        .check(sql`source in ('agent', 'template')`),
    )
    .execute();

  await sql`alter table platform.activity_entries drop constraint activity_entries_kind_check`.execute(
    db,
  );
  await sql`alter table platform.activity_entries add constraint activity_entries_kind_check
    check (kind in ('scan', 'intent', 'arming', 'trade', 'blocked', 'runner'))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from platform.activity_entries where kind = 'runner'`.execute(db);
  await sql`alter table platform.activity_entries drop constraint activity_entries_kind_check`.execute(
    db,
  );
  await sql`alter table platform.activity_entries add constraint activity_entries_kind_check
    check (kind in ('scan', 'intent', 'arming', 'trade', 'blocked'))`.execute(db);
  await db.schema.withSchema("platform").alterTable("intents").dropColumn("source").execute();
  await db.schema.withSchema("platform").dropTable("runner_decisions").execute();
  await db.schema.withSchema("platform").dropTable("strategy_params").execute();
}
