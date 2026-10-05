import { randomBytes } from "node:crypto";
import { loadConfig, type Secret } from "@alpha-agents/config";
import pg from "pg";
import { type Db, createDb, migrateToLatest } from "./index.ts";

/**
 * A throwaway database for one test file: created on the configured Postgres
 * server under a random name, migrated, and dropped afterwards, so tests never
 * touch the development database (alpha_agents) or each other.
 */
export interface TestDatabase {
  readonly db: Db;
  readonly url: string;
  readonly name: string;
  drop(): Promise<void>;
}

/** The configured server's URL (DATABASE_URL, or the local container's default). */
export function serverUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const config = loadConfig({ name: "db tests", usesChain: false }, env);
  return (config.values.DATABASE_URL as Secret).reveal();
}

/** True when a Postgres server answers at the configured URL. */
export async function databaseAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: serverUrl(), connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function createTestDatabase(prefix = "test"): Promise<TestDatabase> {
  const base = new URL(serverUrl());
  const name = `alpha_agents_${prefix}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(base);
  url.pathname = `/${name}`;
  const db = createDb(url.toString(), { max: 4 });
  const drop = async () => {
    await db.destroy();
    const cleanup = new pg.Client({ connectionString: base.toString() });
    await cleanup.connect();
    try {
      await cleanup.query(`drop database if exists ${name} with (force)`);
    } finally {
      await cleanup.end();
    }
  };
  try {
    await migrateToLatest(db);
  } catch (err) {
    // Never leave a half-made database behind.
    await drop();
    throw err;
  }
  return { db, url: url.toString(), name, drop };
}
