import { type Kysely, sql } from "kysely";

/**
 * P2-EC part 2 (D-252): the mainnet canary's session key is a raw throwaway
 * key from `.env`, never derived from a seed and never in KMS, so
 * `platform.signer_keys.provider` also allows `canary`. Only the canary's own
 * database (APP_ENV=canary, D-251) ever holds such a row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table platform.signer_keys drop constraint signer_keys_provider_check`.execute(
    db,
  );
  await sql`alter table platform.signer_keys add constraint signer_keys_provider_check
    check (provider in ('local', 'kms', 'canary'))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table platform.signer_keys drop constraint signer_keys_provider_check`.execute(
    db,
  );
  await sql`alter table platform.signer_keys add constraint signer_keys_provider_check
    check (provider in ('local', 'kms'))`.execute(db);
}
