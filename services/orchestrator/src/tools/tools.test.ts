import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import {
  type PageText,
  type SearchHit,
  UpstreamError,
  type WebProvider,
} from "@alpha-agents/data-tools";
import { connectClient, structured } from "@alpha-agents/tool-server/testing";
import { DEFAULT_GOAL_INPUT } from "@alpha-agents/domain";
import { translateGoal } from "@alpha-agents/policy";
import { GoalStore } from "@alpha-agents/trading";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FundingKeys, ensureFundingAddresses, fundingAddressOf } from "../credits/funding.ts";
import { Ledger } from "../credits/ledger.ts";
import { CreditService } from "../credits/service.ts";
import { type Gate, GATE_HEADER, startGate } from "../gate.ts";
import { gateResolver } from "../gate-resolver.ts";
import { MemoryGateway } from "../gateway-admin.ts";
import { LeaseManager } from "../leases.ts";
import { Provisioner } from "../provisioner.ts";
import { MemoryProvider } from "../sandbox.ts";
import { Redactor } from "../secrets.ts";
import { Store } from "../store.ts";
import { CHAIN, indexAgent, must } from "../testing.ts";
import { MAX_PAID_CALLS_PER_LEASE } from "./meter.ts";
import { type ToolServers, startToolServers } from "./servers.ts";

/**
 * The tool servers behind the real gate, with the real meter and ledger on a
 * test database (D-213, D-215): identity binding, metering, the zero-credit
 * refusal, reversal of unanswered calls and the private address block.
 */
const dbUp = await databaseAvailable();
const SEED = `0x${"5e".repeat(32)}` as const;
const SECRET = "test-orchestrator-secret-0123456789abcdef";

class FakeWeb implements WebProvider {
  readonly name = "fake";
  calls = 0;
  failNext = false;
  async search(): Promise<SearchHit[]> {
    this.calls += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new UpstreamError("the web provider answered 503", true, 503, null);
    }
    return [{ title: "Monad", url: "https://news.example/a", content: "News." }];
  }
  async extract(url: string): Promise<PageText | null> {
    this.calls += 1;
    return { url, content: "Page." };
  }
}

