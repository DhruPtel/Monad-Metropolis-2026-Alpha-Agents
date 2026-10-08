import type { AgentState, ChainReader, MarketState } from "@alpha-agents/chain-tools";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { sql } from "@alpha-agents/db";
import { INTENT_STATES } from "@alpha-agents/domain";
import { LAUNCH_EXECUTOR_POLICY, LAUNCH_POLICY_HASH } from "@alpha-agents/policy";
import { connectClient, structured } from "@alpha-agents/tool-server/testing";
import type { Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FundingKeys, ensureFundingAddresses, fundingAddressOf } from "../credits/funding.ts";
import { Ledger } from "../credits/ledger.ts";
import { CreditService } from "../credits/service.ts";
import { type Gate, GATE_HEADER, startGate } from "../gate.ts";
import { gateResolver } from "../gate-resolver.ts";
import { MemoryGateway } from "../gateway-admin.ts";
import { LeaseManager } from "../leases.ts";
import { Narrator, type NarratorModel } from "../narrator.ts";
import { Provisioner } from "../provisioner.ts";
import { MemoryProvider } from "../sandbox.ts";
import { Redactor } from "../secrets.ts";
import { Store } from "../store.ts";
import { CHAIN, indexAgent, must } from "../testing.ts";
import { PgChainCallLog, PgIntentStore } from "./chain-store.ts";
import { type ToolServers, startToolServers } from "./servers.ts";

/**
 * The chain tools behind the real gate with the Postgres stores and the
 * narrator (P2-U5): identity from the injected token, the action log, intents
 * kept per agent with idempotency, the open limit and expiry, and one activity
 * entry per proposal held to the number validator.
 */
const dbUp = await databaseAvailable();
const SEED = `0x${"5e".repeat(32)}` as const;
const SECRET = "test-orchestrator-secret-0123456789abcdef";
const NOW = 1_790_000_000n;
const PX = 25_000_000_000_000_000n;

class FakeReader implements ChainReader {
  readonly chainId = CHAIN;
  reads: number[] = [];
  async market(): Promise<MarketState> {
    return {
      chainId: CHAIN,
      block: 500n,
      timestamp: NOW,
      policy: { ...LAUNCH_EXECUTOR_POLICY },
      policyHash: LAUNCH_POLICY_HASH,
      paused: false,
      wmonBuyable: true,
      monUsd: { priceE18: PX, updatedAt: NOW - 20n, reason: "OK" },
      usdcUsd: { priceE18: 10n ** 18n, updatedAt: NOW - 600n, reason: "OK" },
      pool: { priceE18: PX, reason: "OK" },
      deviationBps: 0n,
      tradableReason: "OK",
      venue: null,
    };
  }
  async agent(agentId: number): Promise<AgentState> {
    this.reads.push(agentId);
    return {
      block: 500n,
      timestamp: NOW,
      owner: "0x00000000000000000000000000000000000a11ce",
      ownerEpoch: 0n,
      configEpoch: 0n,
      account: `0x00000000000000000000000000000000000ac00${agentId}` as Hex,
      usdc: 70_000_000n,
      wmon: (30_000_000n * 10n ** 30n) / PX,
      mode: "NORMAL",
      breaker: { nav: 100_000_000n, perUnit: 10n ** 18n, peak: 10n ** 18n, drawdownBps: 0n },
      peak7d: 10n ** 18n,
      grant: {
        key: "0x00000000000000000000000000000000000000ee",
        ownerEpoch: 0n,
        configEpoch: 0n,
        validUntil: NOW + 3_600n,
      },
      trades: [],
      tradesLeft: 20,
      nextSlotFreesAt: 0n,
      turnoverUsed: 0n,
      venueAllowed: { buy: true, sell: true },
    };
  }
  async quote(sell: "USDC" | "WMON", amountIn: bigint) {
    const implied = sell === "USDC" ? (amountIn * 10n ** 30n) / PX : (amountIn * PX) / 10n ** 30n;
    return { block: 500n, amountOut: (implied * 9_990n) / 10_000n };
  }
  tokenOf(): Hex {
    return "0x00000000000000000000000000000000000000c1";
  }
}

/** Answers with an invented number first, then a valid line. */
class ScriptedModel implements NarratorModel {
  calls = 0;
  async complete(): Promise<string> {
    this.calls += 1;
    return this.calls === 1
      ? "Agent #1 proposed a 99 USDC buy."
      : "Agent #1 proposed selling 5 USDC for WMON; it waits for approval.";
  }
}

