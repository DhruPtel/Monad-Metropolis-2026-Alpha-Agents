import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DecisionStore,
  GoalStore,
  PlanStore,
  TradeStore,
  approveByOwner,
} from "@alpha-agents/trading";
import { DEFAULT_GOAL_INPUT } from "@alpha-agents/domain";
import { translateGoal } from "@alpha-agents/policy";
import { createApi } from "./api.ts";
import { MemoryGateway } from "./gateway-admin.ts";
import { LeaseManager } from "./leases.ts";
import { CreditsExhaustedError, type Orchestrator, ScanOpenError } from "./orchestrator.ts";
import { Provisioner } from "./provisioner.ts";
import { RevealSteering } from "./reveal-steer.ts";
import { DbSteerStore } from "./reveal-steer-store.ts";
import { MemoryProvider } from "./sandbox.ts";
import { Redactor } from "./secrets.ts";
import { Store } from "./store.ts";
import { CHAIN, indexAgent, unindexAgent } from "./testing.ts";

const dbUp = await databaseAvailable();

describe.skipIf(!dbUp)("the orchestrator's internal API (D-205)", { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let store: Store;
  let leases: LeaseManager;
  const queued: string[] = [];
  let scanRefusal: Error | null = null;
  const orchestrator = {
    runTag: "run-test",
    keeper: null,
    enqueueNoop: async (ref: { agentId: number }) => {
      queued.push(`noop ${ref.agentId}`);
      return "task-1";
    },
    enqueueReset: async (ref: { agentId: number }) => {
      queued.push(`reset ${ref.agentId}`);
    },
    enqueueScan: async (ref: { agentId: number }) => {
      if (scanRefusal) throw scanRefusal;
      queued.push(`scan ${ref.agentId}`);
      return "scan-1";
    },
  } as unknown as Orchestrator;

  beforeAll(async () => {
    t = await createTestDatabase("orch_api");
    store = new Store(t.db);
    const redactor = new Redactor();
    leases = new LeaseManager({
      store,
      provider: new MemoryProvider(),
      namespace: "unit",
      runTag: "r",
      redactor,
      log: () => undefined,
    });
    await indexAgent(t.db, 1, "pro");
    await indexAgent(t.db, 2, null);
    await new Provisioner({
      store,
      gateway: new MemoryGateway(),
      leases,
      namespace: "unit",
      secret: "test-orchestrator-secret-0123456789abcdef",
      redactor,
      log: () => undefined,
      startingBudgetUsd: 0.5,
    }).provision({ chainId: CHAIN, agentId: 1 });
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  const api = (devActions: boolean) =>
    createApi({ orchestrator, store, chainId: CHAIN, devActions });

  it("lists runtimes with tier, slots and playbook, and no key material", async () => {
    const res = await api(true).request("/v1/runtimes");
    const body = (await res.json()) as { devActions: boolean; runtimes: Record<string, unknown>[] };
    expect(body.devActions).toBe(true);
    expect(body.runtimes).toHaveLength(1);
    expect(body.runtimes[0]).toMatchObject({
      agentId: "1",
      status: "ready",
      tier: "pro",
      slots: 8,
      playbook: "tier-pro@0",
      keyAlias: "aa-unit-143143-1-g1",
      lease: null,
      latestTask: null,
    });
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/ciphertext|sk-aa-|v1\.[A-Za-z0-9_-]{8,}\./);
  });

  it("queues the no-op task for a provisioned agent only, and not while it holds a lease", async () => {
    const post = (id: string) =>
      api(true).request(`/v1/agents/${id}/tasks/noop`, { method: "POST" });
    expect((await post("2")).status).toBe(409);
    expect((await post("abc")).status).toBe(400);
    const ok = await post("1");
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ taskId: "task-1" });
    const held = await leases.acquire({ chainId: CHAIN, agentId: 1 }, "noop", 60_000);
    const refused = await post("1");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "lease_held" });
    await leases.release(held.lease.leaseId, "test");
    expect(queued).toEqual(["noop 1"]);
  });

  it("queues a reset", async () => {
    const res = await api(true).request("/v1/agents/1/reset", { method: "POST" });
    expect(res.status).toBe(202);
    expect(queued.at(-1)).toBe("reset 1");
  });

  it("queues a Scan, and names why one is refused", async () => {
    const post = () => api(true).request("/v1/agents/1/tasks/scan", { method: "POST" });
    const ok = await post();
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ taskId: "scan-1" });
    scanRefusal = new CreditsExhaustedError(1);
    const broke = await post();
    expect(broke.status).toBe(409);
    expect(await broke.json()).toMatchObject({ error: "credits_exhausted" });
    scanRefusal = new ScanOpenError(1);
    expect(await (await post()).json()).toMatchObject({ error: "scan_open" });
    scanRefusal = null;
    expect((await api(true).request("/v1/agents/2/tasks/scan", { method: "POST" })).status).toBe(
      409,
    );
    expect((await api(false).request("/v1/agents/1/tasks/scan", { method: "POST" })).status).toBe(
      404,
    );
  });

  it("lists tool calls with the query or host only, and activity entries", async () => {
    const call = (id: string, tool: string, input: unknown) =>
      t.db
        .insertInto("platform.tool_calls")
        .values({
          call_id: id,
          chain_id: CHAIN,
          agent_id: 1,
          lease_id: "L",
          server: "data",
          tool,
          input: JSON.stringify(input),
          status: "succeeded",
          charge_usdc_e6: "10000",
          summary: JSON.stringify({ results: 3 }),
        })
        .execute();
    await call("c1", "web_search", { query: "monad news" });
    await call("c2", "read_url", { url: "https://news.example/path?secret=1" });
    await t.db
      .insertInto("platform.activity_entries")
      .values({
        entry_id: "a1",
        chain_id: CHAIN,
        agent_id: 1,
        task_id: "scan-1",
        kind: "scan",
        text: "Agent #1 ran 1 web search.",
        rendered_by: "narrator",
        facts: "{}",
        rejections: "[]",
      })
      .execute();
    const calls = (await (await api(false).request("/v1/agents/1/tool-calls")).json()) as {
      calls: { tool: string; target: string; chargeUsdcE6: string; results: number }[];
    };
    expect(calls.calls.map((c) => [c.tool, c.target])).toEqual(
      expect.arrayContaining([
        ["web_search", "monad news"],
        ["read_url", "news.example"],
      ]),
    );
    expect(JSON.stringify(calls)).not.toContain("secret=1");
    const activity = (await (await api(false).request("/v1/agents/1/activity")).json()) as {
      entries: { text: string; renderedBy: string }[];
    };
    expect(activity.entries).toEqual([
      expect.objectContaining({ text: "Agent #1 ran 1 web search.", renderedBy: "narrator" }),
    ]);
    expect((await api(false).request("/v1/agents/x/activity")).status).toBe(400);
  });

  it("steers a wallet's or a pending agent's reveal, kept in Postgres across restarts (D-221)", async () => {
    const bob = "0x0000000000000000000000000000000000000b0b";
    const post = (devActions: boolean, orch: Orchestrator, body: unknown, path = "") =>
      createApi({ orchestrator: orch, store, chainId: CHAIN, devActions }).request(
        `/v1/keeper/reveal-steers${path}`,
        { method: "POST", body: JSON.stringify(body) },
      );
    const local = (steering: RevealSteering) =>
      ({ ...orchestrator, keeper: null, revealSteering: steering }) as unknown as Orchestrator;
    const keeperView = async (orch: Orchestrator) =>
      (await (
        await createApi({ orchestrator: orch, store, chainId: CHAIN, devActions: true }).request(
          "/v1/keeper",
        )
      ).json()) as { steering: { pending: Record<string, unknown>[]; recent: unknown[] } | null };

    // No steering (every environment but the local fork): nothing to set, and none shown.
    expect((await post(true, orchestrator, { species: "bee", wallet: bob })).status).toBe(404);
    expect(await keeperView(orchestrator)).toMatchObject({ steering: null });

    const first = local(new RevealSteering(14, new DbSteerStore(t.db), CHAIN));
    // Without dev actions the route does not exist, even with steering.
    expect((await post(false, first, { species: "bee", wallet: bob })).status).toBe(404);

    // A wallet with no unrevealed agent: its next mint.
    const w = await post(true, first, { species: "praying-mantis", wallet: bob });
    expect(w.status).toBe(200);
    expect(((await w.json()) as { steer: unknown }).steer).toMatchObject({
      target: { kind: "wallet", wallet: bob },
      species: "praying-mantis",
      status: "pending",
      appliesTo: { agentId: null, text: "the next agent this wallet mints" },
    });
    // Once Bob has an unrevealed agent, the view names it.
    await indexAgent(t.db, 7, null, bob);
    // A pending agent: recorded with its owner, and named exactly.
    const a = await post(true, first, { species: "bee", agentId: "2" });
    expect(((await a.json()) as { steer: unknown }).steer).toMatchObject({
      target: { kind: "agent", agentId: "2", owner: "0x00000000000000000000000000000000000a11ce" },
      appliesTo: { agentId: "2" },
    });

    // A restart: a new steering object over the same database sees both.
    const restarted = local(new RevealSteering(14, new DbSteerStore(t.db), CHAIN));
    const view = (await keeperView(restarted)).steering;
    expect(view?.pending).toHaveLength(2);
    expect(view?.pending[0]).toMatchObject({
      species: "praying-mantis",
      appliesTo: { agentId: "7", text: "agent #7, this wallet's unrevealed agent" },
    });

    // Refusals: a revealed or unknown agent, a bad species, wallet, or both targets at once.
    expect((await post(true, restarted, { species: "bee", agentId: "1" })).status).toBe(400);
    expect((await post(true, restarted, { species: "bee", agentId: "99" })).status).toBe(400);
    expect((await post(true, restarted, { species: "unicorn", wallet: bob })).status).toBe(400);
    expect((await post(true, restarted, { species: "bee", wallet: "0x12" })).status).toBe(400);
    expect(
      (await post(true, restarted, { species: "bee", wallet: bob, agentId: "2" })).status,
    ).toBe(400);

    // Cancel: once, then it is no longer pending.
    const id = String(view?.pending[1]?.steerId);
    expect((await post(true, restarted, {}, `/${id}/cancel`)).status).toBe(200);
    expect((await post(true, restarted, {}, `/${id}/cancel`)).status).toBe(409);
    const after = (await keeperView(restarted)).steering;
    expect(after?.pending).toHaveLength(1);
    expect(after?.recent[0]).toMatchObject({ status: "cancelled", appliesTo: null });
    await unindexAgent(t.db, 7);
  });

  it("approves an intent and serves intents, arming and why-not-traded for the console (P2-U6)", async () => {
    const trades = new TradeStore(t.db);
    const o = {
      ...orchestrator,
      trades,
      tradeFlow: null,
      arming: async (ref: { chainId: number; agentId: number }) => ({
        last: await trades.lastArming(ref.chainId, ref.agentId),
      }),
      approveIntent: (ref: { chainId: number; agentId: number }, id: string) =>
        approveByOwner(trades, ref.chainId, ref.agentId, id),
      whyNotTraded: (ref: { chainId: number; agentId: number }) =>
        trades.whyNotTraded(ref.chainId, ref.agentId),
    } as unknown as Orchestrator;
    const app = createApi({ orchestrator: o, store, chainId: CHAIN, devActions: true });
    const id = "intent-00000000-0000-4000-8000-000000000001";
    await t.db
      .insertInto("platform.intents")
      .values({
        intent_id: id,
        chain_id: CHAIN,
        agent_id: 1,
        lease_id: "lease-1",
        kind: "swap",
        sell: "USDC",
        buy: "WMON",
        amount_in: "5000000",
        reason: "test",
        idempotency_key: "k-1",
        status: "awaiting_approval",
        reason_codes: "[]",
        checks: "{}",
        owner_epoch: "0",
        config_epoch: "0",
        expires_at: new Date(Date.now() + 1_800_000),
      })
      .execute();
    const refused = await app.request(`/v1/agents/1/intents/${id}/approve`, { method: "POST" });
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([
      409,
      "not_armed",
    ]);
    await trades.startArming({
      chainId: CHAIN,
      agentId: 1,
      owner: "0x00000000000000000000000000000000000a11ce",
      ownerEpoch: 0n,
      configEpoch: 0n,
      sessionKey: "0x00000000000000000000000000000000000000ee",
      validUntil: BigInt(Math.floor(Date.now() / 1000) + 86_400),
    });
    const ok = await app.request(`/v1/agents/1/intents/${id}/approve`, { method: "POST" });
    expect(await ok.json()).toMatchObject({ armed: true, intent: { status: "approved" } });
    const chain = (await (await app.request("/v1/agents/1/chain")).json()) as Record<
      string,
      unknown
    >;
    expect(chain).toMatchObject({
      arming: { state: "armed", firstIntentId: id },
      intents: [expect.objectContaining({ intentId: id, approvedBy: "owner" })],
    });
    const why = await (await app.request("/v1/agents/1/why-not-traded")).json();
    expect(why).toMatchObject({ armingState: "armed", reasons: [] });
    // Without dev actions the console's arm, disarm and approve do not exist.
    const off = createApi({ orchestrator: o, store, chainId: CHAIN, devActions: false });
    for (const path of [
      "/v1/agents/1/arm",
      "/v1/agents/1/disarm",
      `/v1/agents/1/intents/${id}/approve`,
    ])
      expect((await off.request(path, { method: "POST" })).status, path).toBe(404);
  });

  it("serves an agent's plan with the goal's defaults, sets a checked plan, and refuses one outside the goal (P3-U3)", async () => {
    const goals = new GoalStore(t.db);
    const plans = new PlanStore(t.db);
    const decisions = new DecisionStore(t.db);
    const o = { ...orchestrator, goals, plans, decisions, runner: null } as unknown as Orchestrator;
    const app = createApi({ orchestrator: o, store, chainId: CHAIN, devActions: true });
    const none = (await (await app.request("/v1/agents/1/plan")).json()) as Record<string, unknown>;
    expect(none).toMatchObject({ goal: null, plan: null, decisions: [] });
    const translated = translateGoal(DEFAULT_GOAL_INPUT);
    if (!translated.ok) throw new Error("goal");
    const put = (body: unknown) =>
      app.request("/v1/agents/1/plan", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const p = translated.config.template.params;
    const body = { ...p, minTradeUsdcE6: p.minTradeUsdcE6.toString() };
    expect((await put(body)).status).toBe(409);
    await goals.save({
      chainId: CHAIN,
      agentId: 1,
      ownerEpoch: 0n,
      savedBy: "0x00000000000000000000000000000000000a11ce",
      config: translated.config,
    });
    const outside = await put({ ...body, targetWmonBps: 3_500 });
    expect(outside.status).toBe(400);
    expect(await outside.json()).toMatchObject({
      error: "plan_out_of_bounds",
      message: expect.stringContaining("within the goal's range"),
    });
    expect((await put({ ...body, extra: 1 })).status).toBe(400);
    const set = await put({ ...body, targetWmonBps: 1_500 });
    expect(set.status).toBe(201);
    const view = (await (await app.request("/v1/agents/1/plan")).json()) as Record<string, unknown>;
    expect(view).toMatchObject({
      strategyEpoch: "2",
      goal: { riskPreset: "BALANCED", targetRange: { minBps: 0, maxBps: 3_000 } },
      plan: {
        params: { targetWmonBps: 1_500 },
        strategyEpoch: "2",
        stale: false,
        setBy: "console",
      },
      runner: { on: false, canSet: true, canRun: false },
    });
    // The runner is off without trading, so "run now" says so; without dev actions setting is gone.
    expect((await app.request("/v1/agents/1/runner/run", { method: "POST" })).status).toBe(409);
    const off = createApi({ orchestrator: o, store, chainId: CHAIN, devActions: false });
    expect((await off.request("/v1/agents/1/plan", { method: "PUT", body: "{}" })).status).toBe(
      404,
    );
    expect((await off.request("/v1/agents/1/runner/run", { method: "POST" })).status).toBe(404);
    expect((await off.request("/v1/agents/1/plan")).status).toBe(200);
  });

  it("has no write routes without dev actions (outside APP_ENV=local)", async () => {
    expect((await api(false).request("/v1/agents/1/reset", { method: "POST" })).status).toBe(404);
    expect((await api(false).request("/v1/agents/1/tasks/noop", { method: "POST" })).status).toBe(
      404,
    );
    expect((await api(false).request("/v1/runtimes")).status).toBe(200);
  });

  it("gives testnet the operator actions only: the chain check and fresh feeds, no fork writes (P2-EC)", async () => {
    const reasons: string[] = [];
    const testnet = createApi({
      orchestrator: {
        ...orchestrator,
        enqueueChainCheck: async () => "check-1",
        proposeOverLimitForTest: async () => "intent-over",
      } as unknown as Orchestrator,
      store,
      chainId: CHAIN,
      devActions: false,
      operatorActions: true,
      feeds: {
        ensureFresh: async (reason: string) => {
          reasons.push(reason);
          return { redated: [], error: null };
        },
      },
    });
    const check = await testnet.request("/v1/agents/1/tasks/chain-check", { method: "POST" });
    expect(check.status).toBe(202);
    expect(await check.json()).toEqual({ taskId: "check-1" });
    const over = await testnet.request("/v1/agents/1/test-over-limit", { method: "POST" });
    expect([over.status, await over.json()]).toEqual([201, { intentId: "intent-over" }]);
    const fresh = await testnet.request("/v1/feeds/fresh?reason=a%20deposit", { method: "POST" });
    expect(fresh.status).toBe(200);
    expect(reasons).toEqual(["a deposit"]);
    for (const path of [
      "/v1/agents/1/reset",
      "/v1/agents/1/tasks/noop",
      "/v1/agents/1/tasks/scan",
      "/v1/agents/1/arm",
      "/v1/agents/1/test-swap",
      "/v1/keeper/reveal-steers",
    ])
      expect((await testnet.request(path, { method: "POST" })).status, path).toBe(404);
    // Without a refresher (local, or testnet without the feed key) the route says so.
    const local = createApi({ orchestrator, store, chainId: CHAIN, devActions: true });
    expect((await local.request("/v1/feeds/fresh", { method: "POST" })).status).toBe(404);
    // The beta has neither.
    const beta = createApi({ orchestrator, store, chainId: CHAIN, devActions: false });
    expect((await beta.request("/v1/agents/1/tasks/chain-check", { method: "POST" })).status).toBe(
      404,
    );
  });
});
