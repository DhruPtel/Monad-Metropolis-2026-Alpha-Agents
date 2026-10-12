import { type Kysely, sql } from "kysely";

/**
 * Step 0 of the 2026-10-12 session (A-90): which of its accounts an agent
 * manages when it has a vault. One row per agent, written when the owner
 * turns automatic trading on and chooses the vault or the personal account;
 * without a row the vault is managed once it exists (A-87). Read by every
 * chain reader that resolves the agent's trading account.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .createTable("managed_accounts")
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("agent_id", "integer", (c) => c.notNull())
    .addColumn("account", "text", (c) => c.notNull().check(sql`account in ('personal', 'vault')`))
    .addColumn("chosen_by", "text", (c) => c.notNull())
    .addColumn("chosen_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("managed_accounts_pk", ["chain_id", "agent_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("platform").dropTable("managed_accounts").execute();
}