describe.skipIf(!dbUp)("tool servers behind the gate (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let store: Store;
  let ledger: Ledger;
  let credits: CreditService;
  let provisioner: Provisioner;
  let leases: LeaseManager;
  let servers: ToolServers;
  let gate: Gate;
  let web: FakeWeb;
  const redactor = new Redactor();
  const keys = new FundingKeys(SEED);
  let n = 0;

  beforeAll(async () => {
    t = await createTestDatabase("orch_tools");
    store = new Store(t.db);
    ledger = new Ledger(t.db);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  beforeEach(async () => {
    for (const table of [
      "platform.tool_calls",
      "platform.stage_records",
      "platform.thesis_notes",
      "platform.usage_receipts",
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
    web = new FakeWeb();
    servers = await startToolServers({
      store,
      ledger,
      credits,
      environment: "fork",
      provider: web,
      lookup: async () => ["93.184.215.14"],
      log,
    });
    gate = await startGate({
      litellmUrl: "http://127.0.0.1:9",
      probeToken: "p".repeat(43),
      resolve: gateResolver(store, provisioner, credits),
      tools: { data: servers.data.url, platform: servers.platform.url },
    });
  });
  afterEach(async () => {
    await gate?.close();
    await servers?.close();
  });

  /** A provisioned agent with `units` micro-USDC of credits and an active lease; returns its token. */
  const agentWith = async (agentId: number, units: bigint): Promise<string> => {
    await indexAgent(t.db, agentId, "base");
    await ensureFundingAddresses(store, keys, CHAIN);
    await provisioner.provision({ chainId: CHAIN, agentId });
    if (units > 0n) {
      n += 1;
      await t.db
        .insertInto("indexer.usdc_transfers")
        .values({
          chain_id: CHAIN,
          block_number: 100 + n,
          block_hash: `0x${n.toString(16).padStart(64, "b")}`,
          tx_hash: `0x${n.toString(16).padStart(64, "0")}`,
          log_index: 0,
          from_address: "0x00000000000000000000000000000000000f00d5",
          to_address: must(await fundingAddressOf(store, CHAIN, agentId)),
          value: units.toString(),
          agent_id: agentId,
          direction: "in",
          account: "funding",
        })
        .execute();
      await credits.creditDeposits();
    }
    const grant = await leases.acquire({ chainId: CHAIN, agentId }, "scan", 60_000);
    return grant.gateToken;
  };

  /** An MCP client that reaches a tool server the way a sandbox does: through the gate. */
  const viaGate = (server: "data" | "platform", token: string, extra = {}) =>
    connectClient(`${gate.url}/mcp/${server}`, token, { header: GATE_HEADER, extra });

  const spendable = async (agentId: number) => (await credits.creditsOf(agentId)).spendable;
  const calls = (agentId: number) =>
    t.db
      .selectFrom("platform.tool_calls")
      .selectAll()
      .where("agent_id", "=", agentId)
      .orderBy("started_at")
      .execute();

  it("charges a call to the token's agent; a forged authorization header changes nothing", async () => {
    const alice = await agentWith(1, 1_000_000n);
    const bob = await agentWith(2, 1_000_000n);
    // Bob's sandbox claims Alice's token in its own headers; E2B's injected header wins.
    const client = await viaGate("data", bob, {
      authorization: `Bearer ${alice}`,
      "x-agent-id": "143143-1",
    });
    const r = await client.callTool({ name: "web_search", arguments: { query: "monad news" } });
    expect(r.isError).toBeFalsy();
    expect(await spendable(1)).toBe(1_000_000n);
    expect(await spendable(2)).toBe(990_000n);
    const [row] = await calls(2);
    expect(row).toMatchObject({ tool: "web_search", status: "succeeded", charge_usdc_e6: "10000" });
    expect(await calls(1)).toEqual([]);
    expect(await ledger.balanced(CHAIN)).toBe(true);
    await client.close();
  });

  it("refuses an ended lease's token at the gate and at the tool server", async () => {
    const token = await agentWith(1, 1_000_000n);
    const lease = must(await store.activeLease({ chainId: CHAIN, agentId: 1 }));
    await leases.release(lease.leaseId, "test");
    await expect(viaGate("data", token)).rejects.toThrow();
    await expect(connectClient(servers.data.url, token)).rejects.toThrow();
    await expect(connectClient(servers.platform.url, token)).rejects.toThrow();
    expect(web.calls).toBe(0);
  });

  it("refuses paid calls at zero credits with no upstream call, and charges nothing", async () => {
    const token = await agentWith(1, 15_000n);
    const client = await viaGate("data", token);
    const first = await client.callTool({ name: "web_search", arguments: { query: "monad" } });
    expect(first.isError).toBeFalsy();
    const second = await client.callTool({ name: "web_search", arguments: { query: "monad" } });
    expect(structured(second)).toMatchObject({ code: "RATE_LIMITED", retryable: false });
    expect(web.calls).toBe(1);
    // A cheaper call still fits in what is left.
    const read = await client.callTool({
      name: "read_url",
      arguments: { url: "https://news.example/a" },
    });
    expect(read.isError).toBeFalsy();
    expect(await spendable(1)).toBe(3_000n);
    const rows = await calls(1);
    expect(rows.map((r) => [r.tool, r.status, r.error_code])).toEqual([
      ["web_search", "succeeded", null],
      ["web_search", "refused", "CREDITS_EXHAUSTED"],
      ["read_url", "succeeded", null],
    ]);
    expect(await ledger.balanced(CHAIN)).toBe(true);
    await client.close();
  });

  it("lets concurrent calls spend only the credits there are", async () => {
    const token = await agentWith(1, 25_000n);
    const client = await viaGate("data", token);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        client.callTool({ name: "web_search", arguments: { query: "monad" } }),
      ),
    );
    expect(results.filter((r) => !r.isError)).toHaveLength(2);
    expect(await spendable(1)).toBe(5_000n);
    expect(web.calls).toBe(2);
    await client.close();
  });

  it("reverses the charge of a call the provider did not answer", async () => {
    const token = await agentWith(1, 1_000_000n);
    const client = await viaGate("data", token);
    web.failNext = true;
    const r = await client.callTool({ name: "web_search", arguments: { query: "monad" } });
    expect(structured(r)).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryable: true });
    expect(await spendable(1)).toBe(1_000_000n);
    const [row] = await calls(1);
    expect(row).toMatchObject({ status: "failed", error_code: "UPSTREAM_UNAVAILABLE" });
    expect(row?.reversal_entry_id).toBeTruthy();
    const kinds = await t.db
      .selectFrom("platform.ledger_entries")
      .select("kind")
      .where("agent_id", "=", 1)
      .orderBy("created_at")
      .execute();
    expect(kinds.map((k) => k.kind)).toEqual([
      "credits_received",
      "usage_metered",
      "usage_reversed",
    ]);
    expect(await ledger.balanced(CHAIN)).toBe(true);
    await client.close();
  });

  it("refuses private and metadata addresses through the gate, with no charge", async () => {
    const token = await agentWith(1, 1_000_000n);
    const client = await viaGate("data", token);
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      `${gate.url}/healthz`,
      "http://[::1]:4200/v1/runtimes",
    ]) {
      const r = await client.callTool({ name: "read_url", arguments: { url } });
      expect(structured(r)).toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(web.calls).toBe(0);
    expect(await spendable(1)).toBe(1_000_000n);
    expect((await calls(1)).every((r) => r.status === "refused")).toBe(true);
    await client.close();
  });

  it("stops a lease after its paid call limit", async () => {
    const token = await agentWith(1, 1_000_000n);
    const client = await viaGate("data", token);
    for (let i = 0; i < MAX_PAID_CALLS_PER_LEASE; i += 1) {
      const r = await client.callTool({
        name: "read_url",
        arguments: { url: `https://news.example/${i}` },
      });
      expect(r.isError).toBeFalsy();
    }
    const over = await client.callTool({
      name: "read_url",
      arguments: { url: "https://news.example/x" },
    });
    expect(structured(over)).toMatchObject({ code: "RATE_LIMITED", retryable: false });
    expect(web.calls).toBe(MAX_PAID_CALLS_PER_LEASE);
    await client.close();
  });

  it("records complete_stage once per lease and thesis notes for the token's agent", async () => {
    const alice = await agentWith(1, 0n);
    const bob = await agentWith(2, 0n);
    const args = {
      stage: "SCAN",
      outcome: "DONE",
      candidates: [{ asset: "WMON", thesisCode: "DEX_VOLUME_UP", confidenceBps: 5500 }],
    };
    const a = await viaGate("platform", alice);
    const note = await a.callTool({
      name: "write_thesis",
      arguments: { stage: "SCAN", title: "Volume", notes: "Up.", sources: [] },
    });
    expect(note.isError).toBeFalsy();
    expect((await a.callTool({ name: "complete_stage", arguments: args })).isError).toBeFalsy();
    const dup = await a.callTool({ name: "complete_stage", arguments: args });
    expect(structured(dup)).toMatchObject({ code: "DUPLICATE_REQUEST" });
    const b = await viaGate("platform", bob);
    expect((await b.callTool({ name: "complete_stage", arguments: args })).isError).toBeFalsy();
    const stages = await t.db
      .selectFrom("platform.stage_records")
      .select(["agent_id", "lease_id"])
      .orderBy("created_at")
      .execute();
    const leaseOf = async (agentId: number) =>
      must(await store.activeLease({ chainId: CHAIN, agentId })).leaseId;
    expect(stages).toEqual([
      { agent_id: 1, lease_id: await leaseOf(1) },
      { agent_id: 2, lease_id: await leaseOf(2) },
    ]);
    const notes = await t.db.selectFrom("platform.thesis_notes").select("agent_id").execute();
    expect(notes).toEqual([{ agent_id: 1 }]);
    // Platform tools are free.
    expect((await calls(1)).every((r) => r.charge_usdc_e6 === "0")).toBe(true);
    await a.close();
    await b.close();
  });

  it("get_goals_and_limits answers each lease with its own agent's goal (P3-U1)", async () => {
    await t.db.deleteFrom("platform.agent_goals").execute();
    await t.db.deleteFrom("platform.agent_states").execute();
    const alice = await agentWith(1, 0n);
    const bob = await agentWith(2, 0n);
    const goals = new GoalStore(t.db);
    const save = (agentId: number, riskPreset: "CONSERVATIVE" | "GROWTH") => {
      const r = translateGoal({ ...structuredClone(DEFAULT_GOAL_INPUT), riskPreset });
      if (!r.ok) throw new Error("fixture goal refused");
      return goals.save({
        chainId: CHAIN,
        agentId,
        ownerEpoch: 0n,
        savedBy: "0x00000000000000000000000000000000000a11ce",
        config: r.config,
      });
    };
    await save(1, "CONSERVATIVE");
    await save(2, "GROWTH");
    await save(2, "GROWTH");
    const read = async (token: string) => {
      const client = await viaGate("platform", token);
      const out = structured(
        await client.callTool({ name: "get_goals_and_limits", arguments: {} }),
      );
      await client.close();
      return out as Record<string, unknown>;
    };
    expect(await read(alice)).toMatchObject({
      state: "READY",
      strategyEpoch: "1",
      goal: { riskPreset: "CONSERVATIVE" },
      plan: { params: { targetWmonBps: 1_000 } },
      // No chain reader here: no live limits, and the hard limits are the effective ones.
      limits: { live: null, effective: { maxTradeBps: 1_000 } },
    });
    expect(await read(bob)).toMatchObject({
      strategyEpoch: "2",
      goal: { riskPreset: "GROWTH" },
      plan: { params: { targetWmonBps: 3_000 } },
    });
  });
});
