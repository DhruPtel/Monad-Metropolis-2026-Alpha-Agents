import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import type { Hex } from "viem";
import type { HDAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryGateway } from "../gateway-admin.ts";
import { Redactor } from "../secrets.ts";
import { Store } from "../store.ts";
import { CHAIN, indexAgent, must } from "../testing.ts";
import { FundingKeys, ensureFundingAddresses, fundingAddressOf } from "./funding.ts";
import { Ledger } from "./ledger.ts";
import { type RefundChain, RefundOpenError, RefundService } from "./refunds.ts";
import { CreditService } from "./service.ts";

const dbUp = await databaseAvailable();
const OWNER = "0x00000000000000000000000000000000000a11ce" as Hex;
const BUYER = "0x0000000000000000000000000000000000000b0b" as Hex;

/** A chain that records transfers: ownership and balances are set by the test. */
class FakeChain implements RefundChain {
  owner: Hex = OWNER;
  epoch = 0n;
  balances = new Map<string, bigint>();
  broadcasts: Hex[] = [];
  revert = false;
  signed: { from: Hex; to: Hex; amount: bigint }[] = [];

  async ownership() {
    return { owner: this.owner, epoch: this.epoch };
  }
  async usdcBalance(address: Hex) {
    return this.balances.get(address.toLowerCase()) ?? 0n;
  }
  async signTransfer(account: HDAccount, to: Hex, amount: bigint) {
    this.signed.push({ from: account.address, to, amount });
    const n = this.signed.length.toString(16).padStart(64, "0");
    return { raw: `0xf0${n}` as Hex, hash: `0x${n}` as Hex };
  }
  async broadcast(raw: Hex) {
    this.broadcasts.push(raw);
  }
  async receipt() {
    return !this.revert;
  }
}

