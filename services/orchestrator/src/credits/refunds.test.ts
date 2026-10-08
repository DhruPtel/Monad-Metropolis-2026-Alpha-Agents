import { randomUUID } from "node:crypto";
import { usageEntry } from "@alpha-agents/accounting";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { LocalKeyProvider, Signer } from "@alpha-agents/signer";
import { FakeChain as SignerChain } from "@alpha-agents/signer/testing";
import type { Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryGateway } from "../gateway-admin.ts";
import { Redactor } from "../secrets.ts";
import { Store } from "../store.ts";
import { CHAIN, indexAgent, must } from "../testing.ts";
import { FundingKeys, ensureFundingAddresses, fundingAddressOf } from "./funding.ts";
import { Ledger } from "./ledger.ts";
import { type RefundChain, RefundOpenError, RefundService, type RefundSigner } from "./refunds.ts";
import { CreditService } from "./service.ts";

/**
 * Refunds through the signer's outbox (D-210, D-242, D-261): a real Signer on
 * the signer package's fake chain, so the refund, the ledger entry, the
 * outbox row, the fenced nonce and the Transfer reconciliation run together.
 */
const dbUp = await databaseAvailable();
const OWNER = "0x00000000000000000000000000000000000a11ce" as Hex;
const BUYER = "0x0000000000000000000000000000000000000b0b" as Hex;
const EXECUTOR = "0x570575BC185d1B0aE93F641479fdEdDf76b91fdB" as Hex;
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Hex;
const SEED = `0x${"5e".repeat(32)}` as Hex;

/** Ownership and the funding address's balance, as the refund service reads them. */
class FakeChain implements RefundChain {
  owner: Hex = OWNER;
  epoch = 0n;
  balances = new Map<string, bigint>();
  broadcasts: Hex[] = [];
  revert = false;

  async ownership() {
    return { owner: this.owner, epoch: this.epoch };
  }
  async usdcBalance(address: Hex) {
    return this.balances.get(address.toLowerCase()) ?? 0n;
  }
  async broadcast(raw: Hex) {
    this.broadcasts.push(raw);
  }
  async receipt() {
    return !this.revert;
  }
}

