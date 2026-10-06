import { type Kysely, sql } from "kysely";

/**
 * P1-U9: owner-requested Scans (D-219).
 *
 * - `platform.agent_tasks.requested_by`: who asked for the task (the owner
 *   through the control API, the dev console, or the scheduler).
 * - One queued or running Scan per agent, whoever asks, by a partial unique
 *   index, so the control API and the orchestrator cannot both start one.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .alterTable("agent_tasks")
    .addColumn("requested_by", "text", (c) =>
      c.check(sql`requested_by in ('owner', 'console', 'schedule')`),
    )
    .execute();
  await sql`create unique index agent_tasks_one_open_scan on platform.agent_tasks (chain_id, agent_id) where kind = 'scan' and status in ('queued', 'running')`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists platform.agent_tasks_one_open_scan`.execute(db);
  await db.schema
    .withSchema("platform")
    .alterTable("agent_tasks")
    .dropColumn("requested_by")
    .execute();
}
