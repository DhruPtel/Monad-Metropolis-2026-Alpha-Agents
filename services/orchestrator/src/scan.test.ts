import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import type { PageText, SearchHit, WebProvider } from "@alpha-agents/data-tools";
import { connectClient } from "@alpha-agents/tool-server/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FundingKeys, ensureFundingAddresses, fundingAddressOf } from "./credits/funding.ts";
import { Ledger } from "./credits/ledger.ts";
import { CreditService } from "./credits/service.ts";
import { type Gate, GATE_HEADER, startGate } from "./gate.ts";
import { gateResolver } from "./gate-resolver.ts";
import { MemoryGateway } from "./gateway-admin.ts";
import { LeaseManager } from "./leases.ts";
import { Narrator, type NarratorModel } from "./narrator.ts";
import { Orchestrator } from "./orchestrator.ts";
import { Provisioner } from "./provisioner.ts";
import { MemoryProvider } from "./sandbox.ts";
import { SCAN_MIN_CREDITS_USDC_E6, type ScanContext, runScanTask, scanDue } from "./scan.ts";
import { Redactor } from "./secrets.ts";
import { Store } from "./store.ts";
import { CHAIN, indexAgent, must, redisAvailable, redisUrl } from "./testing.ts";
import { type ToolServers, startToolServers } from "./tools/servers.ts";

/**
 * The Scan's orchestration, offline (D-216). The sandbox is scripted, but its
 * "Hermes run" calls the real data and platform tools servers through the
 * real gate with the gate token its lease injected, so identity, metering,
 * stage records and the narrator all run for real. The live run with E2B,
 * Tavily and a real model is in live.ts.
 */
const dbUp = await databaseAvailable();
const redisUp = await redisAvailable();
const ref = { chainId: CHAIN, agentId: 1 };
const HOUR = 3_600_000;

describe("when a Scan is due (D-216)", () => {
  const base = {
    now: new Date(10 * HOUR),
    intervalMs: 6 * HOUR,
    spendable: SCAN_MIN_CREDITS_USDC_E6,
    openScan: false,
    lastScanAt: null,
    firstCreditAt: null,
  };
  it.each([
    ["never funded", {}, false],
    ["funded less than an interval ago", { firstCreditAt: new Date(5 * HOUR) }, false],
    ["funded an interval ago", { firstCreditAt: new Date(4 * HOUR) }, true],
    ["scanned recently", { firstCreditAt: new Date(0), lastScanAt: new Date(9 * HOUR) }, false],
    [
      "scanned an interval ago",
      { firstCreditAt: new Date(0), lastScanAt: new Date(4 * HOUR) },
      true,
    ],
    [
      "below the minimum",
      { firstCreditAt: new Date(0), spendable: SCAN_MIN_CREDITS_USDC_E6 - 1n },
      false,
    ],
    ["with a Scan open", { firstCreditAt: new Date(0), openScan: true }, false],
  ])("%s", (_name, over, due) => {
    expect(scanDue({ ...base, ...over })).toBe(due);
  });
});

class FakeWeb implements WebProvider {
  readonly name = "fake";
  async search(): Promise<SearchHit[]> {
    return [{ title: "Monad DEX volume", url: "https://news.example/a", content: "Up." }];
  }
  async extract(url: string): Promise<PageText | null> {
    return { url, content: "Volume rose." };
  }
}

const GOOD_ENTRY =
  "Agent #1 ran 1 web search and read 1 page, then flagged WMON (DEX_VOLUME_UP, 55% confidence). Tools cost 0.012 USDC.";
class OneAnswer implements NarratorModel {
  async complete(): Promise<string> {
    return GOOD_ENTRY;
  }
}

const http = (status: number, body: unknown) => ({
  exitCode: 0,
  stdout: `HTTP/1.1 ${status} OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}`,
  stderr: "",
});

