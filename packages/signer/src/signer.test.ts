import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import type { Db } from "@alpha-agents/db";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { type Hex, bytesToHex, encodeFunctionData, hexToBytes, keccak256, toBytes } from "viem";
import { HDKey } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ERC20_ABI, type SwapIntentArgs } from "./abi.ts";
import { FakeChain } from "./fake-chain.ts";
import { LocalKeyProvider, sessionKeyPath } from "./keys.ts";
import { Signer, type SignerOptions } from "./signer.ts";

/**
 * The signer's outbox against Postgres and a fake chain (P2-U4 item 11):
 * every state, the refusals, unknown outcomes resolved without a resend,
 * nonces across restarts, the writer fence and reconciliation.
 */
const dbUp = await databaseAvailable();

const EXECUTOR = "0xE712468eB37544B7Eafe20F402867f7a49C19F43" as Hex;
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Hex;
const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Hex;
const ACCOUNT = "0x00000000000000000000000000000000000Ac001" as Hex;
const AGENT = 7;
const must = <T>(v: T | null | undefined): T => {
  if (v === null || v === undefined) throw new Error("expected a value");
  return v;
};
const SEED = bytesToHex(randomBytes(32));
const PRIVATE_KEY = bytesToHex(
  must(HDKey.fromMasterSeed(hexToBytes(SEED)).derive(sessionKeyPath(AGENT)).privateKey),
);

let counter = 0;
const intent = (over: Partial<SwapIntentArgs> = {}, chainId = 143143n): SwapIntentArgs => ({
  schemaVersion: 1,
  chainId,
  agentId: BigInt(AGENT),
  account: ACCOUNT,
  actionId: keccak256(toBytes(`action ${++counter}`)),
  ownerEpoch: 0n,
  configEpoch: 0n,
  policyHash: `0x${"22".repeat(32)}`,
  adapterId: `0x${"33".repeat(32)}`,
  tokenIn: USDC,
  tokenOut: WMON,
  amountIn: 5_000_000n,
  minAmountOut: 160_000_000_000_000_000n,
  deadline: 1_790_876_545n,
  ...over,
});

