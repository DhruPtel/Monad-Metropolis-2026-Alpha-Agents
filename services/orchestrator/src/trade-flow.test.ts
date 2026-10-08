import type { AgentState, ChainReader, MarketState } from "@alpha-agents/chain-tools";
import { tradeNow } from "@alpha-agents/chain-tools";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { LAUNCH_EXECUTOR_POLICY, LAUNCH_POLICY_HASH } from "@alpha-agents/policy";
import type { AcceptResult, SwapIntentArgs } from "@alpha-agents/signer";
import { SWAP_GAS_LIMIT } from "@alpha-agents/signer";
import {
  RENEWAL_REMINDER_SECONDS,
  TradeStore,
  approveByOwner,
  disarm,
} from "@alpha-agents/trading";
import { type Hex, getAddress } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ArmingFacts, BlockedFacts, TradeFacts } from "./narrator.ts";
import { CHAIN } from "./testing.ts";
import { TradeFlow, actionIdOf, minAmountOutFor, swapGasCost } from "./trade-flow.ts";

/**
 * The trade flow (P2-U6) against Postgres with a chain and a signer that the
 * tests change field by field: arming and every way it ends, approval, the
 * re-checks at submission, slot reservation, gas, and settlement only after
 * the signer reconciled the swap (and, off the fork, its block is finalized).
 */
const dbUp = await databaseAvailable();
const NOW = 1_790_000_000n;
const PX = 25_000_000_000_000_000n;
const OWNER = getAddress("0x00000000000000000000000000000000000a11ce");
const BUYER = getAddress("0x00000000000000000000000000000000000b0b00");
const KEY = getAddress("0x00000000000000000000000000000000000000ee");
const ADAPTER_ID = `0x${"ad".repeat(32)}` as Hex;
const USDC = "0x00000000000000000000000000000000000000c1" as Hex;
const WMON = "0x00000000000000000000000000000000000000c2" as Hex;

class FakeChain implements ChainReader {
  readonly chainId = CHAIN;
  timestamp = NOW;
  agentState: AgentState = FakeChain.agent();
  quoteBps = 9_990n;

  static agent(over: Partial<AgentState> = {}): AgentState {
    return {
      block: 500n,
      timestamp: NOW,
      owner: OWNER,
      ownerEpoch: 1n,
      configEpoch: 0n,
      account: "0x00000000000000000000000000000000000ac001",
      usdc: 70_000_000n,
      wmon: (30_000_000n * 10n ** 30n) / PX,
      mode: "NORMAL",
      breaker: { nav: 100_000_000n, perUnit: 10n ** 18n, peak: 10n ** 18n, drawdownBps: 0n },
      peak7d: 10n ** 18n,
      grant: { key: KEY, ownerEpoch: 1n, configEpoch: 0n, validUntil: NOW + 20n * 86_400n },
      trades: [],
      tradesLeft: 20,
      nextSlotFreesAt: 0n,
      turnoverUsed: 0n,
      venueAllowed: { buy: true, sell: true },
      ...over,
    };
  }
  set(over: Partial<AgentState>) {
    this.agentState = { ...this.agentState, ...over };
  }
  async market(): Promise<MarketState> {
    return {
      chainId: CHAIN,
      block: 500n,
      timestamp: this.timestamp,
      policy: { ...LAUNCH_EXECUTOR_POLICY },
      policyHash: LAUNCH_POLICY_HASH,
      paused: false,
      wmonBuyable: true,
      monUsd: { priceE18: PX, updatedAt: this.timestamp - 20n, reason: "OK" },
      usdcUsd: { priceE18: 10n ** 18n, updatedAt: this.timestamp - 600n, reason: "OK" },
      pool: { priceE18: PX, reason: "OK" },
      deviationBps: 0n,
      tradableReason: "OK",
      venue: {
        adapterId: ADAPTER_ID,
        adapter: "0x00000000000000000000000000000000000000ad",
        feeBps: 5,
        poolKey: {
          currency0: "0x0000000000000000000000000000000000000000",
          currency1: USDC,
          fee: 500,
          tickSpacing: 10,
          hooks: "0x0000000000000000000000000000000000000000",
        },
      },
    };
  }
  async agent(): Promise<AgentState> {
    return { ...this.agentState, timestamp: this.timestamp };
  }
  async quote(sell: "USDC" | "WMON", amountIn: bigint) {
    const implied = sell === "USDC" ? (amountIn * 10n ** 30n) / PX : (amountIn * PX) / 10n ** 30n;
    return { block: 500n, amountOut: (implied * this.quoteBps) / 10_000n };
  }
  tokenOf(asset: "USDC" | "WMON"): Hex {
    return asset === "USDC" ? USDC : WMON;
  }
}

