import { type Kysely, sql } from "kysely";

/**
 * Step 0 of the P2-U1 session: steered reveals on the local fork (D-221)
 * persist in Postgres, so a restart of the orchestrator never clears them.
 *
 * - `platform.reveal_steers`: one row per "Reveal next as" choice, aimed at a
 *   wallet (its lowest unrevealed agent, or the next one it mints) or at one
 *   pending agent (with the owner recorded when it was chosen, so a fork reset
 *   that hands the same agent ID to another wallet cannot inherit it).
 * - At most one pending steer per target, by a partial unique index.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .createTable("reveal_steers")
    .addColumn("steer_id", "text", (c) => c.primaryKey())
    .addColumn("chain_id", "integer", (c) => c.notNull())
    .addColumn("target_kind", "text", (c) =>
      c.notNull().check(sql`target_kind in ('wallet', 'agent')`),
    )
    .addColumn("wallet", "text")
    .addColumn("agent_id", "bigint")
    /** For an agent target: its owner when the steer was chosen. */
    .addColumn("agent_owner", "text")
    .addColumn("species", "smallint", (c) => c.notNull().check(sql`species between 1 and 25`))
    .addColumn("status", "text", (c) =>
      c.notNull().check(sql`status in ('pending', 'applied', 'failed', 'cancelled')`),
    )
    .addColumn("applied_agent_id", "bigint")
    .addColumn("note", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("resolved_at", "timestamptz")
    .addCheckConstraint(
      "reveal_steers_target",
      sql`(target_kind = 'wallet' and wallet is not null and agent_id is null) or (target_kind = 'agent' and agent_id is not null and agent_owner is not null and wallet is null)`,
    )
    .execute();
  await sql`create unique index reveal_steers_one_pending on platform.reveal_steers (chain_id, target_kind, coalesce(wallet, ''), coalesce(agent_id, 0)) where status = 'pending'`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("platform").dropTable("reveal_steers").execute();
}
