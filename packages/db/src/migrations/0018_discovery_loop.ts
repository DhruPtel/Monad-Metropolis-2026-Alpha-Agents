import { type Kysely, sql } from "kysely";

/**
 * P3-U4: the discovery loop engine.
 *
 * - `platform.research_cycles`: one research cycle (ROUTINE, TRIGGERED or
 *   ACTIVATION) for an agent: its task, its one lease, the reasoning model it
 *   ran with, its status and stop reason, and its cost.
 * - `platform.stage_runs`: each stage of a cycle in order (SCAN, DIVE,
 *   CHALLENGE, TEST, ZOOM_OUT), with its model alias, caps, ceiling, the run
 *   it started, how it ended, its token and cache counts, and its charge and
 *   the excess the platform absorbed. The idempotency key is
 *   `<agent>:<cycle>:<stage>[:<n>]`.
 * - `platform.model_calls`: every model call the gate forwarded under a stage,
 *   with LiteLLM's request ID, tokens, cache reads and writes and LiteLLM's
 *   cost; metering finds a call's stage here to hold its charge to the ceiling.
 * - `platform.research_briefs`: the typed briefs agents write, accepted or
 *   refused with the validator's reasons; only accepted ones are shown.
 * - `platform.tool_results`: what each tool call of a cycle returned, bounded
 *   and platform-only, so a brief's numbers and URLs can be checked.
 * - Leases gain the stage run they are running; tool calls, stage records and
 *   thesis notes gain their stage run; stage records gain a Zoom out's
 *   decision; a stage record is once per stage run (once per lease and stage
 *   for records outside a cycle, as before).
 * - Usage receipts gain the stage run and the absorbed excess; a receipt for
 *   a call wholly above its ceiling has no ledger entry.
 * - Tasks gain `cycle`; activity entries gain `stage`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const pf = db.schema.withSchema("platform");

  await pf
    .createTable("research_cycles")
    .addColumn("cycle_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("task_id", "text", (c) => c.notNull().unique())
    .addColumn("kind", "text", (c) =>
      c.notNull().check(sql`kind in ('ROUTINE', 'TRIGGERED', 'ACTIVATION')`),
    )
    .addColumn("status", "text", (c) =>
      c.notNull().check(sql`status in ('queued', 'running', 'completed', 'stopped', 'failed')`),
    )
    .addColumn("stop_reason", "text")
    .addColumn("reasoning_alias", "text", (c) => c.notNull())
    .addColumn("lease_id", "text")
    .addColumn("canary", "text", (c) => c.notNull())
    .addColumn("charged_usdc_e6", "numeric(78, 0)", (c) => c.notNull().defaultTo(0))
    .addColumn("absorbed_usdc_e6", "numeric(78, 0)", (c) => c.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("started_at", "timestamptz")
    .addColumn("finished_at", "timestamptz")
    .execute();
  await pf
    .createIndex("research_cycles_agent")
    .on("research_cycles")
    .columns(["chain_id", "agent_id", "created_at"])
    .execute();

  await pf
    .createTable("stage_runs")
    .addColumn("stage_run_id", "text", (c) => c.primaryKey())
    .addColumn("cycle_id", "text", (c) =>
      c.notNull().references("platform.research_cycles.cycle_id"),
    )
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("seq", "integer", (c) => c.notNull())
    .addColumn("stage", "text", (c) =>
      c.notNull().check(sql`stage in ('SCAN', 'DIVE', 'CHALLENGE', 'TEST', 'ZOOM_OUT')`),
    )
    .addColumn("theme_code", "text")
    .addColumn("idempotency_key", "text", (c) => c.notNull().unique())
    .addColumn("model_alias", "text")
    .addColumn("caps", "jsonb", (c) => c.notNull())
    .addColumn("ceiling_usdc_e6", "numeric(78, 0)", (c) => c.notNull().defaultTo(0))
    .addColumn("status", "text", (c) =>
      c
        .notNull()
        .check(
          sql`status in ('pending', 'running', 'completed', 'capped', 'stopped', 'failed', 'skipped')`,
        ),
    )
    .addColumn("stop_reason", "text")
    .addColumn("run_id", "text")
    .addColumn("session_id", "text")
    .addColumn("outcome", "jsonb")
    .addColumn("model_calls", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("input_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("output_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("cache_read_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("cache_write_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("charged_usdc_e6", "numeric(78, 0)", (c) => c.notNull().defaultTo(0))
    .addColumn("absorbed_usdc_e6", "numeric(78, 0)", (c) => c.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("started_at", "timestamptz")
    .addColumn("finished_at", "timestamptz")
    .addUniqueConstraint("stage_runs_seq", ["cycle_id", "seq"])
    .execute();
  await pf
    .createIndex("stage_runs_agent")
    .on("stage_runs")
    .columns(["chain_id", "agent_id", "created_at"])
    .execute();

  await pf
    .createTable("model_calls")
    .addColumn("request_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("lease_id", "text", (c) => c.notNull())
    .addColumn("stage_run_id", "text")
    .addColumn("model", "text", (c) => c.notNull())
    .addColumn("status", "integer", (c) => c.notNull())
    .addColumn("input_tokens", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("output_tokens", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("cache_read_tokens", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("cache_write_tokens", "integer", (c) => c.notNull().defaultTo(0))
    /** LiteLLM's cost of the call in USD, as its stream reported it. */
    .addColumn("cost_usd", "double precision", (c) => c.notNull().defaultTo(0))
    .addColumn("at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await pf.createIndex("model_calls_stage").on("model_calls").column("stage_run_id").execute();

  await pf
    .createTable("research_briefs")
    .addColumn("brief_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("cycle_id", "text", (c) => c.notNull())
    .addColumn("stage_run_id", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) =>
      c.notNull().check(sql`kind in ('SCAN', 'THEME', 'CHALLENGE', 'OVERVIEW', 'RATIONALE')`),
    )
    .addColumn("status", "text", (c) => c.notNull().check(sql`status in ('accepted', 'refused')`))
    .addColumn("body", "jsonb", (c) => c.notNull())
    .addColumn("reasons", "jsonb", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await pf
    .createIndex("research_briefs_agent")
    .on("research_briefs")
    .columns(["chain_id", "agent_id", "created_at"])
    .execute();
  await pf.createIndex("research_briefs_cycle").on("research_briefs").column("cycle_id").execute();

  await pf
    .createTable("tool_results")
    .addColumn("call_id", "text", (c) => c.primaryKey())
    .addColumn("cycle_id", "text", (c) => c.notNull())
    .addColumn("stage_run_id", "text", (c) => c.notNull())
    .addColumn("tool", "text", (c) => c.notNull())
    .addColumn("result", "jsonb", (c) => c.notNull())
    .addColumn("truncated", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await pf.createIndex("tool_results_cycle").on("tool_results").column("cycle_id").execute();

  await pf.alterTable("sandbox_leases").addColumn("stage_run_id", "text").execute();
  await pf.alterTable("tool_calls").addColumn("stage_run_id", "text").execute();
  await pf.createIndex("tool_calls_stage").on("tool_calls").column("stage_run_id").execute();
  await pf.alterTable("thesis_notes").addColumn("stage_run_id", "text").execute();
  await pf.alterTable("stage_records").addColumn("stage_run_id", "text").execute();
  await pf.alterTable("stage_records").addColumn("decision", "jsonb").execute();
  await sql`alter table platform.stage_records drop constraint stage_records_once`.execute(db);
  await sql`create unique index stage_records_once on platform.stage_records (lease_id, stage) where stage_run_id is null`.execute(
    db,
  );
  await sql`create unique index stage_records_once_per_run on platform.stage_records (stage_run_id) where stage_run_id is not null`.execute(
    db,
  );
  await pf.alterTable("usage_receipts").addColumn("stage_run_id", "text").execute();
  await pf
    .alterTable("usage_receipts")
    .addColumn("absorbed_usdc_e6", "numeric(78, 0)", (c) => c.notNull().defaultTo(0))
    .execute();
  // A call wholly above its stage's ceiling charges nothing, so its receipt has no ledger entry.
  await sql`alter table platform.usage_receipts alter column entry_id drop not null`.execute(db);

  await sql`alter table platform.agent_tasks drop constraint agent_tasks_kind_check`.execute(db);
  await sql`alter table platform.agent_tasks add constraint agent_tasks_kind_check
    check (kind in ('noop', 'scan', 'chain_check', 'research_check', 'cycle'))`.execute(db);
  await sql`alter table platform.activity_entries drop constraint activity_entries_kind_check`.execute(
    db,
  );
  await sql`alter table platform.activity_entries add constraint activity_entries_kind_check
    check (kind in ('scan', 'intent', 'arming', 'trade', 'blocked', 'runner', 'stage'))`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from platform.activity_entries where kind = 'stage'`.execute(db);
  await sql`alter table platform.activity_entries drop constraint activity_entries_kind_check`.execute(
    db,
  );
  await sql`alter table platform.activity_entries add constraint activity_entries_kind_check
    check (kind in ('scan', 'intent', 'arming', 'trade', 'blocked', 'runner'))`.execute(db);
  await sql`delete from platform.agent_tasks where kind = 'cycle'`.execute(db);
  await sql`alter table platform.agent_tasks drop constraint agent_tasks_kind_check`.execute(db);
  await sql`alter table platform.agent_tasks add constraint agent_tasks_kind_check
    check (kind in ('noop', 'scan', 'chain_check', 'research_check'))`.execute(db);
  const pf = db.schema.withSchema("platform");
  await sql`delete from platform.usage_receipts where entry_id is null`.execute(db);
  await sql`alter table platform.usage_receipts alter column entry_id set not null`.execute(db);
  await pf.alterTable("usage_receipts").dropColumn("absorbed_usdc_e6").execute();
  await pf.alterTable("usage_receipts").dropColumn("stage_run_id").execute();
  await sql`delete from platform.stage_records where stage_run_id is not null`.execute(db);
  await sql`drop index platform.stage_records_once_per_run`.execute(db);
  await sql`drop index platform.stage_records_once`.execute(db);
  await sql`alter table platform.stage_records add constraint stage_records_once unique (lease_id, stage)`.execute(
    db,
  );
  await pf.alterTable("stage_records").dropColumn("decision").execute();
  await pf.alterTable("stage_records").dropColumn("stage_run_id").execute();
  await pf.alterTable("thesis_notes").dropColumn("stage_run_id").execute();
  await pf.dropIndex("tool_calls_stage").ifExists().execute();
  await pf.alterTable("tool_calls").dropColumn("stage_run_id").execute();
  await pf.alterTable("sandbox_leases").dropColumn("stage_run_id").execute();
  await pf.dropTable("tool_results").ifExists().execute();
  await pf.dropTable("research_briefs").ifExists().execute();
  await pf.dropTable("model_calls").ifExists().execute();
  await pf.dropTable("stage_runs").ifExists().execute();
  await pf.dropTable("research_cycles").ifExists().execute();
}
