import { type Kysely, sql } from "kysely";

/**
 * SK-U1: an owner's own skills, uploaded for one agent. One row per package
 * version by content hash: the manifest, every file's text, the version, the
 * hashes, the findings that did not block (warnings), who uploaded it and
 * when. The current rows of an agent are mounted read-only beside the
 * built-in skills at its next sandbox; a removed row stays as history with
 * `removed_at`. Never served to anyone but the agent's owner.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .createTable("owner_skills")
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("skill_id", "text", (c) => c.notNull())
    .addColumn("content_hash", "text", (c) => c.notNull())
    .addColumn("version", "text", (c) => c.notNull())
    .addColumn("manifest_hash", "text", (c) => c.notNull())
    .addColumn("hermes_name", "text", (c) => c.notNull())
    .addColumn("manifest", "jsonb", (c) => c.notNull())
    .addColumn("files", "jsonb", (c) => c.notNull())
    .addColumn("warnings", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("current", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("uploaded_by", "text", (c) => c.notNull())
    .addColumn("uploaded_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("removed_at", "timestamptz")
    .addPrimaryKeyConstraint("owner_skills_pk", [
      "chain_id",
      "agent_id",
      "skill_id",
      "content_hash",
    ])
    .execute();
  await db.schema
    .withSchema("platform")
    .createIndex("owner_skills_current")
    .on("owner_skills")
    .columns(["chain_id", "agent_id", "current"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("platform").dropTable("owner_skills").execute();
}
