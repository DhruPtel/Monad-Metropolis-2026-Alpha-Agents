import { type Kysely, sql } from "kysely";

/**
 * BK-U1: an owner's own keys for paid data sources, one sealed row per agent
 * and source (AES-256-GCM under the platform's secret; the key itself is
 * never stored), with the last characters the owner sees it by; and which
 * key paid for each tool call, so owner-paid calls are metered apart from
 * the platform's.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .createTable("owner_keys")
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("provider", "text", (c) => c.notNull().check(sql`provider in ('dune')`))
    .addColumn("ciphertext", "text", (c) => c.notNull())
    .addColumn("key_hint", "text", (c) => c.notNull())
    .addColumn("added_by", "text", (c) => c.notNull())
    .addColumn("added_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("owner_keys_pk", ["chain_id", "agent_id", "provider"])
    .execute();
  await db.schema
    .withSchema("platform")
    .alterTable("tool_calls")
    .addColumn("paid_by", "text", (c) =>
      c
        .notNull()
        .defaultTo("platform")
        .check(sql`paid_by in ('platform', 'owner')`),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("platform").alterTable("tool_calls").dropColumn("paid_by").execute();
  await db.schema.withSchema("platform").dropTable("owner_keys").execute();
}
