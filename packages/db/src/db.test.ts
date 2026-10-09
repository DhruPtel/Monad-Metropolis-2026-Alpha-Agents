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
      "platform.account_snapshots",
      "platform.activity_entries",
      "platform.agent_goals",
      "platform.agent_runtimes",
      "platform.agent_state_changes",
      "platform.agent_states",
      "platform.agent_tasks",
      "platform.arming",
      "platform.funding_addresses",
      "platform.intents",
      "platform.ledger_entries",
      "platform.ledger_lines",
      "platform.mint_allowlist",
      "platform.mint_claims",
      "platform.provider_usage",
      "platform.refunds",
      "platform.reveal_steers",
      "platform.sandbox_leases",
      "platform.signer_keys",
      "platform.signer_outbox",
      "platform.stage_records",
      "platform.thesis_notes",
      "platform.tool_calls",
      "platform.usage_receipts",
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

  it("keeps one stage record per stage per lease, and accepts scan tasks", async () => {
    const record = (id: string, lease: string) => ({
      stage_id: id,
      chain_id: 1,
      agent_id: 7,
      lease_id: lease,
      stage: "SCAN",
      outcome: "DONE",
      candidates: "[]",
    });
    await t.db.insertInto("platform.stage_records").values(record("s1", "L1")).execute();
    await expect(
      t.db.insertInto("platform.stage_records").values(record("s2", "L1")).execute(),
    ).rejects.toThrow(/stage_records_once/);
    await t.db.insertInto("platform.stage_records").values(record("s3", "L2")).execute();
    const task = (id: string, kind: string) =>
      t.db
        .insertInto("platform.agent_tasks")
        .values({ task_id: id, chain_id: 1, agent_id: 7, kind: kind as "scan", status: "queued" })
        .execute();
    await task("t-scan", "scan");
    await expect(task("t-other", "trade")).rejects.toThrow(/agent_tasks_kind_check/);
    // One queued or running Scan per agent (D-219); a finished one frees the slot.
    await expect(task("t-scan-2", "scan")).rejects.toThrow(/agent_tasks_one_open_scan/);
    await t.db
      .updateTable("platform.agent_tasks")
      .set({ status: "succeeded" })
      .where("task_id", "=", "t-scan")
      .execute();
    await task("t-scan-2", "scan");
    await task("t-noop", "noop");
    await task("t-noop-2", "noop");
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
