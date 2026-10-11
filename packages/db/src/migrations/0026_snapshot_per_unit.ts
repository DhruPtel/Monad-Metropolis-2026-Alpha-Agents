import type { Kysely } from "kysely";

/**
 * F-U11: the value per unit on every account snapshot, from the custody
 * core's `breakerState` (the account's value divided by its units; a deposit
 * mints units and a withdrawal burns them at the going value per unit, so
 * neither moves it). The portfolio window charts performance and scores the
 * agent on this basis, never on the account's value. Null for snapshots
 * taken before this column, and while the price the breaker needs is unusable.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .alterTable("account_snapshots")
    .addColumn("per_unit_e18", "numeric")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .alterTable("account_snapshots")
    .dropColumn("per_unit_e18")
    .execute();
}
