import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { TradeStore } from "@alpha-agents/trading";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORM_PAUSE_REASON, pausePlatform } from "./platform-pause.ts";
import { ResearchStore } from "./research-loop.ts";
import { CHAIN } from "./testing.ts";

const dbUp = await databaseAvailable();
const OWNER = "0x00000000000000000000000000000000000000a1";
const KEY = "0x00000000000000000000000000000000000000b2";

describe.skipIf(!dbUp)("the platform pause (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let trades: TradeStore;
  let research: ResearchStore;

  beforeAll(async () => {
    t = await createTestDatabase("orch_platform_pause");
    trades = new TradeStore(t.db);
    research = new ResearchStore(t.db);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  const arm = async (agentId: number, armed: boolean) => {
    const { record } = await trades.startArming({
      chainId: CHAIN,
      agentId,
      owner: OWNER,
      ownerEpoch: 1n,
      configEpoch: 0n,
      sessionKey: KEY,
      validUntil: BigInt(Math.floor(Date.now() / 1000) + 20 * 86_400),
    });
    if (armed) await trades.markArmed(record.armingId, `intent-${agentId}`);
    return record;
  };

  it("disarms every open arming as the owner's Turn off does, records why, and pauses research", async () => {
    const a1 = await arm(1, true);
    await arm(2, false);
    await research.update({ chainId: CHAIN, agentId: 3 }, { fastCadence: true });
    await research.update({ chainId: CHAIN, agentId: 4 }, { paused: true });

    // A dry run changes nothing.
    const dry = await pausePlatform(t.db, CHAIN, false);
    expect(dry.disarmed.map((d) => [d.agentId, d.was])).toEqual([
      [1, "armed"],
      [2, "awaiting_first_trade"],
    ]);
    expect(await trades.openArming(CHAIN, 1)).not.toBeNull();
    expect((await research.schedule({ chainId: CHAIN, agentId: 3 })).paused).toBe(false);

    const r = await pausePlatform(t.db, CHAIN, true);
    expect(r.disarmed.map((d) => d.agentId)).toEqual([1, 2]);
    expect(r.researchPaused).toEqual([3]);
    for (const id of [1, 2]) {
      expect(await trades.openArming(CHAIN, id)).toBeNull();
      const last = await trades.lastArming(CHAIN, id);
      // The owner's disarm: ended, the grant left on chain for Turn on.
      expect(last).toMatchObject({
        status: "ended",
        endedReason: "disarmed",
        revokedOnchain: false,
      });
    }
    expect((await research.schedule({ chainId: CHAIN, agentId: 3 })).paused).toBe(true);
    // Its other settings are left as they were.
    expect((await research.schedule({ chainId: CHAIN, agentId: 3 })).fastCadence).toBe(true);
    const entry = await t.db
      .selectFrom("platform.activity_entries")
      .select(["kind", "text", "task_id"])
      .where("agent_id", "=", 1)
      .executeTakeFirstOrThrow();
    expect(entry).toEqual({
      kind: "arming",
      task_id: `${a1.armingId}:ended`,
      text: `Agent #1 is no longer armed: ${PLATFORM_PAUSE_REASON}`,
    });

    // Run again: nothing left to change.
    expect(await pausePlatform(t.db, CHAIN, true)).toEqual({ disarmed: [], researchPaused: [] });
  });
});