describe.skipIf(!dbUp)("refunds (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let store: Store;
  let ledger: Ledger;
  let chain: FakeChain;
  let refunds: RefundService;
  let credits: CreditService;
  const keys = new FundingKeys(`0x${"5e".repeat(32)}`);
  const redactor = new Redactor();

  beforeAll(async () => {
    t = await createTestDatabase("orch_refunds");
    store = new Store(t.db);
    ledger = new Ledger(t.db);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  beforeEach(async () => {
    for (const table of [
      "platform.refunds",
      "platform.ledger_lines",
      "platform.ledger_entries",
      "platform.funding_addresses",
      "indexer.usdc_transfers",
      "indexer.agents",
    ] as const)
      await t.db.deleteFrom(table).execute();
    chain = new FakeChain();
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
    refunds = new RefundService({
      store,
      ledger,
      credits,
      keys,
      chain,
      chainId: CHAIN,
      environment: "fork",
      redactor,
      log: () => undefined,
    });
    await indexAgent(t.db, 1, "base", OWNER);
    await ensureFundingAddresses(store, keys, CHAIN);
  });

  const fund = async (amount: bigint, n = 1) => {
    const address = must(await fundingAddressOf(store, CHAIN, 1));
    await t.db
      .insertInto("indexer.usdc_transfers")
      .values({
        chain_id: CHAIN,
        block_number: 100 + n,
        block_hash: `0x${n.toString(16).padStart(64, "0")}`,
        tx_hash: `0x${(n + 1000).toString(16).padStart(64, "0")}`,
        log_index: 0,
        from_address: OWNER,
        to_address: address,
        value: amount.toString(),
        agent_id: 1,
        direction: "in",
        account: "funding",
      })
      .execute();
    chain.balances.set(address, (chain.balances.get(address) ?? 0n) + amount);
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

  it("returns credits and held deposits to the current owner, once", async () => {
    await fund(45_000_000n, 1);
    await fund(10_000_000n, 2); // 5 credited, 5 held above the cap
    const id = await refunds.request(1, OWNER, 0n, "owner");
    await refunds.tick();
    await refunds.tick();
    const r = await status(id);
    expect(r).toMatchObject({
      status: "sent",
      credits_usdc_e6: "50000000",
      held_usdc_e6: "5000000",
    });
    expect(chain.signed).toEqual([{ from: keys.address(1), to: OWNER, amount: 55_000_000n }]);
    expect(chain.broadcasts).toHaveLength(1);
    const c = await credits.creditsOf(1);
    expect(c).toMatchObject({ credits: 0n, held: 0n, fundingAddress: 0n, restricted: true });
    expect(await ledger.balanced(CHAIN)).toBe(true);
  });

  it("refuses a request made under a stale ownership epoch", async () => {
    await fund(5_000_000n);
    const id = await refunds.request(1, OWNER, 0n, "owner");
    chain.epoch = 2n; // the agent went through the escrow and back
    await refunds.tick();
    expect(await status(id)).toMatchObject({ status: "refused" });
    expect((await status(id)).reason).toMatch(/^stale_epoch/);
    expect(chain.signed).toEqual([]);
    expect((await credits.creditsOf(1)).credits).toBe(5_000_000n);
  });

  it("refuses when the agent has a new owner, so the credits stay with the agent", async () => {
    await fund(5_000_000n);
    const id = await refunds.request(1, OWNER, 0n, "owner");
    chain.owner = BUYER;
    chain.epoch = 1n;
    await refunds.tick();
    expect((await status(id)).reason).toMatch(/^not_owner/);
    expect((await credits.creditsOf(1)).credits).toBe(5_000_000n);
    // The buyer can refund them.
    const mine = await refunds.request(1, BUYER, 1n, "owner");
    await refunds.tick();
    expect(await status(mine)).toMatchObject({ status: "sent" });
    expect(must(chain.signed[0]).to).toBe(BUYER);
  });

  it("allows one open refund per agent, and refuses one with nothing to refund", async () => {
    await refunds.request(1, OWNER, 0n, "owner");
    await expect(refunds.request(1, OWNER, 0n, "console")).rejects.toBeInstanceOf(RefundOpenError);
    await refunds.tick();
    const [r] = await t.db.selectFrom("platform.refunds").selectAll().execute();
    expect(must(r).reason).toMatch(/^nothing_to_refund/);
  });

  it("restores the ledger when the transfer reverts", async () => {
    await fund(5_000_000n);
    chain.revert = true;
    const id = await refunds.request(1, OWNER, 0n, "owner");
    await refunds.tick();
    expect(await status(id)).toMatchObject({
      status: "failed",
      reason: "the refund transfer reverted",
    });
    expect((await credits.creditsOf(1)).credits).toBe(5_000_000n);
    expect(await ledger.balanced(CHAIN)).toBe(true);
  });

  it("after a crash between signing and confirming, rebroadcasts the same transaction", async () => {
    await fund(5_000_000n);
    const id = await refunds.request(1, OWNER, 0n, "owner");
    let first = true;
    chain.receipt = async () => {
      if (first) {
        first = false;
        throw new Error("the process stopped here");
      }
      return true;
    };
    await refunds.tick(); // signs, broadcasts, then "crashes" waiting
    expect(await status(id)).toMatchObject({ status: "signed" });
    await refunds.tick(); // a new pass picks it up
    expect(await status(id)).toMatchObject({ status: "sent" });
    expect(chain.signed).toHaveLength(1);
    expect(chain.broadcasts).toHaveLength(2);
    expect(new Set(chain.broadcasts).size).toBe(1);
    expect((await credits.creditsOf(1)).credits).toBe(0n);
  });

  it("refuses when the funding address holds less than the ledger owes", async () => {
    await fund(5_000_000n);
    chain.balances.clear();
    const id = await refunds.request(1, OWNER, 0n, "owner");
    await refunds.tick();
    expect(await status(id)).toMatchObject({ status: "failed" });
    expect(chain.signed).toEqual([]);
  });
});
