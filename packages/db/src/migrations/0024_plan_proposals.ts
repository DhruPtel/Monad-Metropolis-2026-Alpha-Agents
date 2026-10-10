import { type Kysely, sql } from "kysely";

/**
 * F-U9: portfolio proposals and "why the plan did not change". A Zoom out's
 * draft becomes a stored proposal tied to the strategy epoch and the owner's
 * epoch, with each position's weight, thesis, exit plan and sources, the
 * skeptic's verdict, the evaluator's findings and the estimated cost to move
 * to it; a NO_CHANGE decision is stored with its reason code and explanation.
 * The narrator's entries gain the `proposal` kind.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .createTable("plan_proposals")
    .addColumn("proposal_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("cycle_id", "text")
    .addColumn("stage_run_id", "text")
    .addColumn("kind", "text", (c) => c.notNull().check(sql`kind in ('proposal', 'no_change')`))
    .addColumn("strategy_epoch", "bigint", (c) => c.notNull())
    .addColumn("owner_epoch", "bigint", (c) => c.notNull())
    .addColumn("template", "text")
    .addColumn("params", "jsonb")
    .addColumn("params_hash", "text")
    .addColumn("rationale", "jsonb", (c) => c.notNull())
    .addColumn("positions", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("evaluation", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("status", "text", (c) =>
      c
        .notNull()
        .check(
          sql`status in ('pending_owner', 'applied', 'rejected', 'declined', 'expired', 'recorded')`,
        ),
    )
    .addColumn("needs_approval", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("reason_code", "text")
    .addColumn("explanation", "text")
    .addColumn("decided_by", "text")
    .addColumn("decided_at", "timestamptz")
    .addColumn("plan_param_id", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz")
    .execute();
  await db.schema
    .withSchema("platform")
    .createIndex("plan_proposals_agent")
    .on("plan_proposals")
    .columns(["chain_id", "agent_id", "created_at"])
    .execute();
  await sql`alter table platform.activity_entries drop constraint activity_entries_kind_check`.execute(
    db,
  );
  await sql`alter table platform.activity_entries add constraint activity_entries_kind_check
    check (kind in ('scan', 'intent', 'arming', 'trade', 'blocked', 'runner', 'stage', 'proposal'))`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table platform.activity_entries drop constraint activity_entries_kind_check`.execute(
    db,
  );
  await sql`alter table platform.activity_entries add constraint activity_entries_kind_check
    check (kind in ('scan', 'intent', 'arming', 'trade', 'blocked', 'runner', 'stage'))`.execute(
    db,
  );
  await db.schema.withSchema("platform").dropTable("plan_proposals").execute();
}