describe.skipIf(!dbUp)("the Scan task (needs Postgres)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let store: Store;
  let ledger: Ledger;
  let credits: CreditService;
  let provisioner: Provisioner;
  let provider: MemoryProvider;
  let servers: ToolServers;
  let gate: Gate;
  let ctx: ScanContext;
  let agentScript: (token: string) => Promise<void>;
  let runState = "running";
  const redactor = new Redactor();
  const keys = new FundingKeys(`0x${"5e".repeat(32)}`);

  beforeAll(async () => {
    t = await createTestDatabase("orch_scan");
    store = new Store(t.db);
    ledger = new Ledger(t.db);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  beforeEach(async () => {
    for (const table of [
      "platform.activity_entries",
      "platform.tool_calls",
      "platform.stage_records",
      "platform.thesis_notes",
      "platform.agent_tasks",
      "platform.sandbox_leases",
      "platform.ledger_lines",
      "platform.ledger_entries",
      "platform.funding_addresses",
      "platform.agent_runtimes",
      "indexer.usdc_transfers",
      "indexer.agents",
    ] as const)
      await t.db.deleteFrom(table).execute();
    const gateway = new MemoryGateway();
    const log = () => undefined;
    provider = new MemoryProvider();
    const leases = new LeaseManager({
      store,
      provider,
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
      secret: "test-orchestrator-secret-0123456789abcdef",
      redactor,
      log,
      startingBudgetUsd: 1,
      credits,
    });
    await indexAgent(t.db, 1, "base");
    await ensureFundingAddresses(store, keys, CHAIN);
    await provisioner.provision(ref);
    await t.db
      .insertInto("indexer.usdc_transfers")
      .values({
        chain_id: CHAIN,
        block_number: 100,
        block_hash: `0x${"b".repeat(64)}`,
        tx_hash: `0x${"1".repeat(64)}`,
        log_index: 0,
        from_address: "0x00000000000000000000000000000000000f00d5",
        to_address: must(await fundingAddressOf(store, CHAIN, 1)),
        value: "1000000",
        agent_id: 1,
        direction: "in",
        account: "funding",
      })
      .execute();
    await credits.creditDeposits();

    servers = await startToolServers({
      store,
      ledger,
      credits,
      environment: "fork",
      provider: new FakeWeb(),
      lookup: async () => ["93.184.215.14"],
      log,
    });
    gate = await startGate({
      litellmUrl: "http://127.0.0.1:9",
      probeToken: "p".repeat(43),
      resolve: gateResolver(store, provisioner, credits),
      tools: { data: servers.data.url, platform: servers.platform.url },
    });
    // The scripted sandbox: Hermes' API server answers as Hermes does, and starting the run
    // runs the agent script with the token E2B would inject on the way to the gate.
    runState = "running";
    provider.onRun = (cmd) => {
      if (cmd.includes("/health'")) return http(200, { status: "ok" });
      if (cmd.includes("-X POST") && cmd.includes("/v1/runs") && !cmd.includes("/stop")) {
        const [sandbox] = [...provider.sandboxes.values()];
        const token = must(sandbox?.spec.injectHeaders[GATE_HEADER]);
        void agentScript(token).finally(() => (runState = "completed"));
        return http(202, { run_id: "run-1" });
      }
      if (cmd.includes("/v1/runs/run-1")) return http(200, { status: runState, output: "done" });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    ctx = {
      store,
      leases,
      provider,
      template: "tmpl",
      tunnelHost: async () => "gate.example.test",
      gate,
      redactor,
      log,
      narrator: new Narrator({
        store,
        gateway,
        credits,
        namespace: "unit",
        litellmUrl: "http://127.0.0.1:9",
        secret: "s".repeat(40),
        redactor,
        log,
        model: new OneAnswer(),
      }),
    };
  });
  afterEach(async () => {
    await gate?.close();
    await servers?.close();
  });

  const call = async (token: string, server: "data" | "platform", name: string, args: object) => {
    const client = await connectClient(`${gate.url}/mcp/${server}`, token, { header: GATE_HEADER });
    const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
    await client.close();
    return r;
  };

  it("searches, reads, saves notes, completes the stage and gets an activity entry", async () => {
    agentScript = async (token) => {
      await call(token, "data", "web_search", { query: "monad dex volume" });
      await call(token, "data", "read_url", { url: "https://news.example/a" });
      await call(token, "platform", "write_thesis", {
        stage: "SCAN",
        title: "DEX volume",
        notes: "Volume rose.",
        sources: ["https://news.example/a"],
      });
      await call(token, "platform", "complete_stage", {
        stage: "SCAN",
        outcome: "DONE",
        candidates: [{ asset: "WMON", thesisCode: "DEX_VOLUME_UP", confidenceBps: 5500 }],
      });
    };
    await store.insertTask("scan-1", ref, "scan");
    await runScanTask(ctx, "scan-1");
    const task = must(await store.task("scan-1"));
    expect(task.error).toBeNull();
    expect(task.status).toBe("succeeded");
    expect(task.result).toMatchObject({
      kind: "scan",
      stopReason: "COMPLETED",
      stage: { outcome: "DONE", schemaValid: true },
      toolChargeUsdcE6: "12000",
      sandboxStopped: true,
    });
    expect((task.result as { toolCalls: { tool: string }[] }).toolCalls.map((c) => c.tool)).toEqual(
      ["web_search", "read_url", "write_thesis", "complete_stage"],
    );
    expect((await credits.creditsOf(1)).spendable).toBe(988_000n);
    expect(await ledger.balanced(CHAIN)).toBe(true);
    const entry = must(await ctx.narrator?.stored("scan-1"));
    expect(entry).toMatchObject({ renderedBy: "narrator", text: GOOD_ENTRY });
  });

  it("fails a Scan that never calls complete_stage, and narrates it from the template", async () => {
    agentScript = async (token) => {
      await call(token, "data", "web_search", { query: "monad" });
    };
    await store.insertTask("scan-2", ref, "scan");
    await runScanTask(ctx, "scan-2");
    const task = must(await store.task("scan-2"));
    expect(task.status).toBe("failed");
    expect(task.error).toMatch(/without calling complete_stage/);
    expect(task.result).toMatchObject({ stopReason: "NO_STAGE_RECORD", stage: null });
    // The narrator's model answer has numbers the facts lack (1 page, 55%, 0.012), so twice
    // rejected, the template writes the entry.
    const entry = must(await ctx.narrator?.stored("scan-2"));
    expect(entry.renderedBy).toBe("template");
    expect(entry.text).toMatch(/did not finish/);
    expect(entry.rejections).toHaveLength(2);
  });

  it.skipIf(!redisUp)(
    "queues a due Scan from the scheduler, and refuses a second while one is open",
    async () => {
      const o = new Orchestrator({
        store,
        gateway: new MemoryGateway(),
        provider: null,
        keeper: null,
        chainId: CHAIN,
        namespace: `unit-scan-${process.pid}`,
        redisUrl: redisUrl(),
        secret: "test-orchestrator-secret-0123456789abcdef",
        litellmUrl: "http://127.0.0.1:9",
        devDir: "/tmp",
        cloudflared: null,
        startingBudgetUsd: 1,
        redactor,
        log: () => undefined,
        credits: { keys, refundChain: null, environment: "fork" },
        scanIntervalMs: HOUR,
      });
      try {
        expect(await o.scheduleScans(new Date())).toEqual([]);
        expect(await o.scheduleScans(new Date(Date.now() + 2 * HOUR))).toEqual([1]);
        expect(await o.scheduleScans(new Date(Date.now() + 2 * HOUR))).toEqual([]);
        await expect(o.enqueueScan(ref)).rejects.toThrow(/already has a Scan/);
        const scans = await t.db
          .selectFrom("platform.agent_tasks")
          .select(["kind", "status"])
          .execute();
        expect(scans).toEqual([{ kind: "scan", status: "queued" }]);
      } finally {
        await o.queue.obliterate();
        await o.queue.close();
      }
    },
  );
});
