import { type Kysely, sql } from "kysely";

/**
 * BC-U1: an owner may bring their own key for X and CoinMarketCap beside Dune
 * (PAID_DATA_SOURCES in packages/domain), so the provider check of 0032 names
 * the three. A later source replaces this check the same way.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table platform.owner_keys drop constraint if exists owner_keys_provider_check`.execute(
    db,
  );
  await sql`alter table platform.owner_keys add constraint owner_keys_provider_check check (provider in ('dune', 'x', 'coinmarketcap'))`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from platform.owner_keys where provider <> 'dune'`.execute(db);
  await sql`alter table platform.owner_keys drop constraint if exists owner_keys_provider_check`.execute(
    db,
  );
  await sql`alter table platform.owner_keys add constraint owner_keys_provider_check check (provider in ('dune'))`.execute(
    db,
  );
}
