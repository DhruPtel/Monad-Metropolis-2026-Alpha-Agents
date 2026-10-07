import { Kysely, PostgresDialect, sql } from "kysely";
import { type Migration, Migrator } from "kysely/migration";
import pg from "pg";
import * as initial from "./migrations/0001_initial.ts";
import * as orchestrator from "./migrations/0002_orchestrator.ts";
import * as credits from "./migrations/0003_credits.ts";
import * as tools from "./migrations/0004_tools.ts";
import * as scanRequests from "./migrations/0005_scan_requests.ts";
import * as revealSteers from "./migrations/0006_reveal_steers.ts";
import * as refundShares from "./migrations/0007_refund_shares.ts";
import * as signer from "./migrations/0008_signer.ts";
import * as signerTransfers from "./migrations/0009_signer_transfers.ts";
import type { Database } from "./schema.ts";

export type * from "./schema.ts";
export { sql };
export { readContributionWeights } from "./contributions.ts";
export { type JournalRow, insertJournal } from "./journal.ts";
export type Db = Kysely<Database>;

/** Every migration, in order. A new one is added here and never edited once committed. */
export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  "0001_initial": initial,
  "0002_orchestrator": orchestrator,
  "0003_credits": credits,
  "0004_tools": tools,
  "0005_scan_requests": scanRequests,
  "0006_reveal_steers": revealSteers,
  "0007_refund_shares": refundShares,
  "0008_signer": signer,
  "0009_signer_transfers": signerTransfers,
};

const INT8 = 20;

/** int8 to a JS number, refusing anything that would lose precision. */
function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value ${value} is not a safe integer`);
  return n;
}

/**
 * A database client. int8 columns (block numbers, agent IDs, epochs) come back
 * as numbers; numeric columns (token amounts) stay strings. The URL is never
 * logged here or put in an error message.
 */
export function createDb(url: string, options: { max?: number } = {}): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    types: {
      getTypeParser: ((oid: number, format?: "text" | "binary") =>
        oid === INT8
          ? parseInt8
          : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
    },
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the migrator works on any schema
type AnyDb = Kysely<any>;

function migrator(db: AnyDb): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve({ ...MIGRATIONS }) },
  });
}

/** Applies every pending migration; throws with the failing migration's name. */
export async function migrateToLatest(db: AnyDb): Promise<string[]> {
  const { error, results } = await migrator(db).migrateToLatest();
  const failed = results?.find((r) => r.status === "Error");
  if (error || failed) {
    throw new Error(
      `migration ${failed?.migrationName ?? "run"} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return (results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}

/** Drops our schemas and the migration history, then migrates from scratch. Local only. */
export async function resetDatabase(db: AnyDb): Promise<string[]> {
  await sql`drop schema if exists indexer cascade`.execute(db);
  await sql`drop schema if exists platform cascade`.execute(db);
  await sql`drop table if exists public.kysely_migration`.execute(db);
  await sql`drop table if exists public.kysely_migration_lock`.execute(db);
  return migrateToLatest(db);
}

/** Lowercases an address for storage and lookups. */
export const dbAddress = (address: string): string => address.toLowerCase();