describe.skipIf(!dbUp)("chain tools behind the gate (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let store: Store;
  let ledger: Ledger;
  let credits: CreditService;
  let provisioner: Provisioner;
  let leases: LeaseManager;
  let servers: ToolServers;
  let gate: Gate;
  let reader: FakeReader;
  let model: ScriptedModel;
  const redactor = new Redactor();
  const keys = new FundingKeys(SEED);

  beforeAll(async () => {
    t = await createTestDatabase("orch_chain");
    store = new Store(t.db);
    ledger = new Ledger(t.db);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  beforeEach(async () => {
    for (const table of [
      "platform.tool_calls",
      "platform.intents",
      "platform.activity_entries",
      "platform.ledger_lines",
      "platform.ledger_entries",
      "platform.funding_addresses",
      "platform.sandbox_leases",
      "platform.agent_runtimes",
      "indexer.usdc_transfers",
      "indexer.agents",
    ] as const)
      await t.db.deleteFrom(table).execute();
    const gateway = new MemoryGateway();
    const log = () => undefined;
    leases = new LeaseManager({
      store,
      provider: new MemoryProvider(),
      namespace: "unit",
      runTag: "r",
      redactor,
      log,
    });
    credits = new CreditService({
      store,
      ledger,
      gateway,
      chainId: CHAIN,
      environment: "fork",
      keyOf: (rt) => provisioner.virtualKey(rt),
      redactor,
      log,
    });
    provisioner = new Provisioner({
      store,
      gateway,
      leases,
      namespace: "unit",
      secret: SECRET,
      redactor,
      log,
      startingBudgetUsd: 1,
      credits,
    });
    reader = new FakeReader();
    model = new ScriptedModel();
    const narrator = new Narrator({
      store,
      gateway,
      credits,
      namespace: "unit",
      litellmUrl: "http://127.0.0.1:9",
      secret: SECRET,
      redactor,
      log,
      model,
    });
    servers = await startToolServers({
      store,
      ledger,
      credits,
      environment: "fork",
      provider: null,
      chain: {
        reader,
        sessionKeyOf: async () => "0x00000000000000000000000000000000000000ee",
        onProposed: (identity, intent) => {
          void narrator.narrateIntent(identity.chainId, identity.agentId, intent.intentId);
        },
      },
      log,
    });
    gate = await startGate({
      litellmUrl: "http://127.0.0.1:9",
      probeToken: "p".repeat(43),
      resolve: gateResolver(store, provisioner, credits),
      tools: { data: servers.data.url, platform: servers.platform.url, chain: servers.chain.url },
    });
  });
  afterEach(async () => {
    await gate?.close();
    await servers?.close();
  });

  const agent = async (agentId: number): Promise<string> => {
    await indexAgent(t.db, agentId, "base");
    await ensureFundingAddresses(store, keys, CHAIN);
    await provisioner.provision({ chainId: CHAIN, agentId });
    await t.db
      .insertInto("indexer.usdc_transfers")
      .values({
        chain_id: CHAIN,
        block_number: 100 + agentId,
        block_hash: `0x${agentId.toString(16).padStart(64, "b")}`,
        tx_hash: `0x${agentId.toString(16).padStart(64, "0")}`,
        log_index: 0,
        from_address: "0x00000000000000000000000000000000000f00d5",
        to_address: must(await fundingAddressOf(store, CHAIN, agentId)),
        value: "1000000",
        agent_id: agentId,
        direction: "in",
        account: "funding",
      })
      .execute();
    await credits.creditDeposits();
    return (await leases.acquire({ chainId: CHAIN, agentId }, "chain_check", 60_000)).gateToken;
  };
  const viaGate = (token: string, extra = {}) =>
    connectClient(`${gate.url}/mcp/chain`, token, { header: GATE_HEADER, extra });
  const propose = { sell: "USDC", buy: "WMON", amount: "5", reason: "Buy WMON under the band." };

  it("reads through the gate for the token's agent only, logs the call and charges nothing", async () => {
    const alice = await agent(1);
    const bob = await agent(2);
    const client = await viaGate(bob, {
      authorization: `Bearer ${alice}`,
      "x-agent-id": "143143-1",
    });
    const r = await client.callTool({ name: "get_portfolio", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(structured(r)).toMatchObject({ account: "0x00000000000000000000000000000000000ac002" });
    expect(reader.reads).toEqual([2]);
    const rows = await t.db.selectFrom("platform.tool_calls").selectAll().execute();
    expect(rows).toEqual([
      expect.objectContaining({
        agent_id: 2,
        server: "chain",
        tool: "get_portfolio",
        status: "succeeded",
        charge_usdc_e6: "0",
      }),
    ]);
    expect(rows[0]?.summary).toMatchObject({ totalValueUsdc: "100", mode: "NORMAL" });
    expect((await credits.creditsOf(2)).spendable).toBe(1_000_000n);
    await client.close();
  });

  it("stores one intent per proposal in a run, scoped to its agent, with no calldata", async () => {
    const alice = await agent(1);
    const client = await viaGate(alice);
    const first = structured(await client.callTool({ name: "propose_swap", arguments: propose }));
    const again = structured(await client.callTool({ name: "propose_swap", arguments: propose }));
    expect(first).toMatchObject({ status: "awaiting_approval", duplicate: false });
    expect(again).toMatchObject({ intentId: first.intentId, duplicate: true });
    const rows = await t.db.selectFrom("platform.intents").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_id: 1,
      sell: "USDC",
      buy: "WMON",
      amount_in: "5000000",
      status: "awaiting_approval",
      reason: propose.reason,
      account: "0x00000000000000000000000000000000000ac001",
    });
    expect(Object.keys(rows[0] ?? {})).not.toEqual(
      expect.arrayContaining(["calldata", "data", "to"]),
    );
    const bob = await viaGate(await agent(2));
    const r = await bob.callTool({
      name: "get_intent_status",
      arguments: { intentId: first.intentId },
    });
    expect(structured(r)).toMatchObject({ code: "INTENT_NOT_FOUND" });
    await client.close();
    await bob.close();
  });

  it("writes one activity entry per proposal, held to the number validator", async () => {
    const alice = await agent(1);
    const client = await viaGate(alice);
    const out = structured(await client.callTool({ name: "propose_swap", arguments: propose }));
    let entry;
    for (let i = 0; i < 50 && !entry; i++) {
      entry = await t.db
        .selectFrom("platform.activity_entries")
        .selectAll()
        .where("task_id", "=", String(out.intentId))
        .executeTakeFirst();
      if (!entry) await new Promise((r) => setTimeout(r, 50));
    }
    expect(entry).toMatchObject({
      kind: "intent",
      rendered_by: "narrator",
      text: "Agent #1 proposed selling 5 USDC for WMON; it waits for approval.",
    });
    expect(entry?.rejections[0]).toMatch(/numbers not in the facts: 99/);
    expect(entry?.facts).toMatchObject({
      activity: "swap_proposal",
      status: "awaiting approval",
      sell: { asset: "USDC", amount: "5" },
    });
    await client.close();
  });

  it("keeps at most three intents waiting per agent, and expires them", async () => {
    await agent(1);
    const identity = { chainId: CHAIN, agentId: 1, tier: "base", leaseId: "lease-x" };
    let clock = new Date(Number(NOW) * 1000);
    const intents = new PgIntentStore(store, () => clock);
    const draft = (
      key: string,
      status: "awaiting_approval" | "rejected" = "awaiting_approval",
    ) => ({
      idempotencyKey: key,
      account: null,
      sell: "USDC" as const,
      buy: "WMON" as const,
      amountIn: 1n,
      reason: "r",
      clientRequestId: null,
      status,
      reasonCodes: status === "rejected" ? (["TRADE_SIZE_EXCEEDED"] as const) : [],
      blockers: [],
      checks: {},
      ownerEpoch: 0n,
      configEpoch: 0n,
      expiresAt: new Date(clock.getTime() + 60_000),
    });
    for (const k of ["a", "b", "c"]) await intents.propose(identity, draft(k), 3);
    await expect(intents.propose(identity, draft("d"), 3)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    // A rejected proposal never waits, so it does not count against the limit.
    expect((await intents.propose(identity, draft("e", "rejected"), 3)).record.status).toBe(
      "rejected",
    );
    clock = new Date(clock.getTime() + 61_000);
    expect(await intents.expireDue(CHAIN)).toBe(3);
    expect((await intents.propose(identity, draft("d"), 3)).record.status).toBe(
      "awaiting_approval",
    );
    expect((await intents.list(CHAIN, 1)).map((i) => i.status)).toEqual(
      expect.arrayContaining(["expired", "expired", "expired", "rejected", "awaiting_approval"]),
    );
  });

  it("limits the chain tool calls of one run, recording the refusal", async () => {
    await agent(1);
    const identity = { chainId: CHAIN, agentId: 1, tier: "base", leaseId: "lease-y" };
    const log = new PgChainCallLog(store, 2);
    for (let i = 0; i < 2; i++)
      await log.finish(await log.begin(identity, "get_prices", {}), { status: "succeeded" });
    await expect(log.begin(identity, "get_prices", {})).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    const statuses = (
      await t.db
        .selectFrom("platform.tool_calls")
        .select("status")
        .where("lease_id", "=", "lease-y")
        .execute()
    ).map((r) => r.status);
    expect(statuses.sort()).toEqual(["refused", "succeeded", "succeeded"]);
  });

  it("allows exactly packages/domain's intent states in the database", async () => {
    const { rows } = await sql<{ def: string }>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'platform.intents'::regclass and conname = 'intents_status_check'`.execute(
      t.db,
    );
    const allowed = [...(rows[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(allowed.sort()).toEqual([...INTENT_STATES].sort());
  });
});