describe.skipIf(!dbUp)("the signer's outbox (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let db: Db;
  let chain: FakeChain;
  let clock: number;
  let logs: string[];

  const make = (over: Partial<SignerOptions> = {}) =>
    new Signer({
      db,
      environment: "local",
      chain,
      keys: new LocalKeyProvider(SEED),
      executor: EXECUTOR,
      assets: { [USDC.toLowerCase()]: "USDC", [WMON.toLowerCase()]: "WMON" },
      log: (l) => logs.push(l),
      now: () => new Date(clock),
      dropGraceMs: 120_000,
      receiptTimeoutMs: 60_000,
      ...over,
    });

  const row = (txId: string) =>
    db
      .selectFrom("platform.signer_outbox")
      .selectAll()
      .where("tx_id", "=", txId)
      .executeTakeFirstOrThrow();
  const statuses = async (txId: string) =>
    ((await row(txId)).history as { status: string }[]).map((h) => h.status);
  const nextNonce = async (chainId = 143143) =>
    (
      await db
        .selectFrom("platform.signer_keys")
        .select("next_nonce")
        .where("chain_id", "=", chainId)
        .where("agent_id", "=", AGENT)
        .executeTakeFirstOrThrow()
    ).next_nonce;
  const ticks = async (s: Signer, n = 3) => {
    for (let i = 0; i < n; i++) await s.tick();
  };

  beforeAll(async () => {
    t = await createTestDatabase("signer");
    db = t.db;
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    for (const table of [
      "platform.signer_outbox",
      "platform.signer_keys",
      "platform.ledger_lines",
      "platform.ledger_entries",
    ] as const)
      await db.deleteFrom(table).execute();
    chain = new FakeChain(143143, EXECUTOR);
    chain.setBalance(USDC, ACCOUNT, 100_000_000n);
    clock = Date.parse("2026-10-07T12:00:00Z");
    logs = [];
  });

  it("moves a swap through accepted, signed, submitted and confirmed to reconciled, with its ledger entry", async () => {
    const s = make();
    await s.start();
    const key = await s.createKey(AGENT);
    const accepted = await s.submitSwap(AGENT, intent());
    expect(accepted).toMatchObject({ status: "accepted", duplicate: false });
    await ticks(s, 1);
    const r = await row(accepted.txId);
    expect(r.status).toBe("reconciled");
    expect(await statuses(accepted.txId)).toEqual([
      "accepted",
      "signed",
      "submitted",
      "confirmed",
      "reconciled",
    ]);
    expect(r).toMatchObject({ nonce: 0, gas_limit: "1300000", amount_out: "160000000000000001" });
    expect(r.balances).toEqual({
      tokenIn: { before: "100000000", after: "95000000" },
      tokenOut: { before: "0", after: "160000000000000001" },
    });
    expect(chain.sent).toHaveLength(1);
    const ledger = await s.ledgerEntry(must(r.ledger_entry_id));
    expect(ledger).toMatchObject({ kind: "trade" });
    expect(ledger?.lines).toEqual([
      { account: "personal_account", asset: "USDC", amount: "-5000000" },
      { account: "venue", asset: "USDC", amount: "5000000" },
      { account: "venue", asset: "WMON", amount: "-160000000000000001" },
      { account: "personal_account", asset: "WMON", amount: "160000000000000001" },
    ]);
    expect(await nextNonce()).toBe(1);
    expect(key).toBe((await new LocalKeyProvider(SEED).key(AGENT)).address);
  });

  it("refuses a call to anything but the Executor's swap, and a wrong chain, before signing", async () => {
    const s = make();
    await s.createKey(AGENT);
    const transfer = await s.accept(AGENT, {
      chainId: 143143,
      to: USDC,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [ACCOUNT, 1n] }),
      value: 0n,
    });
    expect(transfer).toMatchObject({ status: "failed", reasonCode: "TARGET_NOT_ALLOWED" });
    const mainnet = await s.submitSwap(AGENT, intent({}, 143n));
    expect(mainnet).toMatchObject({ status: "failed", reasonCode: "CHAIN_NOT_PINNED" });
    const otherAgent = await s.submitSwap(AGENT, intent({ agentId: 8n }));
    expect(otherAgent).toMatchObject({ status: "failed", reasonCode: "AGENT_MISMATCH" });
    await ticks(s);
    expect(chain.sent).toHaveLength(0);
    expect((await row(transfer.txId)).raw_tx).toBeNull();
    expect(await nextNonce()).toBe(0);
  });

  it("refuses a chain whose providers answer another chain ID", async () => {
    chain.chainId = 143;
    await expect(make().start()).rejects.toThrow("signs for chain 143143, not 143");
  });

  it("fails an Executor refusal found in simulation with its reason, unsigned", async () => {
    const s = make();
    await s.createKey(AGENT);
    chain.simulation = {
      ok: false,
      code: "SLIPPAGE_TOO_HIGH",
      message: "the Executor refused: SLIPPAGE_TOO_HIGH",
    };
    const a = await s.submitSwap(AGENT, intent());
    await ticks(s);
    expect(await row(a.txId)).toMatchObject({
      status: "failed",
      reason_code: "SLIPPAGE_TOO_HIGH",
      raw_tx: null,
    });
    expect(chain.sent).toHaveLength(0);
    expect(await nextNonce()).toBe(0);
  });

  it("fails when the network's fee is above the cap, unsigned", async () => {
    const s = make();
    await s.createKey(AGENT);
    chain.baseFee = 600_000_000_000n;
    const a = await s.submitSwap(AGENT, intent());
    await ticks(s);
    expect(await row(a.txId)).toMatchObject({ status: "failed", reason_code: "FEE_CAP_EXCEEDED" });
    expect(chain.sent).toHaveLength(0);
  });

  it("fails an on-chain revert with its revert reason fetched, and keeps the nonce used", async () => {
    const s = make();
    await s.createKey(AGENT);
    chain.revertNext = "DEADLINE_EXPIRED";
    const a = await s.submitSwap(AGENT, intent());
    await ticks(s);
    const r = await row(a.txId);
    expect(r).toMatchObject({ status: "failed", reason_code: "DEADLINE_EXPIRED", nonce: 0 });
    expect(r.reason).toContain("DEADLINE_EXPIRED");
    expect(await statuses(a.txId)).toEqual(["accepted", "signed", "submitted", "failed"]);
    expect(await nextNonce()).toBe(1);
  });

  it("gives back the nonce of a broadcast the node refused, so the next swap leaves no gap", async () => {
    const s = make();
    await s.createKey(AGENT);
    chain.mode = "reject";
    const a = await s.submitSwap(AGENT, intent());
    await ticks(s);
    expect(await row(a.txId)).toMatchObject({
      status: "failed",
      reason_code: "BROADCAST_REJECTED",
      nonce: null,
    });
    expect(await nextNonce()).toBe(0);
    chain.mode = "mine";
    const b = await s.submitSwap(AGENT, intent());
    await ticks(s);
    expect(await row(b.txId)).toMatchObject({ status: "reconciled", nonce: 0 });
  });

  it("marks a timed-out broadcast unknown and resolves it by hash, without sending it again", async () => {
    const s = make();
    await s.createKey(AGENT);
    chain.mode = "timeout-landed";
    const a = await s.submitSwap(AGENT, intent());
    await ticks(s, 1);
    expect(await statuses(a.txId)).toEqual([
      "accepted",
      "signed",
      "unknown",
      "confirmed",
      "reconciled",
    ]);
    expect(chain.sent).toHaveLength(1);
  });

  it("marks a lost broadcast unknown, waits, then calls it dropped and frees the nonce: never resent", async () => {
    const s = make();
    await s.createKey(AGENT);
    chain.mode = "timeout-lost";
    const a = await s.submitSwap(AGENT, intent());
    await ticks(s);
    expect((await row(a.txId)).status).toBe("unknown");
    clock += 60_000;
    await ticks(s);
    expect((await row(a.txId)).status).toBe("unknown");
    clock += 61_000;
    await ticks(s, 1);
    expect(await row(a.txId)).toMatchObject({
      status: "failed",
      reason_code: "DROPPED",
      nonce: null,
    });
    expect(chain.sent).toHaveLength(1);
    expect(await nextNonce()).toBe(0);
    chain.mode = "mine";
    const b = await s.submitSwap(AGENT, intent());
    await ticks(s);
    expect(await row(b.txId)).toMatchObject({ status: "reconciled", nonce: 0 });
    expect(chain.sent).toHaveLength(2);
  });

  it("fails an unknown transaction whose nonce another transaction used, without resending it", async () => {
    const s = make();
    const key = await s.createKey(AGENT);
    chain.mode = "timeout-lost";
    const a = await s.submitSwap(AGENT, intent());
    await ticks(s, 1);
    chain.consumeNonce(key);
    await ticks(s, 1);
    // A lagging provider may not have the receipt yet: it waits before believing the nonce.
    expect((await row(a.txId)).status).toBe("unknown");
    clock += 31_000;
    await ticks(s, 1);
    expect(await row(a.txId)).toMatchObject({ status: "failed", reason_code: "NONCE_CONSUMED" });
    expect(chain.sent).toHaveLength(1);
    expect(await nextNonce()).toBe(1);
  });

  it("returns an unknown transaction a node still holds to submitted, then follows it to its receipt", async () => {
    const s = make();
    await s.createKey(AGENT);
    chain.mode = "timeout-pooled";
    const a = await s.submitSwap(AGENT, intent());
    await ticks(s, 1);
    expect((await row(a.txId)).status).toBe("submitted");
    await chain.mine(must(chain.sent[0]));
    await ticks(s, 1);
    expect(await statuses(a.txId)).toEqual([
      "accepted",
      "signed",
      "unknown",
      "submitted",
      "confirmed",
      "reconciled",
    ]);
    expect(chain.sent).toHaveLength(1);
  });

  it("marks a submitted transaction with no receipt in time unknown", async () => {
    const s = make();
    await s.createKey(AGENT);
    chain.mode = "timeout-pooled";
    const a = await s.submitSwap(AGENT, intent());
    await ticks(s, 1);
    expect((await row(a.txId)).status).toBe("submitted");
    clock += 61_000;
    chain.pool.clear();
    await ticks(s, 1);
    expect((await row(a.txId)).status).toBe("unknown");
  });

  it("treats a transaction signed by a process that stopped before broadcasting as unknown, never resent", async () => {
    const s = make();
    await s.createKey(AGENT);
    chain.mode = "crash";
    const a = await s.submitSwap(AGENT, intent());
    await ticks(s, 1);
    expect((await row(a.txId)).status).toBe("signed");
    chain.mode = "mine";
    const restarted = make();
    clock += 6_000;
    await ticks(restarted, 1);
    expect((await row(a.txId)).status).toBe("unknown");
    clock += 121_000;
    await ticks(restarted, 1);
    expect(await row(a.txId)).toMatchObject({ status: "failed", reason_code: "DROPPED" });
    expect(chain.sent).toHaveLength(0);
    expect(await nextNonce()).toBe(0);
  });

  it("keeps nonces across a restart: no reuse and no gap", async () => {
    const first = make();
    await first.createKey(AGENT);
    for (let i = 0; i < 2; i++) {
      await first.submitSwap(AGENT, intent());
      await ticks(first);
    }
    expect(await nextNonce()).toBe(2);
    const second = make();
    const c = await second.submitSwap(AGENT, intent());
    await ticks(second);
    expect(await row(c.txId)).toMatchObject({ status: "reconciled", nonce: 2 });
    expect(await nextNonce()).toBe(3);
    const nonces = (
      await db.selectFrom("platform.signer_outbox").select("nonce").orderBy("nonce").execute()
    ).map((r) => r.nonce);
    expect(nonces).toEqual([0, 1, 2]);
  });

  it("follows the chain when the key sent elsewhere (a refund), and waits for a lagging provider off the fork", async () => {
    const s = make();
    const key = await s.createKey(AGENT);
    chain.consumeNonce(key);
    chain.consumeNonce(key);
    const a = await s.submitSwap(AGENT, intent());
    await ticks(s);
    expect(await row(a.txId)).toMatchObject({ status: "reconciled", nonce: 2 });

    // Testnet: a provider that reports an older pending nonce is waited for, never trusted.
    const testnet = new FakeChain(10143, EXECUTOR);
    testnet.setBalance(USDC, ACCOUNT, 100_000_000n);
    const t1 = make({ environment: "testnet", chain: testnet });
    await t1.createKey(AGENT);
    const first = await t1.submitSwap(AGENT, intent({}, 10143n));
    await ticks(t1);
    expect(await row(first.txId)).toMatchObject({ status: "reconciled", nonce: 0 });
    testnet.pendingOverride = 0;
    const lagged = await t1.submitSwap(AGENT, intent({}, 10143n));
    await ticks(t1);
    expect((await row(lagged.txId)).status).toBe("accepted");
    testnet.pendingOverride = null;
    await ticks(t1);
    expect(await row(lagged.txId)).toMatchObject({ status: "reconciled", nonce: 1 });
    expect(await nextNonce(10143)).toBe(2);
  });

  it("sends one transaction per key at a time", async () => {
    const s = make();
    await s.createKey(AGENT);
    chain.mode = "timeout-pooled";
    const a = await s.submitSwap(AGENT, intent());
    const b = await s.submitSwap(AGENT, intent());
    await ticks(s);
    expect((await row(a.txId)).status).toBe("submitted");
    expect((await row(b.txId)).status).toBe("accepted");
    chain.mode = "mine";
    await chain.mine(must(chain.sent[0]));
    await ticks(s);
    expect(await row(b.txId)).toMatchObject({ status: "reconciled", nonce: 1 });
  });

  it("lets only the latest signer process use a key: an older one is fenced out", async () => {
    const old = make();
    await old.createKey(AGENT);
    await old.submitSwap(AGENT, intent());
    await ticks(old);
    const current = make();
    const b = await current.submitSwap(AGENT, intent());
    await ticks(current);
    expect(await row(b.txId)).toMatchObject({ status: "reconciled", nonce: 1 });
    const c = await old.submitSwap(AGENT, intent());
    await ticks(old);
    expect((await row(c.txId)).status).toBe("accepted");
    expect(logs.some((l) => l.includes("another signer process took over"))).toBe(true);
    await ticks(current);
    expect(await row(c.txId)).toMatchObject({ status: "reconciled", nonce: 2 });
  });

  it("converges duplicate requests for one action on the first", async () => {
    const s = make();
    await s.createKey(AGENT);
    const i = intent();
    const a = await s.submitSwap(AGENT, i);
    const b = await s.submitSwap(AGENT, i);
    expect(b).toMatchObject({ txId: a.txId, duplicate: true });
    expect(await db.selectFrom("platform.signer_outbox").select("tx_id").execute()).toHaveLength(1);
  });

  it("flags a reconciliation mismatch and writes nothing to the ledger", async () => {
    const s = make();
    await s.createKey(AGENT);
    chain.extraInDelta = 1n;
    const a = await s.submitSwap(AGENT, intent());
    await ticks(s);
    const r = await row(a.txId);
    expect(r).toMatchObject({
      status: "confirmed",
      reason_code: "RECONCILE_MISMATCH",
      ledger_entry_id: null,
    });
    expect(r.reason).toContain("the account's balance fell by 5000001, the event says 5000000");

    chain.extraInDelta = 0n;
    chain.dropEvent = true;
    const b = await s.submitSwap(AGENT, intent());
    await ticks(s);
    expect(await row(b.txId)).toMatchObject({
      status: "confirmed",
      reason_code: "RECONCILE_MISMATCH",
    });
    expect((await row(b.txId)).reason).toContain("no IntentExecuted event");
    expect(
      await db.selectFrom("platform.ledger_entries").select("entry_id").execute(),
    ).toHaveLength(0);
  });

  it("writes no key or seed into logs, errors, outbox rows or anything it prints", async () => {
    const s = make({ secrets: ["https://rpc.example/super-secret-key"] });
    await s.createKey(AGENT);
    await s.submitSwap(AGENT, intent());
    chain.mode = "timeout-lost";
    await s.submitSwap(AGENT, intent());
    await ticks(s);
    chain.simulation = {
      ok: false,
      code: "EXECUTOR_REVERTED",
      message: "via https://rpc.example/super-secret-key",
    };
    await s.submitSwap(AGENT, intent());
    await ticks(s);
    const rows = await db.selectFrom("platform.signer_outbox").selectAll().execute();
    const keys = await db.selectFrom("platform.signer_keys").selectAll().execute();
    const errors: string[] = [];
    await make({ keys: new LocalKeyProvider(SEED) })
      .accept(99, { chainId: 143143, to: EXECUTOR, data: "0x", value: 0n })
      .catch((e: Error) => errors.push(`${e.message} ${e.stack}`));
    const everything = [
      JSON.stringify(rows),
      JSON.stringify(keys),
      logs.join("\n"),
      errors.join("\n"),
      inspect(s, { depth: 6, showHidden: true }),
      JSON.stringify(await s.outbox()),
    ].join("\n");
    expect(errors[0]).toContain("has no session key");
    for (const secret of [SEED.slice(2), PRIVATE_KEY.slice(2), "super-secret-key"])
      expect(everything).not.toContain(secret);
  });

  describe("USDC transfers for credits (P2-U5 step 0, D-261)", () => {
    const OWNER = "0x00000000000000000000000000000000000a11ce" as Hex;
    const TREASURY = "0x0000000000000000000000000000000000007ea5" as Hex;
    let owner: Hex | null;
    const credits = (over: Partial<SignerOptions> = {}) =>
      make({ usdc: USDC, treasury: TREASURY, ownerOf: async () => owner, ...over });
    const fundKey = async (s: Signer, amount: bigint) =>
      chain.setBalance(USDC, must(await s.keyAddress(AGENT)), amount);

    beforeEach(() => {
      owner = OWNER;
    });

    it("refunds the agent's owner through the outbox, reconciled by the Transfer event", async () => {
      const s = credits();
      await s.createKey(AGENT);
      await fundKey(s, 10_000_000n);
      const r = await s.acceptTransfer(AGENT, {
        kind: "usdc_refund",
        to: OWNER,
        amount: 4_000_000n,
        actionKey: "refund:a",
      });
      expect(r).toMatchObject({ status: "accepted", duplicate: false });
      await ticks(s);
      expect(await statuses(r.txId)).toEqual([
        "accepted",
        "signed",
        "submitted",
        "confirmed",
        "reconciled",
      ]);
      const done = await row(r.txId);
      expect(done).toMatchObject({
        kind: "usdc_refund",
        gas_limit: "150000",
        ledger_entry_id: null,
      });
      expect(chain.balanceOf(USDC, OWNER)).toBe(4_000_000n);
      // The same action key is the same transfer.
      const again = await s.acceptTransfer(AGENT, {
        kind: "usdc_refund",
        to: OWNER,
        amount: 4_000_000n,
        actionKey: "refund:a",
      });
      expect(again).toMatchObject({ txId: r.txId, duplicate: true });
    });

    it("shares one nonce sequence with swaps: one transaction in flight per key", async () => {
      const s = credits();
      await s.createKey(AGENT);
      await fundKey(s, 10_000_000n);
      const swap = await s.submitSwap(AGENT, intent());
      const refund = await s.acceptTransfer(AGENT, {
        kind: "usdc_refund",
        to: OWNER,
        amount: 1_000_000n,
        actionKey: "refund:b",
      });
      await ticks(s, 4);
      expect((await row(swap.txId)).nonce).toBe(0);
      expect((await row(refund.txId)).nonce).toBe(1);
      expect((await row(refund.txId)).status).toBe("reconciled");
    });

    it("refuses a refund to anyone but the agent's current owner, before signing", async () => {
      const s = credits();
      await s.createKey(AGENT);
      const r = await s.acceptTransfer(AGENT, {
        kind: "usdc_refund",
        to: TREASURY,
        amount: 1n,
        actionKey: "refund:c",
      });
      expect(r).toMatchObject({ status: "failed", reasonCode: "RECIPIENT_NOT_ALLOWED" });
      expect(chain.sent).toHaveLength(0);
    });

    it("checks the owner again when it signs: a sale in between stops the refund", async () => {
      const s = credits();
      await s.createKey(AGENT);
      await fundKey(s, 10_000_000n);
      const r = await s.acceptTransfer(AGENT, {
        kind: "usdc_refund",
        to: OWNER,
        amount: 1_000_000n,
        actionKey: "refund:d",
      });
      owner = "0x0000000000000000000000000000000000000b0b";
      await ticks(s);
      expect(await row(r.txId)).toMatchObject({
        status: "failed",
        reason_code: "RECIPIENT_NOT_ALLOWED",
        nonce: null,
      });
      expect(chain.sent).toHaveLength(0);
    });

    it("pays settlements only to the treasury, and refuses them when none is configured", async () => {
      const s = credits();
      await s.createKey(AGENT);
      await fundKey(s, 10_000_000n);
      const ok = await s.acceptTransfer(AGENT, {
        kind: "usdc_settlement",
        to: TREASURY,
        amount: 2_000_000n,
        actionKey: "settle:1",
      });
      const wrong = await s.acceptTransfer(AGENT, {
        kind: "usdc_settlement",
        to: OWNER,
        amount: 2_000_000n,
        actionKey: "settle:2",
      });
      expect(wrong.reasonCode).toBe("RECIPIENT_NOT_ALLOWED");
      await ticks(s);
      expect((await row(ok.txId)).status).toBe("reconciled");
      expect(chain.balanceOf(USDC, TREASURY)).toBe(2_000_000n);
      const none = make({ usdc: USDC, ownerOf: async () => owner });
      const refused = await none.acceptTransfer(AGENT, {
        kind: "usdc_settlement",
        to: TREASURY,
        amount: 1n,
        actionKey: "settle:3",
      });
      expect(refused.reasonCode).toBe("RECIPIENT_NOT_ALLOWED");
    });

    it("refuses every transfer when it has no USDC address or no owner reader", async () => {
      const s = make();
      await s.createKey(AGENT);
      const r = await s.acceptTransfer(AGENT, {
        kind: "usdc_refund",
        to: OWNER,
        amount: 1n,
        actionKey: "refund:e",
      });
      expect(r.reasonCode).toBe("TARGET_NOT_ALLOWED");
      const noOwner = make({ usdc: USDC });
      const r2 = await noOwner.acceptTransfer(AGENT, {
        kind: "usdc_refund",
        to: OWNER,
        amount: 1n,
        actionKey: "refund:f",
      });
      expect(r2.reasonCode).toBe("RECIPIENT_NOT_ALLOWED");
    });

    it("records a transfer that would revert as TRANSFER_REVERTED, unsigned", async () => {
      const s = credits();
      await s.createKey(AGENT);
      chain.simulation = { ok: false, code: "EXECUTOR_REVERTED", message: "balance too low" };
      const r = await s.acceptTransfer(AGENT, {
        kind: "usdc_refund",
        to: OWNER,
        amount: 1_000_000n,
        actionKey: "refund:g",
      });
      await ticks(s);
      expect(await row(r.txId)).toMatchObject({
        status: "failed",
        reason_code: "TRANSFER_REVERTED",
      });
      expect(chain.sent).toHaveLength(0);
    });

    it("resolves a lost refund broadcast by hash, never sending it twice", async () => {
      const s = credits();
      await s.createKey(AGENT);
      await fundKey(s, 10_000_000n);
      chain.mode = "timeout-landed";
      const r = await s.acceptTransfer(AGENT, {
        kind: "usdc_refund",
        to: OWNER,
        amount: 3_000_000n,
        actionKey: "refund:h",
      });
      await ticks(s, 4);
      expect(await statuses(r.txId)).toContain("unknown");
      expect((await row(r.txId)).status).toBe("reconciled");
      expect(chain.sent).toHaveLength(1);
      expect(chain.balanceOf(USDC, OWNER)).toBe(3_000_000n);
    });
  });
});
