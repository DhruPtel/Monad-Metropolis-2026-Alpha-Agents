import { type Kysely, sql } from "kysely";

/**
 * UI-U2: the replay tool. A stored research stage can be run again on the
 * exact inputs it saw, with an edited playbook or owner skill, so the owner
 * iterates on the agent's behaviour quickly and pays the model call alone.
 * - `research_cycles.kind` takes REPLAY; `replay_of` names the stage run
 *   replayed and `replay_overrides` the edited text (the playbook's or an
 *   owner skill's files) the replay's sandbox mounts instead.
 * - `stage_runs.prompt`: the stage's prompt as sent, stored from now on, so a
 *   replay sends the same words; a stage without one cannot be replayed.
 * - `research_cycles.soul`: the SOUL.md the cycle's sandbox was given, so a
 *   replay's sandbox gets the same text (its own marker swapped in).
 * - `platform.playbook_overrides`: an edited built-in playbook the owner saved
 *   as a new version for one agent; the sandbox mounts the latest version's
 *   text in place of the built-in SKILL.md from then on.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table platform.research_cycles drop constraint if exists research_cycles_kind_check`.execute(
    db,
  );
  await sql`alter table platform.research_cycles add constraint research_cycles_kind_check check (kind in ('ROUTINE', 'TRIGGERED', 'ACTIVATION', 'REVIEW', 'REPLAY'))`.execute(
    db,
  );
  await db.schema
    .withSchema("platform")
    .alterTable("research_cycles")
    .addColumn("replay_of", "text")
    .execute();
  await db.schema
    .withSchema("platform")
    .alterTable("research_cycles")
    .addColumn("replay_overrides", "jsonb")
    .execute();
  await db.schema
    .withSchema("platform")
    .alterTable("research_cycles")
    .addColumn("soul", "text")
    .execute();
  await db.schema
    .withSchema("platform")
    .alterTable("stage_runs")
    .addColumn("prompt", "text")
    .execute();
  await db.schema
    .withSchema("platform")
    .createTable("playbook_overrides")
    .addColumn("override_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "bigint", (c) => c.notNull())
    /** The playbook's name in the sandbox, for example aa-playbook-scan. */
    .addColumn("hermes_name", "text", (c) => c.notNull())
    .addColumn("version", "integer", (c) => c.notNull())
    /** The SKILL.md body as the owner saved it; the frontmatter stays generated. */
    .addColumn("skill_md", "text", (c) => c.notNull())
    .addColumn("content_hash", "text", (c) => c.notNull())
    /** The replay cycle it was saved from, when one. */
    .addColumn("saved_from", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("playbook_overrides_version", [
      "chain_id",
      "agent_id",
      "hermes_name",
      "version",
    ])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("platform").dropTable("playbook_overrides").execute();
  await db.schema.withSchema("platform").alterTable("stage_runs").dropColumn("prompt").execute();
  await db.schema.withSchema("platform").alterTable("research_cycles").dropColumn("soul").execute();
  await db.schema
    .withSchema("platform")
    .alterTable("research_cycles")
    .dropColumn("replay_overrides")
    .execute();
  await sql`delete from platform.research_cycles where kind = 'REPLAY'`.execute(db);
  await db.schema
    .withSchema("platform")
    .alterTable("research_cycles")
    .dropColumn("replay_of")
    .execute();
  await sql`alter table platform.research_cycles drop constraint if exists research_cycles_kind_check`.execute(
    db,
  );
  await sql`alter table platform.research_cycles add constraint research_cycles_kind_check check (kind in ('ROUTINE', 'TRIGGERED', 'ACTIVATION', 'REVIEW'))`.execute(
    db,
  );
}