describe.skipIf(!dbUp)("the trade flow (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let trades: TradeStore;
  let chain: FakeChain;
  let flow: TradeFlow;
  let sent: { agentId: number; intent: SwapIntentArgs; txId: string }[];
  let refuseNext: string | null;
  let balance: bigint;
  let toppedUp: bigint;
  let finalized: bigint | null;
  let narrated: { key: string; facts: ArmingFacts | TradeFacts | BlockedFacts }[];
  let n = 0;
  const cost = swapGasCost(50_000_000_000n, 2_000_000_000n);

  const make = (o: { topUp?: boolean } = {}) =>
    new TradeFlow({
      chainId: CHAIN,
      store: trades,
      reader: chain,
      signer: {
        keyAddress: async () => KEY,
        submitSwap: async (agentId, intent): Promise<AcceptResult> => {
          n += 1;
          const txId = `tx-${n}`;
          if (refuseNext) {
            const code = refuseNext;
            refuseNext = null;
            return { txId, status: "failed", reasonCode: code, duplicate: false };
          }
          sent.push({ agentId, intent, txId });
          await t.db
            .insertInto("platform.signer_outbox")
            .values({
              tx_id: txId,
              environment: "local",
              chain_id: CHAIN,
              agent_id: agentId,
              key_address: KEY.toLowerCase(),
              kind: "executor_swap",
              action_id: intent.actionId,
              request: "{}",
              status: "accepted",
            })
            .execute();
          return { txId, status: "accepted", reasonCode: null, duplicate: false };
        },
      },
      gas: {
        balance: async () => balance,
        swapCost: async () => cost,
        ...(o.topUp
          ? {
              topUp: async (_a: Hex, wei: bigint) => {
                toppedUp = wei;
                balance += wei;
              },
            }
          : {}),
      },
      finalizedBlock: async () => finalized,
      narrator: {
        narrateEvent: async (_c, _a, key, facts) => {
          narrated.push({ key, facts });
        },
      },
      log: () => undefined,
    });

  beforeAll(async () => {
    t = await createTestDatabase("orch_trade_flow");
    trades = new TradeStore(t.db);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    for (const table of ["platform.intents", "platform.arming", "platform.signer_outbox"] as const)
      await t.db.deleteFrom(table).execute();
    chain = new FakeChain();
    sent = [];
    refuseNext = null;
    balance = cost;
    toppedUp = 0n;
    finalized = null;
    narrated = [];
    flow = make();
  });

  async function propose(amountIn = 5_000_000n, over: { ownerEpoch?: string } = {}) {
    n += 1;
    const id = `intent-${n}`;
    await t.db
      .insertInto("platform.intents")
      .values({
        intent_id: id,
        chain_id: CHAIN,
        agent_id: 1,
        lease_id: "lease-1",
        kind: "swap",
        account: "0x00000000000000000000000000000000000ac001",
        sell: "USDC",
        buy: "WMON",
        amount_in: amountIn.toString(),
        reason: "test",
        idempotency_key: `k-${n}`,
        status: "awaiting_approval",
        reason_codes: "[]",
        checks: "{}",
        owner_epoch: over.ownerEpoch ?? "1",
        config_epoch: "0",
        expires_at: new Date(Date.now() + 1_800_000),
      })
      .execute();
    return id;
  }

  async function arm(status: "awaiting_first_trade" | "armed" = "armed") {
    const g = chain.agentState.grant;
    if (!g) throw new Error("no grant");
    const { record } = await trades.startArming({
      chainId: CHAIN,
      agentId: 1,
      owner: OWNER,
      ownerEpoch: 1n,
      configEpoch: 0n,
      sessionKey: KEY,
      validUntil: g.validUntil,
    });
    if (status === "armed") await trades.markArmed(record.armingId, "intent-first");
    return record;
  }

  const statusOf = async (id: string) => (await trades.intent(CHAIN, 1, id))?.status;
  const outbox = (txId: string, set: Record<string, unknown>) =>
    t.db.updateTable("platform.signer_outbox").set(set).where("tx_id", "=", txId).execute();

  it("arms on the owner's first approval, then approves and sends later proposals on its own", async () => {
    // Not armed: a proposal waits, and the owner cannot approve without a grant.
    const first = await propose();
    await flow.tick();
    expect(await statusOf(first)).toBe("awaiting_approval");
    expect(await approveByOwner(trades, CHAIN, 1, first)).toMatchObject({
      ok: false,
      code: "NOT_ARMED",
    });
    const record = await arm("awaiting_first_trade");
    await flow.tick();
    expect(await statusOf(first)).toBe("awaiting_approval");
    const approved = await approveByOwner(trades, CHAIN, 1, first);
    expect(approved).toMatchObject({ ok: true, armed: { status: "armed" } });
    expect((await trades.openArming(CHAIN, 1))?.firstIntentId).toBe(first);
    await flow.tick();
    expect(await statusOf(first)).toBe("submitted");
    // Armed: the next one goes through without the owner.
    const second = await propose(4_000_000n);
    await flow.tick();
    expect(await trades.intent(CHAIN, 1, second)).toMatchObject({
      status: "submitted",
      approvedBy: "auto",
    });
    expect(sent.map((s) => s.intent.amountIn)).toEqual([5_000_000n, 4_000_000n]);
    expect(narrated.map((x) => x.key)).toEqual(
      expect.arrayContaining([`${record.armingId}:registered`, `${record.armingId}:armed`]),
    );
  });

  it("builds the swap from fresh reads: minimum from the quote within the slippage limit, deadline set now", async () => {
    await arm();
    const id = await propose();
    chain.timestamp = NOW + 100n;
    await flow.tick();
    const s = sent[0];
    if (!s) throw new Error("nothing sent");
    const m = await chain.market();
    const quote = await chain.quote("USDC", 5_000_000n);
    const floor = tradeNow("USDC", 5_000_000n, m).minAmountOut;
    expect(s.intent.minAmountOut).toBe(
      minAmountOutFor(quote.amountOut, floor, m.policy.maxSlippageBps),
    );
    expect(s.intent.minAmountOut).toBeGreaterThanOrEqual(floor);
    expect(s.intent.minAmountOut).toBeLessThan(quote.amountOut);
    expect(s.intent.deadline).toBe(NOW + 100n + BigInt(m.policy.deadlineSeconds));
    expect(s.intent).toMatchObject({
      actionId: actionIdOf(CHAIN, id),
      adapterId: ADAPTER_ID,
      tokenIn: USDC,
      tokenOut: WMON,
      ownerEpoch: 1n,
      policyHash: LAUNCH_POLICY_HASH,
    });
    expect(await trades.intent(CHAIN, 1, id)).toMatchObject({
      txId: s.txId,
      minAmountOut: s.intent.minAmountOut,
      deadline: s.intent.deadline,
    });
  });

  it("re-runs every check at submission and refuses with the reason when something changed", async () => {
    await arm();
    const big = await propose(6_000_000n);
    // The account shrank after the proposal: 6 USDC is now over 10% of it.
    chain.set({ usdc: 20_000_000n, wmon: (20_000_000n * 10n ** 30n) / PX });
    await flow.tick();
    const v = await trades.intent(CHAIN, 1, big);
    expect(v?.status).toBe("rejected");
    expect(v?.reasonCodes).toContain("TRADE_SIZE_EXCEEDED");
    expect(sent).toHaveLength(0);
    const blocked = narrated.find((x) => x.key === `${big}:blocked`);
    expect(blocked?.facts).toMatchObject({ activity: "blocked_trade", sell: { amount: "6" } });
    // A quote now under the oracle floor is caught too.
    chain.set(FakeChain.agent());
    chain.quoteBps = 9_000n;
    const slip = await propose(1_000_000n);
    await flow.tick();
    expect((await trades.intent(CHAIN, 1, slip))?.reasonCodes).toEqual(["SLIPPAGE_TOO_HIGH"]);
  });

  it("an intent proposed before a sale is refused even if the new owner armed again", async () => {
    await arm();
    const old = await propose(1_000_000n, { ownerEpoch: "0" });
    await trades.approve(CHAIN, 1, old, "owner");
    await flow.tick();
    expect((await trades.intent(CHAIN, 1, old))?.reasonCodes).toContain("EPOCH_MISMATCH");
  });

  it("reserves a slot for each waiting or sent intent and frees it on rejection or expiry", async () => {
    // 18 trades in the window: two slots left.
    const past = Array.from({ length: 18 }, () => ({ at: NOW - 60n, valueUsdcE6: 1_000_000n }));
    chain.set({ trades: past, tradesLeft: 2 });
    await arm();
    const a = await propose(1_000_000n);
    const b = await propose(1_000_000n);
    const c = await propose(1_000_000n);
    expect(await trades.reservedSlots(CHAIN, 1)).toBe(3);
    await flow.tick();
    // Oldest first: a and b take the two slots; c finds none and is refused, freeing its own.
    expect([await statusOf(a), await statusOf(b), await statusOf(c)]).toEqual([
      "submitted",
      "submitted",
      "rejected",
    ]);
    expect((await trades.intent(CHAIN, 1, c))?.reasonCodes).toEqual(["DAILY_TRADE_LIMIT"]);
    expect(await trades.reservedSlots(CHAIN, 1)).toBe(2);
  });

  it("blocks with GAS_UNFUNDED when the funding address cannot pay gas; the fork tops it up", async () => {
    await arm();
    balance = 0n;
    const id = await propose();
    await flow.tick();
    const v = await trades.intent(CHAIN, 1, id);
    expect(v?.status).toBe("rejected");
    expect(v?.blockers).toEqual([
      expect.objectContaining({
        code: "GAS_UNFUNDED",
        message: "The agent's funding address has no MON to pay gas for the trade.",
        clears: "by_the_owner",
      }),
    ]);
    expect(cost).toBe(SWAP_GAS_LIMIT * (50_000_000_000n * 2n + 2_000_000_000n));
    const local = make({ topUp: true });
    const again = await propose(4_000_000n);
    await local.tick();
    expect(await statusOf(again)).toBe("submitted");
    expect(toppedUp).toBe(cost * 10n);
  });

  it("refuses at submission when arming ended after approval, and records a signer refusal", async () => {
    const r = await arm();
    const id = await propose();
    await trades.approve(CHAIN, 1, id, "owner");
    await trades.endArming(r.armingId, "disarmed");
    await flow.tick();
    expect((await trades.intent(CHAIN, 1, id))?.reasonCodes).toEqual(["NOT_ARMED"]);
    await arm();
    refuseNext = "TARGET_NOT_ALLOWED";
    const other = await propose(2_000_000n);
    await flow.tick();
    expect(await trades.intent(CHAIN, 1, other)).toMatchObject({
      status: "rejected",
      reasonCodes: ["SEND_FAILED"],
      failure: "the signer refused it: TARGET_NOT_ALLOWED",
    });
  });

  it("settles only after the signer reconciled the swap, and off the fork only once finalized", async () => {
    await arm();
    const id = await propose();
    await flow.tick();
    const txId = sent[0]?.txId ?? "";
    finalized = 90n;
    await outbox(txId, { status: "confirmed", tx_hash: "0xabc", block_number: 100 });
    await flow.tick();
    expect(await statusOf(id)).toBe("confirmed");
    // Reconciled by the signer, but its block is not final yet.
    await outbox(txId, { status: "reconciled", amount_out: "199800000000000000000" });
    await flow.tick();
    expect(await statusOf(id)).toBe("confirmed");
    expect(narrated.some((x) => x.key === `${id}:trade`)).toBe(false);
    finalized = 100n;
    await flow.tick();
    const v = await trades.intent(CHAIN, 1, id);
    expect(v).toMatchObject({ status: "reconciled", amountOut: 199_800_000_000_000_000_000n });
    expect(v?.settledAt).toBeInstanceOf(Date);
    expect(narrated.find((x) => x.key === `${id}:trade`)?.facts).toMatchObject({
      activity: "trade",
      sold: { asset: "USDC", amount: "5" },
      bought: { asset: "WMON", amount: "199.8" },
      approvedBy: "automatically (armed)",
    });
    // A confirmed swap whose reconciliation is flagged stays confirmed.
    const flagged = await propose(1_000_000n);
    await flow.tick();
    const tx2 = sent[1]?.txId ?? "";
    await outbox(tx2, {
      status: "confirmed",
      tx_hash: "0xdef",
      block_number: 101,
      reason_code: "RECONCILE_MISMATCH",
    });
    finalized = 200n;
    await flow.tick();
    expect(await statusOf(flagged)).toBe("confirmed");
  });

  it("marks a swap that failed on the way as failed with its reason", async () => {
    await arm();
    const id = await propose();
    await flow.tick();
    await outbox(sent[0]?.txId ?? "", {
      status: "failed",
      reason_code: "SLIPPAGE_TOO_HIGH",
      reason: "the Executor would refuse it",
    });
    await flow.tick();
    expect(await trades.intent(CHAIN, 1, id)).toMatchObject({
      status: "failed",
      reasonCodes: ["SEND_FAILED"],
      failure: "SLIPPAGE_TOO_HIGH: the Executor would refuse it",
    });
    expect(narrated.some((x) => x.key === `${id}:blocked`)).toBe(true);
  });

  it("ends arming on expiry, a sale, a configuration change and a revoked grant", async () => {
    const cases: [string, () => void][] = [
      ["expired", () => (chain.timestamp = NOW + 21n * 86_400n)],
      ["sold", () => chain.set({ owner: BUYER, ownerEpoch: 2n })],
      ["config_changed", () => chain.set({ configEpoch: 1n })],
      ["revoked", () => chain.set({ grant: null })],
    ];
    for (const [reason, change] of cases) {
      chain = new FakeChain();
      flow = make();
      await t.db.deleteFrom("platform.arming").execute();
      const r = await arm();
      change();
      const ended = await flow.upkeepArmings();
      expect(
        ended.map((e) => e.endedReason),
        reason,
      ).toEqual([reason]);
      expect(await trades.openArming(CHAIN, 1)).toBeNull();
      expect(narrated.find((x) => x.key === `${r.armingId}:ended`)?.facts).toMatchObject({
        activity: "arming",
        event: "ended",
      });
    }
    // Ended: proposals wait again.
    const id = await propose();
    await flow.tick();
    expect(await statusOf(id)).toBe("awaiting_approval");
  });

  it("the owner disarms at once; the revoke on chain is recorded when it lands", async () => {
    const r = await arm();
    expect((await disarm(trades, CHAIN, 1))?.endedReason).toBe("disarmed");
    await flow.upkeepArmings();
    expect((await trades.lastArming(CHAIN, 1))?.revokedOnchain).toBe(false);
    chain.set({ grant: null });
    await flow.upkeepArmings();
    expect((await trades.lastArming(CHAIN, 1))?.revokedOnchain).toBe(true);
    expect(narrated.some((x) => x.key === `${r.armingId}:ended`)).toBe(false);
  });

  it("reminds the owner once before expiry, and a renewal on chain moves the expiry", async () => {
    const r = await arm();
    await flow.upkeepArmings();
    expect(narrated.some((x) => x.key === `${r.armingId}:renewal`)).toBe(false);
    chain.timestamp = r.validUntil - BigInt(RENEWAL_REMINDER_SECONDS) + 1n;
    await flow.upkeepArmings();
    await flow.upkeepArmings();
    expect(narrated.filter((x) => x.key === `${r.armingId}:renewal`)).toHaveLength(1);
    const later = r.validUntil + 10n * 86_400n;
    chain.set({ grant: { key: KEY, ownerEpoch: 1n, configEpoch: 0n, validUntil: later } });
    await flow.upkeepArmings();
    const open = await trades.openArming(CHAIN, 1);
    expect(open).toMatchObject({ validUntil: later, remindedAt: null, status: "armed" });
  });
});
