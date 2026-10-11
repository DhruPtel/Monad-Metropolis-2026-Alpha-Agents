import { type Kysely, sql } from "kysely";

/**
 * P3-U10: the autonomous loop. A review cycle kind (the Zoom out alone, for
 * the daily review and the triggers that need no Scan), a cycle's wish for a
 * fresh overview, the research schedule per agent (cadence, pause, what it
 * waits for, the watcher's baselines) and every trigger the watcher fired.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table platform.research_cycles drop constraint if exists research_cycles_kind_check`.execute(
    db,
  );
  await sql`alter table platform.research_cycles add constraint research_cycles_kind_check check (kind in ('ROUTINE', 'TRIGGERED', 'ACTIVATION', 'REVIEW'))`.execute(
    db,
  );
  await db.schema
    .withSchema("platform")
    .alterTable("research_cycles")
    .addColumn("wants_overview", "boolean", (c) => c.notNull().defaultTo(false))
    .execute();
  await db.schema
    .withSchema("platform")
    .createTable("research_schedules")
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("paused", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("fast_cadence", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("last_scan_at", "timestamptz")
    .addColumn("last_zoom_out_at", "timestamptz")
    .addColumn("last_overview_at", "timestamptz")
    .addColumn("last_trigger_cycle_at", "timestamptz")
    .addColumn("waiting_reason", "text")
    .addColumn("waiting_since", "timestamptz")
    .addColumn("next_due_at", "timestamptz")
    .addColumn("baseline", "jsonb")
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("research_schedules_pk", ["chain_id", "agent_id"])
    .execute();
  await db.schema
    .withSchema("platform")
    .createTable("research_triggers")
    .addColumn("trigger_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("code", "text", (c) => c.notNull())
    .addColumn("detail", "jsonb", (c) => c.notNull())
    .addColumn("fired_at", "timestamptz", (c) => c.notNull())
    .addColumn("cycle_id", "text")
    .addColumn("spaced", "boolean", (c) => c.notNull().defaultTo(false))
    .execute();
  await db.schema
    .withSchema("platform")
    .createIndex("research_triggers_agent_fired")
    .on("research_triggers")
    .columns(["chain_id", "agent_id", "fired_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("platform").dropTable("research_triggers").execute();
  await db.schema.withSchema("platform").dropTable("research_schedules").execute();
  await db.schema
    .withSchema("platform")
    .alterTable("research_cycles")
    .dropColumn("wants_overview")
    .execute();
  await sql`alter table platform.research_cycles drop constraint if exists research_cycles_kind_check`.execute(
    db,
  );
  await sql`alter table platform.research_cycles add constraint research_cycles_kind_check check (kind in ('ROUTINE', 'TRIGGERED', 'ACTIVATION'))`.execute(
    db,
  );
}
