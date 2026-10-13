import { type Kysely, sql } from "kysely";

/**
 * RP-U1: the research report of a cycle. One per cycle: its status (written,
 * skipped with why), the structured report as JSON, what the checks removed,
 * the model and what it cost against its ceiling.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .createTable("research_reports")
    .addColumn("cycle_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("reason", "text")
    .addColumn("body", "jsonb")
    .addColumn("checks", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("model", "text")
    .addColumn("request_id", "text")
    .addColumn("cost_usd", "double precision", (c) => c.notNull().defaultTo(0))
    .addColumn("charged_usdc_e6", "numeric", (c) => c.notNull().defaultTo(0))
    .addColumn("ceiling_usdc_e6", "numeric", (c) => c.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .withSchema("platform")
    .createIndex("research_reports_agent_created")
    .on("research_reports")
    .columns(["chain_id", "agent_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("platform").dropTable("research_reports").execute();
}
