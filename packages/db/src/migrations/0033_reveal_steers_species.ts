import { type Kysely, sql } from "kysely";

/**
 * NFT-U1: the species list grew from 25 to 34 (packages/domain SPECIES), so a
 * steered reveal may name any of the 34. The check from 0006 named 25; a
 * later growth of the list replaces this check the same way, since a
 * migration never floats with the list.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table platform.reveal_steers drop constraint if exists reveal_steers_species_check`.execute(
    db,
  );
  await sql`alter table platform.reveal_steers add constraint reveal_steers_species_check check (species between 1 and 34)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table platform.reveal_steers drop constraint if exists reveal_steers_species_check`.execute(
    db,
  );
  await sql`alter table platform.reveal_steers add constraint reveal_steers_species_check check (species between 1 and 25)`.execute(
    db,
  );
}
