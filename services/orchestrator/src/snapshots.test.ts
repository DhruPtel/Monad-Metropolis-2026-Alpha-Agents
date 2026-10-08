import type { AgentState, ChainReader, MarketState } from "@alpha-agents/chain-tools";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { SnapshotStore } from "@alpha-agents/trading";
import type { Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SnapshotRecorder } from "./snapshots.ts";
import { Store } from "./store.ts";
import { CHAIN, indexAgent } from "./testing.ts";

/**
 * Value snapshots (Phase 2 tuning): an interval pass records each indexed
 * agent's account at most once per interval, reads nothing for an agent with
 * no account again before the interval, and a settled trade records its own.
 */
const dbUp = await databaseAvailable();
const NOW = 1_790_000_000n;
const PX = 25_000_000_000_000_000n;

class Reader implements ChainReader {
  readonly chainId = CHAIN;
  reads: number[] = [];
  accounts = new Map<number, Partial<AgentState>>();
  priceReason: "OK" | "STALE" = "OK";
  async market(): Promise<MarketState> {
    return {
      monUsd: { priceE18: PX, updatedAt: NOW - 20n, reason: this.priceReason },
    } as unknown as MarketState;
  }
  async agent(agentId: number): Promise<AgentState> {
    this.reads.push(agentId);
    const a = this.accounts.get(agentId);
    return {
      block: 500n,
      timestamp: NOW,
      account: null,
      usdc: 0n,
      wmon: 0n,
      mode: "NORMAL",
      ...a,
    } as AgentState;
  }
  async quote() {
    return { block: 500n, amountOut: 0n };
  }
  tokenOf(): Hex {
    return "0x00000000000000000000000000000000000000c1";
  }
}

describe.skipIf(!dbUp)("the value snapshot recorder (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let store: Store;
  let snapshots: SnapshotStore;

  beforeAll(async () => {
    t = await createTestDatabase("orch_snapshots");
    store = new Store(t.db);
    snapshots = new SnapshotStore(t.db, "fork");
    for (const id of [1, 2]) await indexAgent(t.db, id, "base");
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    await t.db.deleteFrom("platform.account_snapshots").execute();
  });

  it("records each account once per interval, and skips an agent with none without re-reading it", async () => {
    const reader = new Reader();
    reader.accounts.set(1, {
      account: "0x00000000000000000000000000000000000ac001",
      usdc: 30_000_000n,
      wmon: 400n * 10n ** 18n,
      mode: "REDUCE_ONLY",
    });
    const r = new SnapshotRecorder({
      chainId: CHAIN,
      store,
      snapshots,
      reader,
      log: () => undefined,
    });
    expect(await r.tick()).toBe(1);
    expect(reader.reads.sort()).toEqual([1, 2]);
    reader.reads = [];
    expect(await r.tick()).toBe(0);
    expect(reader.reads).toEqual([]);
    const [row] = await snapshots.list(CHAIN, 1);
    expect(row).toMatchObject({
      reason: "interval",
      valueUsdc: 40_000_000n,
      usdc: 30_000_000n,
      mode: "REDUCE_ONLY",
    });
    expect(await snapshots.list(CHAIN, 2)).toEqual([]);
  });

  it("records a settled trade's snapshot once, with an unknown value while the price is unusable", async () => {
    const reader = new Reader();
    reader.priceReason = "STALE";
    reader.accounts.set(1, {
      account: "0x00000000000000000000000000000000000ac001",
      usdc: 29_000_000n,
      wmon: 40n * 10n ** 18n,
    });
    const r = new SnapshotRecorder({
      chainId: CHAIN,
      store,
      snapshots,
      reader,
      log: () => undefined,
    });
    expect(await r.observe(1, "trade", "intent-x")).toBe(true);
    expect(await r.observe(1, "trade", "intent-x")).toBe(false);
    expect(await snapshots.list(CHAIN, 1)).toEqual([
      expect.objectContaining({ reason: "trade", intentId: "intent-x", valueUsdc: null }),
    ]);
  });
});
