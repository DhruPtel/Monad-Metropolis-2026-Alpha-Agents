import { type Kysely, sql } from "kysely";

/**
 * P1-U7: tool servers, the Scan and the narrator (D-213 to D-217).
 *
 * - `platform.tool_calls`: the action log of every tool call, paid or not,
 *   bound to the agent and lease its token named, with the validated input,
 *   the outcome, the charge and its ledger entry.
 * - `platform.stage_records`: one `complete_stage` per stage per lease.
 * - `platform.thesis_notes`: the `write_thesis` stub's notes (D-160). Private
 *   research: never served to owners.
 * - `platform.activity_entries`: the narrator's owner-readable entries, one per
 *   task, with the facts record each was checked against.
 * - `platform.agent_tasks.kind` gains `scan`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const pf = db.schema.withSchema("platform");

  await pf
    .createTable("tool_calls")
    .addColumn("call_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    .addColumn("lease_id", "text", (c) => c.notNull())
    .addColumn("server", "text", (c) => c.notNull().check(sql`server in ('data', 'platform')`))
    .addColumn("tool", "text", (c) => c.notNull())
    .addColumn("input", "jsonb", (c) => c.notNull())
    .addColumn("status", "text", (c) =>
      c.notNull().check(sql`status in ('running', 'succeeded', 'failed', 'refused')`),
    )
    .addColumn("error_code", "text")
    .addColumn("charge_usdc_e6", "numeric(78, 0)", (c) => c.notNull().defaultTo(0))
    .addColumn("entry_id", "text")
    .addColumn("reversal_entry_id", "text")
    .addColumn("cache_hit", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("provider", "text")
    /** What came back, as counts and hosts only: never page text. */
    .addColumn("summary", "jsonb")
    .addColumn("started_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("finished_at", "timestamptz")
    .execute();
  await pf
    .createIndex("tool_calls_agent")
    .on("tool_calls")
    .columns(["chain_id", "agent_id", "started_at"])
    .execute();
  await pf.createIndex("tool_calls_lease").on("tool_calls").column("lease_id").execute();

  await pf
    .createTable("stage_records")
    .addColumn("stage_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    .addColumn("lease_id", "text", (c) => c.notNull())
    .addColumn("stage", "text", (c) => c.notNull())
    .addColumn("outcome", "text", (c) => c.notNull())
    .addColumn("candidates", "jsonb", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("stage_records_once", ["lease_id", "stage"])
    .execute();

  await pf
    .createTable("thesis_notes")
    .addColumn("note_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    .addColumn("lease_id", "text", (c) => c.notNull())
    .addColumn("stage", "text", (c) => c.notNull())
    .addColumn("title", "text", (c) => c.notNull())
    .addColumn("notes", "text", (c) => c.notNull())
    .addColumn("sources", "jsonb", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await pf.createIndex("thesis_notes_lease").on("thesis_notes").column("lease_id").execute();

  await pf
    .createTable("activity_entries")
    .addColumn("entry_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    .addColumn("task_id", "text", (c) => c.notNull().unique())
    .addColumn("kind", "text", (c) => c.notNull().check(sql`kind in ('scan')`))
    .addColumn("text", "text", (c) => c.notNull())
    .addColumn("rendered_by", "text", (c) =>
      c.notNull().check(sql`rendered_by in ('narrator', 'template')`),
    )
    /** The facts record the text was validated against. */
    .addColumn("facts", "jsonb", (c) => c.notNull())
    /** Why each rejected narration was rejected; the rejected text itself is not kept. */
    .addColumn("rejections", "jsonb", (c) => c.notNull())
    .addColumn("model", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await pf
    .createIndex("activity_entries_agent")
    .on("activity_entries")
    .columns(["chain_id", "agent_id", "created_at"])
    .execute();

  await sql`alter table platform.agent_tasks drop constraint agent_tasks_kind_check`.execute(db);
  await sql`alter table platform.agent_tasks add constraint agent_tasks_kind_check check (kind in ('noop', 'scan'))`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from platform.agent_tasks where kind = 'scan'`.execute(db);
  await sql`alter table platform.agent_tasks drop constraint agent_tasks_kind_check`.execute(db);
  await sql`alter table platform.agent_tasks add constraint agent_tasks_kind_check check (kind in ('noop'))`.execute(
    db,
  );
  const pf = db.schema.withSchema("platform");
  await pf.dropTable("activity_entries").ifExists().execute();
  await pf.dropTable("thesis_notes").ifExists().execute();
  await pf.dropTable("stage_records").ifExists().execute();
  await pf.dropTable("tool_calls").ifExists().execute();
}
