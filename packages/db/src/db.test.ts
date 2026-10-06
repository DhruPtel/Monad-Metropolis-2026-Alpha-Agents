import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS, migrateToLatest, resetDatabase } from "./index.ts";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "./testing.ts";

const available = await databaseAvailable();

describe.skipIf(!available)("database migrations (needs pnpm dev:up)", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase("db");
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("creates every table in the indexer and platform schemas", async () => {
    const { rows } = await sql<{ name: string }>`
      select table_schema || '.' || table_name as name from information_schema.tables
      where table_schema in ('indexer', 'platform') order by 1`.execute(t.db);
    expect(rows.map((r) => r.name)).toEqual([
      "indexer.agent_nft_events",
      "indexer.agents",
      "indexer.incidents",
      "indexer.indexed_blocks",
      "indexer.usdc_transfers",
      "indexer.watermarks",
      "platform.agent_runtimes",
      "platform.agent_tasks",
      "platform.mint_allowlist",
      "platform.mint_claims",
      "platform.sandbox_leases",
    ]);
  });

  it("is idempotent: a second run applies nothing", async () => {
    expect(await migrateToLatest(t.db)).toEqual([]);
  });

  it("reads int8 as numbers and numeric as strings", async () => {
    await t.db
      .insertInto("indexer.watermarks")
      .values({ chain_id: 1, source: "x", block_number: 109_670_005, block_hash: "0xab" })
      .execute();
    const row = await t.db
      .selectFrom("indexer.watermarks")
      .select("block_number")
      .executeTakeFirstOrThrow();
    expect(row.block_number).toBe(109_670_005);
    const { rows } = await sql<{
      v: string;
    }>`select 123456789012345678901234567890::numeric(78,0) as v`.execute(t.db);
    expect(rows[0]?.v).toBe("123456789012345678901234567890");
  });

  it("rejects a malformed allowlist address", async () => {
    await expect(
      t.db.insertInto("platform.mint_allowlist").values({ wallet: "0xABC", note: null }).execute(),
    ).rejects.toThrow();
  });

  it("allows one active sandbox lease per agent, and any number of ended ones", async () => {
    const lease = (id: string, status: "active" | "ended") => ({
      lease_id: id,
      chain_id: 1,
      agent_id: 7,
      run_tag: "r",
      namespace: "test",
      purpose: "noop",
      gate_token_hash: id,
      status,
      expires_at: new Date(Date.now() + 60_000),
    });
    const insert = (id: string, status: "active" | "ended") =>
      t.db.insertInto("platform.sandbox_leases").values(lease(id, status)).execute();
    await insert("a", "active");
    await expect(insert("b", "active")).rejects.toThrow(/sandbox_leases_one_active/);
    await insert("c", "ended");
    await insert("d", "ended");
  });

  it("reset drops everything and migrates again", async () => {
    expect(await resetDatabase(t.db)).toEqual(Object.keys(MIGRATIONS));
    const count = await t.db
      .selectFrom("indexer.watermarks")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(0);
  });
});
