import { type Kysely, sql } from "kysely";

/** F-U1: the token check, an agent task that lists tokens and screens one. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table platform.agent_tasks drop constraint agent_tasks_kind_check`.execute(db);
  await sql`alter table platform.agent_tasks add constraint agent_tasks_kind_check
    check (kind in ('noop', 'scan', 'chain_check', 'research_check', 'cycle', 'token_check'))`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from platform.agent_tasks where kind = 'token_check'`.execute(db);
  await sql`alter table platform.agent_tasks drop constraint agent_tasks_kind_check`.execute(db);
  await sql`alter table platform.agent_tasks add constraint agent_tasks_kind_check
    check (kind in ('noop', 'scan', 'chain_check', 'research_check', 'cycle'))`.execute(db);
}
