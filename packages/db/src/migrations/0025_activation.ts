import { type Kysely, sql } from "kysely";

/**
 * F-U10: the activation sweep. Turning on automatic trading records one
 * activation per attempt: the arming it belongs to, the ACTIVATION cycle that
 * runs the sweep and its task, the goal's tier and the sweep's ceiling shown
 * before it started, the facts of the deterministic first step (the goal and
 * the account) and of the third (pools and prices). Everything else the owner
 * watches (the steps' states, costs and results, the plan at the end) is read
 * from the cycle's stage runs and the plan proposal, so nothing is counted
 * twice. The narrator's entries gain the `activation` kind.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .createTable("activations")
    .addColumn("activation_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("arming_id", "text")
    .addColumn("cycle_id", "text")
    .addColumn("task_id", "text")
    .addColumn("reasoning_alias", "text", (c) => c.notNull())
    .addColumn("tier", "text", (c) => c.notNull().check(sql`tier in ('LOW', 'MEDIUM', 'HIGH')`))
    .addColumn("ceiling_usdc_e6", "numeric", (c) => c.notNull())
    .addColumn("checks", "jsonb", (c) => c.notNull())
    .addColumn("market", "jsonb")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .withSchema("platform")
    .createIndex("activations_agent")
    .on("activations")
    .columns(["chain_id", "agent_id", "created_at"])
    .execute();
  await db.schema
    .withSchema("platform")
    .createIndex("activations_cycle")
    .on("activations")
    .column("cycle_id")
    .execute();
  await sql`alter table platform.activity_entries drop constraint activity_entries_kind_check`.execute(
    db,
  );
  await sql`alter table platform.activity_entries add constraint activity_entries_kind_check
    check (kind in ('scan', 'intent', 'arming', 'trade', 'blocked', 'runner', 'stage', 'proposal', 'activation'))`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table platform.activity_entries drop constraint activity_entries_kind_check`.execute(
    db,
  );
  await sql`alter table platform.activity_entries add constraint activity_entries_kind_check
    check (kind in ('scan', 'intent', 'arming', 'trade', 'blocked', 'runner', 'stage', 'proposal'))`.execute(
    db,
  );
  await db.schema.withSchema("platform").dropTable("activations").execute();
}
