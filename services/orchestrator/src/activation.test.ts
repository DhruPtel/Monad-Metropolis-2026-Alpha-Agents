import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { DEFAULT_GOAL_INPUT, type GoalInput } from "@alpha-agents/domain";
import { translateGoal } from "@alpha-agents/policy";
import { GoalStore, ProposalStore, TradeStore, VAULT_GRANT_NO_EXPIRY } from "@alpha-agents/trading";
import type { Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACTIVATION_STALL_MS, ActivationService } from "./activation.ts";
import type { CreditService } from "./credits/service.ts";
import { CycleStore } from "./cycle/store.ts";
import type { TestInputsV2 } from "./cycle/test-stage.ts";
import { MemoryGateway } from "./gateway-admin.ts";
import { LeaseManager } from "./leases.ts";
import {
  type ActivationFacts,
  type Narrator,
  templateActivationEntry,
  validateNarration,
} from "./narrator.ts";
import { Provisioner } from "./provisioner.ts";
import { MemoryProvider } from "./sandbox.ts";
import { Redactor } from "./secrets.ts";
import { type AgentRef, Store } from "./store.ts";
import { CHAIN, indexAgent, must } from "./testing.ts";

/**
 * The activation service (F-U10) on Postgres with the chain, the credits and
 * the narrator faked: every check named when it fails, the sweep queued as
 * the owner's task and recorded, the "pools and prices" hook after the Scan,
 * the end hook, and entries that pass the number validator.
 */
const dbUp = await databaseAvailable();
const ref: AgentRef = { chainId: CHAIN, agentId: 1 };
const OWNER = "0x00000000000000000000000000000000000a11ce" as Hex;
const KEY = "0x00000000000000000000000000000000000f00d1" as Hex;
const ACCOUNT = "0x00000000000000000000000000000000000ac001" as Hex;
const VAULT = "0x00000000000000000000000000000000000a0a0a" as Hex;
const USDC = "0x00000000000000000000000000000000000000c1" as Hex;
const WMON = "0x00000000000000000000000000000000000000c2" as Hex;
const WBTC = "0x00000000000000000000000000000000000000c3" as Hex;
const E18 = 10n ** 18n;

