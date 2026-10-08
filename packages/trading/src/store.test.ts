import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { type Hex, getAddress } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TradeStore } from "./store.ts";

const dbUp = await databaseAvailable();
const CHAIN = 143143;
const OWNER = getAddress("0x00000000000000000000000000000000000a11ce");
const KEY = "0x00000000000000000000000000000000000000ee" as Hex;
const T0 = new Date("2026-10-07T12:00:00Z");

describe.skipIf(!dbUp)("the trade store (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let clock = T0;
  let store: TradeStore;
  let n = 0;

  beforeAll(async () => {
    t = await createTestDatabase("trading");
    store = new TradeStore(t.db, () => clock);
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    clock = T0;
    await t.db.deleteFrom("platform.intents").execute();
    await t.db.deleteFrom("platform.arming").execute();
  });

  async function intent(agentId = 1, status = "awaiting_approval" as const, expiresInS = 1800) {
    n += 1;
    const id = `intent-${n}`;
    await t.db
      .insertInto("platform.intents")
      .values({
        intent_id: id,
        chain_id: CHAIN,
        agent_id: agentId,
        lease_id: "lease-1",
        kind: "swap",
        sell: "USDC",
        buy: "WMON",
        amount_in: "5000000",
        reason: "test",
        idempotency_key: `k-${n}`,
        status,
        reason_codes: "[]",
        checks: JSON.stringify({ expectedOut: "200000000000000000000" }),
        expires_at: new Date(clock.getTime() + expiresInS * 1000),
      })
      .execute();
    return id;
  }

  const grant = (over: Partial<Parameters<TradeStore["startArming"]>[0]> = {}) => ({
    chainId: CHAIN,
    agentId: 1,
    owner: OWNER,
    ownerEpoch: 1n,
    configEpoch: 0n,
    sessionKey: KEY,
    validUntil: 1_800_000_000n,
    ...over,
  });

  it("starts an arming awaiting its first trade, renews it in place, and replaces a different one", async () => {
    const { record, renewed } = await store.startArming(grant());
    expect(renewed).toBe(false);
    expect(record).toMatchObject({ status: "awaiting_first_trade", owner: OWNER, ownerEpoch: 1n });
    await store.markReminded(record.armingId);
    const again = await store.startArming(grant({ validUntil: 1_800_100_000n }));
    expect(again).toMatchObject({ renewed: true, record: { armingId: record.armingId } });
    expect(again.record.validUntil).toBe(1_800_100_000n);
    expect(again.record.remindedAt).toBeNull();
    const other = await store.startArming(grant({ configEpoch: 1n }));
    expect(other.record.armingId).not.toBe(record.armingId);
    const all = await store.armingRows(CHAIN, 1);
    expect(all.map((r) => r.status).sort()).toEqual(["awaiting_first_trade", "ended"]);
    expect(all.find((r) => r.status === "ended")?.ended_reason).toBe("revoked");
  });

  it("arms on the first approval only once, and ends once with its reason", async () => {
    const { record } = await store.startArming(grant());
    expect(await store.markArmed(record.armingId, "intent-x")).toMatchObject({ status: "armed" });
    expect(await store.markArmed(record.armingId, "intent-y")).toBeNull();
    expect(await store.endArming(record.armingId, "disarmed", false)).toMatchObject({
      status: "ended",
      endedReason: "disarmed",
    });
    expect(await store.endArming(record.armingId, "sold")).toBeNull();
    expect(await store.openArming(CHAIN, 1)).toBeNull();
    expect((await store.lastArming(CHAIN, 1))?.endedReason).toBe("disarmed");
    expect(await store.markReminded(record.armingId)).toBe(true);
    expect(await store.markReminded(record.armingId)).toBe(false);
  });

  it("approves only a waiting, unexpired intent of that agent, once", async () => {
    const a = await intent();
    expect(await store.approve(CHAIN, 2, a, "owner")).toBeNull();
    expect(await store.approve(CHAIN, 1, a, "owner")).toMatchObject({
      status: "approved",
      approvedBy: "owner",
      expectedOut: 200_000_000_000_000_000_000n,
    });
    expect(await store.approve(CHAIN, 1, a, "auto")).toBeNull();
    const late = await intent(1, "awaiting_approval", 60);
    clock = new Date(T0.getTime() + 61_000);
    expect(await store.approve(CHAIN, 1, late, "owner")).toBeNull();
    expect((await store.intent(CHAIN, 1, late))?.status).toBe("expired");
  });

  it("moves an intent forward only from the state it leaves", async () => {
    const a = await intent();
    const sent = { txId: "tx-1", actionId: "0xaa", minAmountOut: 9n, deadline: 99n };
    expect(await store.markSubmitted(a, sent)).toBe(false);
    await store.approve(CHAIN, 1, a, "auto");
    expect(await store.markSubmitted(a, sent)).toBe(true);
    expect(await store.markSubmitted(a, sent)).toBe(false);
    expect(await store.markConfirmed(a, "0xhash")).toBe(true);
    expect(await store.markReconciled(a, 123n, "0xhash")).toBe(true);
    expect(await store.markReconciled(a, 123n, "0xhash")).toBe(false);
    const v = await store.intent(CHAIN, 1, a);
    expect(v).toMatchObject({ status: "reconciled", amountOut: 123n, txId: "tx-1", deadline: 99n });
    expect(v?.settledAt).toBeInstanceOf(Date);
    const b = await intent();
    await store.approve(CHAIN, 1, b, "auto");
    const blocker = {
      code: "GAS_UNFUNDED",
      message: "no gas",
      clears: "by_the_owner",
      clearsAt: null,
      hint: "send MON",
    };
    expect(await store.markStopped(b, ["approved"], "rejected", "re-check", [blocker])).toBe(true);
    expect(await store.intent(CHAIN, 1, b)).toMatchObject({
      status: "rejected",
      reasonCodes: ["GAS_UNFUNDED"],
      failure: "re-check",
    });
  });

  it("explains why the agent did not trade: not armed, why arming ended, and each blocked trade", async () => {
    let why = await store.whyNotTraded(CHAIN, 1);
    expect(why.armingState).toBe("unarmed");
    expect(why.reasons.map((r) => r.code)).toEqual(["NOT_ARMED"]);
    const { record } = await store.startArming(grant());
    await store.markArmed(record.armingId, "i");
    const b = await intent();
    await store.approve(CHAIN, 1, b, "auto");
    await store.markStopped(b, ["approved"], "rejected", "re-check", [
      {
        code: "TRADE_SIZE_EXCEEDED",
        message: "too big",
        clears: "by_changing_the_trade",
        clearsAt: null,
        hint: "smaller",
      },
    ]);
    await intent();
    why = await store.whyNotTraded(CHAIN, 1);
    expect(why).toMatchObject({ armingState: "armed", armingEnded: null, waitingForApproval: 1 });
    expect(why.reasons).toEqual([expect.objectContaining({ code: "TRADE_SIZE_EXCEEDED", intentId: b })]);
    await store.endArming(record.armingId, "expired");
    why = await store.whyNotTraded(CHAIN, 1);
    expect(why.armingEnded?.reason).toBe("expired");
    expect(why.reasons[0]?.code).toBe("NOT_ARMED");
    // Another agent's records are not this one's.
    expect((await store.whyNotTraded(CHAIN, 2)).reasons.map((r) => r.intentId)).toEqual([null]);
  });
});