describe.skipIf(!dbUp)("refunds through the signer (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let store: Store;
  let ledger: Ledger;
  let chain: FakeChain;
  let signerChain: SignerChain;
  let signer: Signer;
  let refunds: RefundService;
  let credits: CreditService;
  const keys = new FundingKeys(SEED);
  const redactor = new Redactor();

  beforeAll(async () => {
    t = await createTestDatabase("orch_refunds");
    store = new Store(t.db);
    ledger = new Ledger(t.db);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  const service = (s: RefundSigner | null) =>
    new RefundService({
      store,
      ledger,
      credits,
      keys,
      chain,
      signer: s,
      chainId: CHAIN,
      environment: "fork",
      redactor,
      log: () => undefined,
    });

  beforeEach(async () => {
    for (const table of [
      "platform.refunds",
      "platform.signer_outbox",
      "platform.signer_keys",
      "platform.ledger_lines",
      "platform.ledger_entries",
      "platform.funding_addresses",
      "indexer.usdc_transfers",
      "indexer.agents",
    ] as const)
      await t.db.deleteFrom(table).execute();
    chain = new FakeChain();
    signerChain = new SignerChain(CHAIN, EXECUTOR);
    signer = new Signer({
      db: t.db,
      environment: "local",
      chain: signerChain,
      keys: new LocalKeyProvider(SEED),
      executor: EXECUTOR,
      usdc: USDC,
      ownerOf: async () => chain.owner,
      assets: { [USDC.toLowerCase()]: "USDC" },
    });
    credits = new CreditService({
      store,
      ledger,
      gateway: new MemoryGateway(),
      chainId: CHAIN,
      environment: "fork",
      keyOf: () => null,
      redactor,
      log: () => undefined,
    });
    refunds = service(signer);
    await indexAgent(t.db, 1, "base", OWNER);
    await ensureFundingAddresses(store, keys, CHAIN);
    // The session key is the funding address (D-243): one key, one nonce sequence.
    expect((await signer.createKey(1)).toLowerCase()).toBe(keys.address(1).toLowerCase());
  });

  const fund = async (amount: bigint, n = 1, from: Hex = OWNER) => {
    const address = must(await fundingAddressOf(store, CHAIN, 1));
    await t.db
      .insertInto("indexer.usdc_transfers")
      .values({
        chain_id: CHAIN,
        block_number: 100 + n,
        block_hash: `0x${n.toString(16).padStart(64, "0")}`,
        tx_hash: `0x${(n + 1000).toString(16).padStart(64, "0")}`,
        log_index: 0,
        from_address: from,
        to_address: address,
        value: amount.toString(),
        agent_id: 1,
        direction: "in",
        account: "funding",
      })
      .execute();
    chain.balances.set(address, (chain.balances.get(address) ?? 0n) + amount);
    signerChain.setBalance(
      USDC,
      address as Hex,
      signerChain.balanceOf(USDC, address as Hex) + amount,
    );
    await credits.creditDeposits();
  };
  const status = async (id: string) =>
    must(
      await t.db
        .selectFrom("platform.refunds")
        .selectAll()
        .where("refund_id", "=", id)
        .executeTakeFirst(),
    );
  const outbox = () =>
    t.db.selectFrom("platform.signer_outbox").selectAll().orderBy("created_at").execute();
  /** A refund pass, then the signer's passes, then a refund pass to follow the outcome. */
  const step = async () => {
    await refunds.tick();
    for (let i = 0; i < 4; i++) await signer.tick();
    await refunds.tick();
  };

  it("returns credits and held deposits to the current owner, once, through the outbox", async () => {
    await fund(45_000_000n, 1);
    await fund(10_000_000n, 2); // 5 credited, 5 held above the cap
    const id = await refunds.request(1, OWNER, 0n, "owner");
    await step();
    await step();
    const r = await status(id);
    expect(r).toMatchObject({
      status: "sent",
      credits_usdc_e6: "50000000",
      held_usdc_e6: "5000000",
      raw_tx: null,
    });
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(must(rows[0])).toMatchObject({
      tx_id: r.signer_tx_id,
      kind: "usdc_refund",
      action_id: `refund:${id}`,
      status: "reconciled",
      tx_hash: r.tx_hash,
      key_address: keys.address(1).toLowerCase(),
    });
    expect(signerChain.balanceOf(USDC, OWNER)).toBe(55_000_000n);
    const c = await credits.creditsOf(1);
    expect(c).toMatchObject({ credits: 0n, held: 0n, fundingAddress: 0n, restricted: true });
    expect(await ledger.balanced(CHAIN)).toBe(true);
  });

  it("refuses a request made under a stale ownership epoch", async () => {
    await fund(5_000_000n);
    const id = await refunds.request(1, OWNER, 0n, "owner");
    chain.epoch = 2n; // the agent went through the escrow and back
    await step();
    expect(await status(id)).toMatchObject({ status: "refused" });
    expect((await status(id)).reason).toMatch(/^stale_epoch/);
    expect(await outbox()).toEqual([]);
    expect((await credits.creditsOf(1)).credits).toBe(5_000_000n);
  });

  it("refuses when the agent has a new owner, so the credits stay with the agent", async () => {
    await fund(5_000_000n);
    const id = await refunds.request(1, OWNER, 0n, "owner");
    chain.owner = BUYER;
    chain.epoch = 1n;
    await step();
    expect((await status(id)).reason).toMatch(/^not_owner/);
    expect((await credits.creditsOf(1)).credits).toBe(5_000_000n);
    // D-242: the buyer contributed nothing, so its own share is nothing; the credits stay.
    const mine = await refunds.request(1, BUYER, 1n, "owner");
    await step();
    expect((await status(mine)).reason).toMatch(/^nothing_to_refund/);
    expect(await outbox()).toEqual([]);
    expect((await credits.creditsOf(1)).credits).toBe(5_000_000n);
  });

  it("refunds only the owner's own share, and leaves every other contributor's share intact (D-242)", async () => {
    const FAN = "0x00000000000000000000000000000000000000fa" as Hex;
    await fund(3_000_000n, 1, OWNER);
    await fund(7_000_000n, 2, FAN);
    const id = await refunds.request(1, OWNER, 0n, "owner");
    await step();
    expect(await status(id)).toMatchObject({
      status: "sent",
      credits_usdc_e6: "3000000",
      contribution_basis_usdc_e6: "3000000",
    });
    expect(signerChain.balanceOf(USDC, OWNER)).toBe(3_000_000n);
    expect((await credits.creditsOf(1)).credits).toBe(7_000_000n);
    // Nothing more for the owner until it contributes again.
    const again = await refunds.request(1, OWNER, 0n, "owner");
    await step();
    expect((await status(again)).reason).toMatch(/^nothing_to_refund/);
    // A new contribution earns a share of what is left: 1 of the 8 remaining weight.
    await fund(1_000_000n, 3, OWNER);
    const third = await refunds.request(1, OWNER, 0n, "owner");
    await step();
    expect(await status(third)).toMatchObject({ status: "sent", credits_usdc_e6: "1000000" });
    expect((await credits.creditsOf(1)).credits).toBe(7_000_000n);
    // Two refunds, two nonces in order from the one key.
    expect((await outbox()).map((r) => r.nonce)).toEqual([0, 1]);
  });

  it("shares spending in proportion: after spending, the owner gets its share of what is left", async () => {
    const FAN = "0x00000000000000000000000000000000000000fa" as Hex;
    await fund(2_000_000n, 1, OWNER);
    await fund(6_000_000n, 2, FAN);
    // Half the credits are spent: 4 USDC of usage against the agent.
    await ledger.post(
      usageEntry(
        { environment: "fork", entryId: randomUUID(), occurredAt: 1, agentId: 1 },
        4_000_000n,
      ),
      { chainId: CHAIN, agentId: 1, idempotencyKey: "usage:test", source: { kind: "test" } },
    );
    expect((await credits.creditsOf(1)).credits).toBe(4_000_000n);
    const id = await refunds.request(1, OWNER, 0n, "owner");
    await step();
    // 2 of 8 contributed: a quarter of the 4 left.
    expect(must((await outbox())[0]).intent).toMatchObject({ amount: "1000000" });
    expect(await status(id)).toMatchObject({ status: "sent" });
  });

  it("allows one open refund per agent, and refuses one with nothing to refund", async () => {
    await refunds.request(1, OWNER, 0n, "owner");
    await expect(refunds.request(1, OWNER, 0n, "console")).rejects.toBeInstanceOf(RefundOpenError);
    await step();
    const [r] = await t.db.selectFrom("platform.refunds").selectAll().execute();
    expect(must(r).reason).toMatch(/^nothing_to_refund/);
  });

  it("restores the ledger when the transfer reverts on chain", async () => {
    await fund(5_000_000n);
    signerChain.revertNext = "REVERT";
    const id = await refunds.request(1, OWNER, 0n, "owner");
    await step();
    const r = await status(id);
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/^TRANSFER_REVERTED/);
    expect((await credits.creditsOf(1)).credits).toBe(5_000_000n);
    expect(await ledger.balanced(CHAIN)).toBe(true);
  });

  it("a lost broadcast is unknown, not failed: it resolves by hash and pays once", async () => {
    await fund(5_000_000n);
    signerChain.mode = "timeout-landed";
    const id = await refunds.request(1, OWNER, 0n, "owner");
    await step();
    await step();
    expect(await status(id)).toMatchObject({ status: "sent" });
    const [row] = await outbox();
    expect((must(row).history as { status: string }[]).map((h) => h.status)).toContain("unknown");
    expect(signerChain.sent).toHaveLength(1);
    expect(signerChain.balanceOf(USDC, OWNER)).toBe(5_000_000n);
    expect((await credits.creditsOf(1)).credits).toBe(0n);
  });

  it("records the agent's session key itself when the signer has none yet (live run, L-120)", async () => {
    await fund(5_000_000n);
    await t.db.deleteFrom("platform.signer_keys").execute();
    const id = await refunds.request(1, OWNER, 0n, "owner");
    await step();
    expect(await status(id)).toMatchObject({ status: "sent" });
    const [key] = await t.db.selectFrom("platform.signer_keys").selectAll().execute();
    expect(key?.address).toBe(keys.address(1).toLowerCase());
  });

  it("commits the ledger entry and the outbox row together: a signer error leaves neither", async () => {
    await fund(5_000_000n);
    refunds = service({
      acceptTransfer: async () => {
        throw new Error("the signer failed");
      },
      transaction: async () => undefined,
    });
    const id = await refunds.request(1, OWNER, 0n, "owner");
    await refunds.tick();
    expect(await status(id)).toMatchObject({ status: "requested", signer_tx_id: null });
    expect(await outbox()).toEqual([]);
    expect((await credits.creditsOf(1)).credits).toBe(5_000_000n);
    expect(await ledger.balanced(CHAIN)).toBe(true);
  });

  it("waits, signing nothing, while the signer is off", async () => {
    await fund(5_000_000n);
    refunds = service(null);
    const id = await refunds.request(1, OWNER, 0n, "owner");
    await refunds.tick();
    expect(await status(id)).toMatchObject({ status: "requested" });
    expect((await credits.creditsOf(1)).credits).toBe(5_000_000n);
  });

  it("finishes a refund signed before D-261 by rebroadcasting its own transaction", async () => {
    await fund(5_000_000n);
    const id = await refunds.request(1, OWNER, 0n, "owner");
    await t.db
      .updateTable("platform.refunds")
      .set({ status: "signed", raw_tx: "0xf0aa", tx_hash: `0x${"aa".repeat(32)}` })
      .where("refund_id", "=", id)
      .execute();
    await refunds.tick();
    expect(await status(id)).toMatchObject({ status: "sent", signer_tx_id: null });
    expect(chain.broadcasts).toEqual(["0xf0aa"]);
    expect(await outbox()).toEqual([]);
  });

  it("refuses when the funding address holds less than the ledger owes", async () => {
    await fund(5_000_000n);
    chain.balances.clear();
    const id = await refunds.request(1, OWNER, 0n, "owner");
    await step();
    expect(await status(id)).toMatchObject({ status: "failed" });
    expect(await outbox()).toEqual([]);
  });
});
