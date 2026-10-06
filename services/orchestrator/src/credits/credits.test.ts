import { CREDIT_CAP_USDC_E6, keyBudgetUsd } from "@alpha-agents/accounting";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryGateway } from "../gateway-admin.ts";
import { LeaseManager } from "../leases.ts";
import { Provisioner } from "../provisioner.ts";
import { MemoryProvider } from "../sandbox.ts";
import { Redactor } from "../secrets.ts";
import { Store } from "../store.ts";
import { CHAIN, indexAgent, must } from "../testing.ts";
import { FundingKeys, ensureFundingAddresses, fundingAddressOf, fundingPath } from "./funding.ts";
import { Ledger } from "./ledger.ts";
import { CreditService } from "./service.ts";

const dbUp = await databaseAvailable();
const SEED = `0x${"5e".repeat(32)}` as const;
const SECRET = "test-orchestrator-secret-0123456789abcdef";
const USDC = (n: number) => BigInt(Math.round(n * 1e6));

describe.skipIf(!dbUp)("credits (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let store: Store;
  let ledger: Ledger;
  let gateway: MemoryGateway;
  let credits: CreditService;
  let provisioner: Provisioner;
  const keys = new FundingKeys(SEED);
  const redactor = new Redactor();
  const lines: string[] = [];
  let log = 0;

  beforeAll(async () => {
    t = await createTestDatabase("orch_credits");
    store = new Store(t.db);
    ledger = new Ledger(t.db);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  beforeEach(async () => {
    for (const table of [
      "platform.usage_receipts",
      "platform.ledger_lines",
      "platform.ledger_entries",
      "platform.funding_addresses",
      "platform.agent_runtimes",
      "indexer.usdc_transfers",
      "indexer.agents",
    ] as const)
      await t.db.deleteFrom(table).execute();
    gateway = new MemoryGateway();
    const say = (l: string) => lines.push(redactor.redact(l));
    const leases = new LeaseManager({
      store,
      provider: new MemoryProvider(),
      namespace: "unit",
      runTag: "r",
      redactor,
      log: say,
    });
    credits = new CreditService({
      store,
      ledger,
      gateway,
      chainId: CHAIN,
      environment: "fork",
      keyOf: (rt) => provisioner.virtualKey(rt),
      redactor,
      log: say,
    });
    provisioner = new Provisioner({
      store,
      gateway,
      leases,
      namespace: "unit",
      secret: SECRET,
      redactor,
      log: say,
      startingBudgetUsd: 1,
      credits,
    });
  });

  /** A USDC transfer into the agent's funding address, as the indexer records it. */
  const deposit = async (
    agentId: number,
    amount: bigint,
    block = 100 + log,
    hash = `0x${"b".repeat(63)}${log % 10}`,
  ) => {
    log += 1;
    const address = must(await fundingAddressOf(store, CHAIN, agentId));
    await t.db
      .insertInto("indexer.usdc_transfers")
      .values({
        chain_id: CHAIN,
        block_number: block,
        block_hash: hash,
        tx_hash: `0x${log.toString(16).padStart(64, "0")}`,
        log_index: 0,
        from_address: "0x00000000000000000000000000000000000f00d5",
        to_address: address,
        value: amount.toString(),
        agent_id: agentId,
        direction: "in",
        account: "funding",
      })
      .execute();
  };
  const ready = async (agentId: number, tier: "base" | "pro" = "base") => {
    await indexAgent(t.db, agentId, tier);
    await ensureFundingAddresses(store, keys, CHAIN);
  };

  it("derives one funding address per agent, deterministically, and records it", async () => {
    await indexAgent(t.db, 1, null);
    await indexAgent(t.db, 2, null);
    expect(await ensureFundingAddresses(store, keys, CHAIN)).toBe(2);
    expect(await ensureFundingAddresses(store, keys, CHAIN)).toBe(0);
    const a = must(await fundingAddressOf(store, CHAIN, 1));
    expect(a).toBe(new FundingKeys(SEED).address(1).toLowerCase());
    expect(a).not.toBe(must(await fundingAddressOf(store, CHAIN, 2)));
    expect(fundingPath(7)).toBe("m/44'/60'/0'/0/7");
    expect(new FundingKeys(`0x${"6f".repeat(32)}`).address(1)).not.toBe(keys.address(1));
  });

  it("credits a deposit once, with no other step, and the ledger balances", async () => {
    await ready(1);
    await deposit(1, USDC(10));
    expect(await credits.creditDeposits()).toEqual([1]);
    expect(await credits.creditDeposits()).toEqual([]);
    const c = await credits.creditsOf(1);
    expect(c).toMatchObject({
      credits: USDC(10),
      spendable: USDC(10),
      held: 0n,
      restricted: false,
    });
    expect(c.fundingAddress).toBe(USDC(10));
    expect(await ledger.balanced(CHAIN)).toBe(true);
  });

  it("holds and flags the part of a deposit above the cap (A-28)", async () => {
    await ready(1);
    await deposit(1, USDC(45));
    await deposit(1, USDC(20));
    await credits.creditDeposits();
    const c = await credits.creditsOf(1);
    expect(c.credits).toBe(CREDIT_CAP_USDC_E6);
    expect(c.held).toBe(USDC(15));
    expect(c.fundingAddress).toBe(USDC(65));
    const flagged = await t.db
      .selectFrom("platform.ledger_entries")
      .select(["kind", "source"])
      .where("kind", "=", "deposit_held")
      .execute();
    expect(flagged).toHaveLength(1);
    expect(must(flagged[0]).source).toMatchObject({ heldUsdcE6: "15000000" });
    expect(lines.some((l) => /15000000 held above the cap and flagged/.test(l))).toBe(true);
  });

  it("reverses a credited deposit that a reorg removed, and credits it again if it returns", async () => {
    await ready(1);
    await deposit(1, USDC(3), 200, `0x${"c".repeat(64)}`);
    await credits.creditDeposits();
    const row = must(
      await t.db.selectFrom("indexer.usdc_transfers").selectAll().executeTakeFirst(),
    );
    await t.db.deleteFrom("indexer.usdc_transfers").execute();
    expect(await credits.reverseOrphanDeposits()).toEqual([1]);
    expect(await credits.reverseOrphanDeposits()).toEqual([]);
    expect((await credits.creditsOf(1)).credits).toBe(0n);
    // The same transfer mined again in another block is a new deposit.
    await t.db
      .insertInto("indexer.usdc_transfers")
      .values({ ...row, block_number: 201, block_hash: `0x${"d".repeat(64)}` })
      .execute();
    await credits.creditDeposits();
    expect((await credits.creditsOf(1)).credits).toBe(USDC(3));
    expect(await ledger.balanced(CHAIN)).toBe(true);
  });

  it("gives a new key the budget its credits buy, and zero with no credits", async () => {
    await ready(1);
    await provisioner.provision({ chainId: CHAIN, agentId: 1 });
    const rt = must(await store.runtime({ chainId: CHAIN, agentId: 1 }));
    expect(must(gateway.keys.get(rt.keyAlias)).maxBudgetUsd).toBe(0);
    expect((await credits.creditsOf(1)).restricted).toBe(true);
    await deposit(1, USDC(5));
    await credits.tick();
    const key = must(
      provisioner.virtualKey(must(await store.runtime({ chainId: CHAIN, agentId: 1 }))),
    );
    expect(gateway.budgets.get(key)).toBe(4); // 5 USDC buys 4 USD of provider cost at +25%
  });

  it("meters each costed request once, debits credits and keeps the key's headroom equal to them", async () => {
    await ready(1);
    await deposit(1, USDC(1));
    await credits.creditDeposits();
    await provisioner.provision({ chainId: CHAIN, agentId: 1 });
    const key = must(
      provisioner.virtualKey(must(await store.runtime({ chainId: CHAIN, agentId: 1 }))),
    );
    gateway.logCall(key, "req-1", 0.00448); // the H-10 call's real cost
    gateway.logCall(key, "req-2", 0); // a refused call costs nothing
    await credits.tick();
    await credits.tick();
    const c = await credits.creditsOf(1);
    expect(c.credits).toBe(USDC(1) - 5_600n);
    expect(c.unsettled).toBe(5_600n);
    const receipts = await t.db.selectFrom("platform.usage_receipts").selectAll().execute();
    expect(receipts.map((r) => [r.request_id, r.provider_picos, r.charge_usdc_e6])).toEqual([
      ["req-1", "4480000000", "5600"],
    ]);
    // Budget = metered spend + what the rest buys.
    expect(gateway.budgets.get(key)).toBe(
      Math.floor(keyBudgetUsd(4_480_000_000n, c.credits) * 1e6) / 1e6,
    );
    expect(await ledger.balanced(CHAIN)).toBe(true);
  });

  it("restricts at zero: the budget stops at what was spent, an overshoot is filled by the next deposit", async () => {
    await ready(1);
    await deposit(1, 4_000n);
    await credits.creditDeposits();
    await provisioner.provision({ chainId: CHAIN, agentId: 1 });
    const key = must(
      provisioner.virtualKey(must(await store.runtime({ chainId: CHAIN, agentId: 1 }))),
    );
    gateway.logCall(key, "req-1", 0.00448); // costs 5,600: more than the 4,000 left
    await credits.tick();
    let c = await credits.creditsOf(1);
    expect(c.credits).toBe(-1_600n);
    expect(c).toMatchObject({ spendable: 0n, restricted: true });
    expect(gateway.budgets.get(key)).toBe(0.00448);
    await deposit(1, USDC(1));
    await credits.tick();
    c = await credits.creditsOf(1);
    expect(c.credits).toBe(USDC(1) - 1_600n);
    expect(c.restricted).toBe(false);
  });

  it("meters a key's last calls before a reset deletes it", async () => {
    await ready(1);
    await deposit(1, USDC(1));
    await credits.creditDeposits();
    await provisioner.provision({ chainId: CHAIN, agentId: 1 });
    const key = must(
      provisioner.virtualKey(must(await store.runtime({ chainId: CHAIN, agentId: 1 }))),
    );
    gateway.logCall(key, "req-last", 0.001);
    await provisioner.reset({ chainId: CHAIN, agentId: 1 });
    expect((await credits.creditsOf(1)).unsettled).toBe(1_250n);
    const rt = must(await store.runtime({ chainId: CHAIN, agentId: 1 }));
    expect(rt.generation).toBe(2);
    expect(must(gateway.keys.get(rt.keyAlias)).maxBudgetUsd).toBe(
      Math.floor(keyBudgetUsd(0n, USDC(1) - 1_250n) * 1e6) / 1e6,
    );
  });
});