describe.skipIf(!dbUp)(
  "the activation sweep's service (needs Postgres)",
  { timeout: 60_000 },
  () => {
    let t: TestDatabase;
    let store: Store;
    let goals: GoalStore;
    let trades: TradeStore;
    let cycles: CycleStore;
    const credits = { spendable: 12_000_000n, restricted: false };
    const agent = {
      account: ACCOUNT as Hex | null,
      mode: "NORMAL" as "NORMAL" | "REDUCE_ONLY",
      nav: 90_000_000n as bigint | null,
      // Step 0 (2026-10-12): the reader resolves the vault when the agent manages it.
      isVault: false,
      managed: "personal" as "personal" | "vault",
    };
    let inputs: TestInputsV2 | null = null;
    const entries: { key: string; facts: ActivationFacts }[] = [];
    const queued: string[] = [];
    let enqueueFails: string | null = null;
    let service: ActivationService;

    beforeAll(async () => {
      t = await createTestDatabase("orch_activation");
      store = new Store(t.db);
      goals = new GoalStore(t.db);
      trades = new TradeStore(t.db);
      cycles = new CycleStore(t.db);
      const redactor = new Redactor();
      await indexAgent(t.db, 1, "pro", OWNER);
      await new Provisioner({
        store,
        gateway: new MemoryGateway(),
        leases: new LeaseManager({
          store,
          provider: new MemoryProvider(),
          namespace: "unit",
          runTag: "r",
          redactor,
          log: () => undefined,
        }),
        namespace: "unit",
        secret: "test-orchestrator-secret-0123456789abcdef",
        redactor,
        log: () => undefined,
        startingBudgetUsd: 0.5,
      }).provision(ref);
    });
    afterAll(async () => {
      await t?.drop();
    });

    const market = () => ({
      usdc: USDC,
      wmon: WMON,
      tokens: [
        { token: USDC, symbol: "USDC", decimals: 6 },
        { token: WMON, symbol: "WMON", decimals: 18 },
        { token: WBTC, symbol: "WBTC", decimals: 8 },
      ],
      prices: {
        [USDC]: { priceE18: E18, updatedAt: 1n, reason: "OK" },
        [WMON]: { priceE18: 25n * 10n ** 15n, updatedAt: 1n, reason: "OK" },
        [WBTC]: { priceE18: 0n, updatedAt: 1n, reason: "STALE" },
      },
      pools: [{ poolId: "0x01" }, { poolId: "0x02" }, { poolId: "0x03" }],
    });
    const okInputs = () =>
      ({
        market: market(),
        screenFresh: async (token: Hex) => token === WMON,
      }) as unknown as TestInputsV2;

    beforeEach(async () => {
      for (const table of [
        "platform.activations",
        "platform.plan_proposals",
        "platform.stage_runs",
        "platform.research_cycles",
        "platform.agent_tasks",
        "platform.arming",
        "platform.agent_goals",
        "platform.agent_state_changes",
        "platform.agent_states",
      ] as const)
        await t.db.deleteFrom(table).execute();
      credits.spendable = 12_000_000n;
      credits.restricted = false;
      agent.account = ACCOUNT;
      agent.mode = "NORMAL";
      agent.nav = 90_000_000n;
      agent.isVault = false;
      agent.managed = "personal";
      inputs = okInputs();
      entries.length = 0;
      queued.length = 0;
      enqueueFails = null;
      service = new ActivationService({
        store,
        cycles,
        goals,
        trades,
        credits: { creditsOf: async () => ({ ...credits }) } as unknown as CreditService,
        narrator: {
          narrateEvent: async (_c: number, _a: number, key: string, facts: ActivationFacts) => {
            entries.push({ key, facts });
            return null;
          },
        } as unknown as Narrator,
        readerV3: {
          agent: async () => ({
            account: agent.account,
            mode: agent.mode,
            values: agent.nav === null ? null : { nav: agent.nav },
            isVault: agent.isVault,
            managed: agent.managed,
          }),
        } as never,
        inputs: async () => inputs,
        enqueueCycle: async (r, kind, requestedBy) => {
          if (enqueueFails) throw new Error(enqueueFails);
          const taskId = `task-${queued.length + 1}`;
          await store.insertTask(taskId, r, "cycle", requestedBy);
          const goal = must(await goals.currentGoal(r.chainId, r.agentId));
          const cycle = await cycles.createCycle({
            ref: r,
            taskId,
            kind,
            reasoningAlias: goal.config.model.alias,
          });
          queued.push(`${kind} by ${requestedBy}`);
          return { taskId, cycleId: cycle.cycleId };
        },
        log: () => undefined,
      });
    });

    const saveGoal = async (tier: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM") => {
      const r = translateGoal({ ...DEFAULT_GOAL_INPUT, modelTier: tier } as GoalInput);
      if (!r.ok) throw new Error("goal");
      await goals.save({
        chainId: CHAIN,
        agentId: 1,
        ownerEpoch: 0n,
        savedBy: OWNER,
        config: r.config,
      });
    };
    const grant = () =>
      trades.startArming({
        chainId: CHAIN,
        agentId: 1,
        owner: OWNER,
        ownerEpoch: 0n,
        configEpoch: 0n,
        sessionKey: KEY,
        validUntil: 1_900_000_000n,
        custody: "v3",
        executor: "0x00000000000000000000000000000000000e0ec3",
      });
    const refused = async () => {
      const r = await service.start(ref);
      if (r.ok) throw new Error("started");
      return r;
    };

    it("names each failing check, in order, and starts nothing", async () => {
      expect(await refused()).toMatchObject({
        code: "GOAL",
        message: "Set a goal first: the sweep reads it to know how aggressive to be.",
      });
      await saveGoal();
      agent.account = null;
      agent.nav = null;
      expect((await refused()).code).toBe("ACCOUNT");
      agent.account = ACCOUNT;
      agent.mode = "REDUCE_ONLY";
      expect((await refused()).code).toBe("ACCOUNT_MODE");
      agent.mode = "NORMAL";
      agent.nav = 4_000_000n;
      expect((await refused()).code).toBe("TRADING_BALANCE");
      agent.nav = 90_000_000n;
      credits.spendable = 1_000_000n;
      expect(await refused()).toMatchObject({
        code: "CREDITS",
        message:
          "Credits are short: 1.00 USDC available, the sweep may cost up to 2.35 USDC. Add USDC to the funding address first.",
      });
      credits.spendable = 12_000_000n;
      expect(await refused()).toMatchObject({
        code: "GRANT",
        message:
          "Register the agent's trading permission from your wallet first; the sweep starts once it is on chain.",
      });
      expect(queued).toEqual([]);
      expect(await service.store.latest(CHAIN, 1)).toBeNull();
      expect(entries).toEqual([]);
      // The High tier doubles the reasoning stages' ceilings (A-51).
      await saveGoal("HIGH");
      expect((await service.view(ref)).ceilingUsdcE6).toBe("4950000");
      expect(ActivationService.ceilingFor("research-medium")).toBe(2_350_000n);
    });

    it("starts the sweep: the checks pass, the cycle is queued as the owner's task, the record names it, and the first entries are written", async () => {
      await saveGoal();
      await grant();
      const r = await service.start(ref);
      if (!r.ok) throw new Error(r.message);
      expect(queued).toEqual(["ACTIVATION by owner"]);
      const record = must(await service.store.latest(CHAIN, 1));
      expect(record).toMatchObject({
        tier: "MEDIUM",
        reasoningAlias: "research-medium",
        ceilingUsdcE6: 2_350_000n,
        cycleId: expect.stringMatching(/^cycle-/),
        taskId: "task-1",
        checks: {
          aggressiveness: "BALANCED",
          tier: "MEDIUM",
          account: ACCOUNT,
          mode: "NORMAL",
          tradingValueUsdcE6: "90000000",
          spendableUsdcE6: "12000000",
        },
      });
      expect(record.armingId).toBe((await trades.openArming(CHAIN, 1))?.armingId);
      expect(r.activation).toMatchObject({
        status: "running",
        ceilingUsdcE6: "2350000",
        chargedUsdcE6: "0",
        tier: { choice: "MEDIUM", label: "Medium" },
      });
      expect(r.activation.steps.map((s) => s.state)).toEqual([
        "done",
        "pending",
        "pending",
        "pending",
        "pending",
        "pending",
        "pending",
        "pending",
      ]);
      expect(entries.map((e) => e.key)).toEqual([
        `${record.activationId}:started`,
        `${record.activationId}:step:reading-your-goal-and-account`,
      ]);
      for (const e of entries) {
        const text = templateActivationEntry(e.facts);
        expect(validateNarration(text, e.facts)).toEqual({ ok: true });
      }
      expect(templateActivationEntry(must(entries[0]).facts)).toBe(
        "Alpha Agent #1 started its activation sweep on the Medium tier: at most 2.35 USDC of credits, and nothing is traded until the owner approves the plan.",
      );
      expect(templateActivationEntry(must(entries[1]).facts)).toBe(
        "Alpha Agent #1's activation sweep, reading your goal and account: Balanced on the Medium tier; 90 USDC to trade with; 12 USDC of credits.",
      );
      // A second start while the sweep runs is refused as busy.
      expect(await refused()).toMatchObject({
        code: "NOT_BUSY",
        message: "A sweep is already under way for this agent.",
      });
      // The owner's read carries the sweep and the checks as they stand now.
      const view = await service.view(ref);
      expect(view.activation?.activationId).toBe(record.activationId);
      expect(view.checks.find((c) => c.code === "NOT_BUSY")?.ok).toBe(false);
      expect(view.checks.find((c) => c.code === "GRANT")?.ok).toBe(true);
    });

    it("ends a sweep whose cycle has sat queued for over an hour as STALLED, with the owner's words (P-SWEEP)", async () => {
      await saveGoal();
      await grant();
      const r = await service.start(ref);
      if (!r.ok) throw new Error(r.message);
      const record = must(await service.store.latest(CHAIN, 1));
      const cycleId = must(record.cycleId);
      // Still queued after 30 minutes: left alone.
      await store.db
        .updateTable("platform.research_cycles")
        .set({ created_at: new Date(Date.now() - 30 * 60_000) })
        .where("cycle_id", "=", cycleId)
        .execute();
      expect((await service.view(ref)).activation?.status).toBe("running");
      // Queued for over an hour: a lost worker; the sweep ends and says so.
      await store.db
        .updateTable("platform.research_cycles")
        .set({ created_at: new Date(Date.now() - ACTIVATION_STALL_MS - 60_000) })
        .where("cycle_id", "=", cycleId)
        .execute();
      const view = must((await service.view(ref)).activation);
      expect(view.status).toBe("failed");
      expect(view.outcome.message).toMatch(/stopped moving for an hour/);
      expect(await cycles.cycle(cycleId)).toMatchObject({
        status: "failed",
        stopReason: "STALLED",
      });
    });

    it("starts the sweep for the agent's vault under the grant without expiry, recording the vault as the account (Step 0, 2026-10-12; D-241)", async () => {
      await saveGoal();
      agent.account = VAULT;
      agent.isVault = true;
      agent.managed = "vault";
      await trades.startArming({
        chainId: CHAIN,
        agentId: 1,
        owner: OWNER,
        ownerEpoch: 0n,
        configEpoch: 0n,
        sessionKey: KEY,
        validUntil: VAULT_GRANT_NO_EXPIRY,
        custody: "v3",
        executor: "0x00000000000000000000000000000000000e0ec3",
      });
      const before = await service.view(ref);
      expect(before.checks.find((c) => c.code === "ACCOUNT")).toMatchObject({ ok: true });
      expect(before.checks.find((c) => c.code === "GRANT")).toMatchObject({ ok: true });
      const r = await service.start(ref);
      expect(r.ok).toBe(true);
      const record = must(await service.store.latest(CHAIN, 1));
      expect(record.checks).toMatchObject({ account: VAULT, tradingValueUsdcE6: "90000000" });
      expect(queued).toEqual(["ACTIVATION by owner"]);
    });

    it("leaves no record when the cycle cannot be queued, and names why", async () => {
      await saveGoal();
      await grant();
      enqueueFails = "Agent 1 has no credits left: add USDC to its funding address.";
      expect(await refused()).toMatchObject({ code: "CREDITS" });
      expect(await service.store.latest(CHAIN, 1)).toBeNull();
      expect(entries).toEqual([]);
    });

    it("the hook after the Scan records the pools and prices step and narrates it; a cycle without a sweep is left alone", async () => {
      await saveGoal();
      await grant();
      const r = await service.start(ref);
      if (!r.ok) throw new Error(r.message);
      const record = must(await service.store.latest(CHAIN, 1));
      const cycle = must(await cycles.cycle(must(record.cycleId)));
      expect(await service.hooks().afterScan?.(cycle, {} as never)).toEqual({ ok: true });
      const after = must(await service.store.get(record.activationId));
      expect(after.market).toMatchObject({
        ok: true,
        tokens: 2,
        priced: 1,
        pools: 3,
        screensFresh: 1,
      });
      const step = must(entries.find((e) => e.key.endsWith(":step:reading-pools-and-prices")));
      expect(templateActivationEntry(step.facts)).toBe(
        "Alpha Agent #1's activation sweep, reading pools and prices: 1 of 2 tokens priced across 3 pools; 1 safety screens fresh.",
      );
      expect(validateNarration(templateActivationEntry(step.facts), step.facts)).toEqual({
        ok: true,
      });
      // A plain cycle, not a sweep.
      const other = await cycles.createCycle({
        ref,
        taskId: "task-x",
        kind: "ROUTINE",
        reasoningAlias: "research-medium",
      });
      await store.insertTask("task-x", ref, "cycle", "console");
      expect(await service.hooks().afterScan?.(other, {} as never)).toEqual({ ok: true });
      expect(entries.filter((e) => e.key.includes("pools"))).toHaveLength(1);
    });

    it("fails the sweep when the pools and prices cannot be read, with the reason recorded and narrated", async () => {
      await saveGoal();
      await grant();
      const r = await service.start(ref);
      if (!r.ok) throw new Error(r.message);
      inputs = null;
      const record = must(await service.store.latest(CHAIN, 1));
      const cycle = must(await cycles.cycle(must(record.cycleId)));
      expect(await service.hooks().afterScan?.(cycle, {} as never)).toMatchObject({
        ok: false,
        reason: "MARKET_UNAVAILABLE",
      });
      expect(must(await service.store.get(record.activationId)).market).toMatchObject({
        ok: false,
        error: expect.stringContaining("could not be read"),
      });
      expect(entries.at(-1)?.facts.result).toBe("failed: the pools and prices could not be read");
    });

    it("the end hook narrates the sweep's end with its status and cost, and the view says what the owner can do", async () => {
      await saveGoal();
      await grant();
      const r = await service.start(ref);
      if (!r.ok) throw new Error(r.message);
      const record = must(await service.store.latest(CHAIN, 1));
      const cycleId = must(record.cycleId);
      await cycles.startCycle(cycleId, "lease-1");
      const cycle = must(await cycles.cycle(cycleId));
      const zoom = await cycles.addStage({
        cycle,
        seq: 1,
        stage: "ZOOM_OUT",
        themeCode: null,
        modelAlias: "research-medium",
        caps: { turns: 10, paidCalls: 2, tokens: 350_000, seconds: 360 },
        ceilingUsdcE6: 600_000n,
      });
      await cycles.beginStage(zoom.stageRunId, "lease-1");
      await cycles.endStage(zoom.stageRunId, "lease-1", {
        status: "completed",
        stopReason: "COMPLETED",
      });
      await t.db
        .updateTable("platform.stage_runs")
        .set({ charged_usdc_e6: "410000" })
        .where("stage_run_id", "=", zoom.stageRunId)
        .execute();
      await cycles.finishCycle(cycleId, "completed", "COMPLETED");
      await new ProposalStore(t.db).create({
        chainId: CHAIN,
        agentId: 1,
        cycleId,
        stageRunId: zoom.stageRunId,
        strategyEpoch: 1n,
        ownerEpoch: 0n,
        plan: {
          template: "rebalance_bands@1",
          params: {
            targetWmonBps: 2_000,
            bandHalfWidthBps: 500,
            minTradeUsdcE6: 1_000_000n,
            volatilityBrakeBps: 20_000,
            costHurdleBps: 40,
            maxLegBps: 1_000,
          },
        },
        rationale: {
          decision: "PROPOSE",
          reasonCode: null,
          portfolioView: "A first plan.",
          evidenceStrength: "mixed",
          whatWouldChangeIt: "A pool thinning out.",
          themeCodes: [],
          points: [],
        },
        positions: [],
        evaluation: {
          checkedAt: new Date().toISOString(),
          passed: true,
          findings: [],
          cost: null,
          approval: "first_plan_after_arming",
        },
        status: "pending_owner",
        needsApproval: true,
      });
      await service.hooks().onEnd?.(must(await cycles.cycle(cycleId)));
      const end = must(entries.find((e) => e.key.endsWith(":finished")));
      expect(templateActivationEntry(end.facts)).toBe(
        "Alpha Agent #1's activation sweep ended: a plan waits for the owner's approval. It cost 0.41 of at most 2.35 USDC. A portfolio of 0 positions proposed.",
      );
      expect(validateNarration(templateActivationEntry(end.facts), end.facts)).toEqual({
        ok: true,
      });
      const view = must((await service.view(ref)).activation);
      expect(view).toMatchObject({
        status: "plan_ready",
        chargedUsdcE6: "410000",
        outcome: { title: "Your approval is needed", action: "approve" },
      });
      expect(view.steps.map((s) => `${s.key}:${s.state}`)).toEqual([
        "account:done",
        "scan:skipped",
        "market:skipped",
        "dives:skipped",
        "challenge:skipped",
        "test:skipped",
        "plan:done",
        "active:running",
      ]);
    });
  },
);
