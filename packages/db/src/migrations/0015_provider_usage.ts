import { type Kysely, sql } from "kysely";

/**
 * P3-U9: `platform.provider_usage`, each paid upstream's usage per UTC day in
 * its own unit (CoinMarketCap credits, X posts read, Dune requests), so the
 * platform's hard daily caps survive a restart of the orchestrator.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .createTable("provider_usage")
    .addColumn("provider", "text", (c) => c.notNull())
    .addColumn("day", "date", (c) => c.notNull())
    .addColumn("used", "bigint", (c) =>
      c
        .notNull()
        .defaultTo(0)
        .check(sql`used >= 0`),
    )
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("provider_usage_pk", ["provider", "day"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("platform").dropTable("provider_usage").execute();
}
