import { type Kysely, sql } from "kysely";

/**
 * P4-U2: the Risk Sentinel. Every action it took (the breach, the tightening
 * or the state it set, the reason, the transaction) and, per agent, the
 * conditions in force and the baselines it compares against.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .createTable("sentinel_actions")
    .addColumn("action_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("code", "text", (c) => c.notNull())
    .addColumn("action", "text", (c) => c.notNull())
    .addColumn("state", "text")
    .addColumn("reason", "text", (c) => c.notNull())
    .addColumn("detail", "jsonb", (c) => c.notNull())
    .addColumn("tx_hash", "text")
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .withSchema("platform")
    .createIndex("sentinel_actions_agent_created")
    .on("sentinel_actions")
    .columns(["chain_id", "agent_id", "created_at"])
    .execute();
  await db.schema
    .withSchema("platform")
    .createTable("sentinel_watch")
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("active", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("baseline", "jsonb")
    .addColumn("last_checked_at", "timestamptz")
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("sentinel_watch_pk", ["chain_id", "agent_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("platform").dropTable("sentinel_watch").execute();
  await db.schema.withSchema("platform").dropTable("sentinel_actions").execute();
}
