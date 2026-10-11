import { type Kysely, sql } from "kysely";

/**
 * F-U12: the universe a research cycle considered. One row per token the
 * cycle saw: its lane and whether this account could buy it (and why not),
 * whether a Dive researched it under which theme (and why a theme was or was
 * not chosen), and why the Zoom out saw it and did not propose it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .createTable("research_universe")
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("cycle_id", "text", (c) => c.notNull())
    .addColumn("token", "text", (c) => c.notNull())
    .addColumn("symbol", "text", (c) => c.notNull())
    .addColumn("price_class", "text", (c) => c.notNull())
    .addColumn("lane", "text")
    .addColumn("status", "text")
    .addColumn("buyable", "boolean", (c) => c.notNull())
    .addColumn("why_not", "text")
    .addColumn("held", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("theme_code", "text")
    .addColumn("theme_reason", "text")
    .addColumn("researched", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("proposed", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("dropped_reason", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("research_universe_pk", ["cycle_id", "token"])
    .execute();
  await db.schema
    .withSchema("platform")
    .createIndex("research_universe_agent_created")
    .on("research_universe")
    .columns(["chain_id", "agent_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("platform").dropTable("research_universe").execute();
}
