import { type Kysely, sql } from "kysely";

/**
 * P2-U5 step 0 (D-261): refunds and credit settlements go through the
 * signer's outbox, so every platform transaction shares one nonce writer and
 * the "unknown is not failed" rule.
 * - `platform.signer_outbox.kind` also allows `usdc_refund` and `usdc_settlement`.
 * - `platform.refunds.signer_tx_id` names the outbox row carrying a refund;
 *   null for a refund signed before this change, which keeps its own raw transaction.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table platform.signer_outbox drop constraint signer_outbox_kind_check`.execute(
    db,
  );
  await sql`alter table platform.signer_outbox add constraint signer_outbox_kind_check
    check (kind in ('executor_swap', 'usdc_refund', 'usdc_settlement'))`.execute(db);
  await db.schema
    .withSchema("platform")
    .alterTable("refunds")
    .addColumn("signer_tx_id", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("platform").alterTable("refunds").dropColumn("signer_tx_id").execute();
  await sql`alter table platform.signer_outbox drop constraint signer_outbox_kind_check`.execute(
    db,
  );
  await sql`alter table platform.signer_outbox add constraint signer_outbox_kind_check
    check (kind in ('executor_swap'))`.execute(db);
}
