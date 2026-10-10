import { type Kysely, sql } from "kysely";

/**
 * F-U2 Step 0 (D-360): who first found each token. Background discovery is a
 * shared cache, not a list that limits agents: a token an agent looks up or
 * screens enters the registry for every agent, and `found_by` records that it
 * came from that agent's research (`agent:<id>`), the console, or discovery.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .alterTable("tokens")
    .addColumn("found_by", "text", (c) => c.notNull().defaultTo("discovery"))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table platform.tokens drop column found_by`.execute(db);
}
