import { type Kysely, sql } from "kysely";

/**
 * P3-U9: `platform.agent_tasks.kind` gains `research_check`, the console task
 * in which a real agent uses each research source once (x_search, dune_query,
 * read_contract, balance, get_code).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table platform.agent_tasks drop constraint agent_tasks_kind_check`.execute(db);
  await sql`alter table platform.agent_tasks add constraint agent_tasks_kind_check
    check (kind in ('noop', 'scan', 'chain_check', 'research_check'))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from platform.agent_tasks where kind = 'research_check'`.execute(db);
  await sql`alter table platform.agent_tasks drop constraint agent_tasks_kind_check`.execute(db);
  await sql`alter table platform.agent_tasks add constraint agent_tasks_kind_check
    check (kind in ('noop', 'scan', 'chain_check'))`.execute(db);
}
