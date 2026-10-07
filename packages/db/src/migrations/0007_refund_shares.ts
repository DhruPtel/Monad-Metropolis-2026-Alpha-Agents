import type { Kysely } from "kysely";

/**
 * P2-U4 step 0 (D-242): a refund pays only the requester's own share of the
 * agent's credits. Each refund records the contributions it consumed (its
 * basis), so later shares are computed on what is left and no other
 * contributor's share changes. Null for a refund signed before this rule.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .alterTable("refunds")
    .addColumn("contribution_basis_usdc_e6", "numeric(78, 0)")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("platform")
    .alterTable("refunds")
    .dropColumn("contribution_basis_usdc_e6")
    .execute();
}
