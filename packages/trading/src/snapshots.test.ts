import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import type { Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AccountObservation, SnapshotStore, accountValueUsdc } from "./snapshots.ts";

const dbUp = await databaseAvailable();
const CHAIN = 143143;
const PX = 25_000_000_000_000_000n;

const obs = (over: Partial<AccountObservation> = {}): AccountObservation => ({
  agentId: 1,
  account: "0x00000000000000000000000000000000000ac001" as Hex,
  block: 109_670_100n,
  timestamp: 1_790_000_000n,
  usdc: 30_000_000n,
  wmon: 400n * 10n ** 18n,
  mode: "NORMAL",
  monUsdE18: PX,
  ...over,
});

describe("account values (Phase 2 tuning)", () => {
  it("values WMON at the oracle price, and is unknown without one only when WMON is held", () => {
    expect(accountValueUsdc(obs())).toBe(40_000_000n);
    expect(accountValueUsdc(obs({ monUsdE18: null }))).toBeNull();
    expect(accountValueUsdc(obs({ wmon: 0n, monUsdE18: null }))).toBe(30_000_000n);
  });
});

describe.skipIf(!dbUp)("value snapshots (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let clock = new Date("2026-10-08T12:00:00Z");
  let store: SnapshotStore;

  beforeAll(async () => {
    t = await createTestDatabase("snapshots");
    store = new SnapshotStore(t.db, "fork", () => clock);
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    clock = new Date("2026-10-08T12:00:00Z");
    await t.db.deleteFrom("platform.account_snapshots").execute();
  });

  it("records value, balances and mode, per environment, and is due again only after the interval", async () => {
    expect(await store.due(CHAIN, 1)).toBe(true);
    expect(await store.record(CHAIN, obs(), "interval")).toBe(true);
    expect(await store.due(CHAIN, 1)).toBe(false);
    clock = new Date(clock.getTime() + 15 * 60_000);
    expect(await store.due(CHAIN, 1)).toBe(true);
    const [row] = await store.list(CHAIN, 1);
    expect(row).toMatchObject({
      valueUsdc: 40_000_000n,
      usdc: 30_000_000n,
      wmon: 400n * 10n ** 18n,
      mode: "NORMAL",
      reason: "interval",
      blockTime: 1_790_000_000n,
    });
    // Another environment's records are its own.
    expect(await new SnapshotStore(t.db, "testnet").list(CHAIN, 1)).toEqual([]);
    expect(await new SnapshotStore(t.db, "testnet").due(CHAIN, 1)).toBe(true);
  });

  it("keeps one snapshot per settled trade, and records an unknown value while the price is unusable", async () => {
    expect(await store.record(CHAIN, obs(), "trade", "intent-a")).toBe(true);
    expect(await store.record(CHAIN, obs(), "trade", "intent-a")).toBe(false);
    clock = new Date(clock.getTime() + 1_000);
    expect(
      await store.record(CHAIN, obs({ monUsdE18: null, mode: "PAUSED" }), "trade", "intent-b"),
    ).toBe(true);
    const rows = await store.list(CHAIN, 1);
    expect(rows.map((r) => [r.intentId, r.valueUsdc, r.mode])).toEqual([
      ["intent-b", null, "PAUSED"],
      ["intent-a", 40_000_000n, "NORMAL"],
    ]);
    // Trade snapshots do not count toward the interval.
    expect(await store.due(CHAIN, 1)).toBe(true);
  });
});
