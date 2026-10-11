import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import type { Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVATION_MIN_TRADING_USDC_E6,
  ACTIVATION_STEPS,
  type ActivationCheckInput,
  type ActivationRecord,
  type ActivationStage,
  ActivationStore,
  type ActivationViewInput,
  activationChecks,
  activationStatus,
  activationSteps,
  activationView,
  blockingCheck,
} from "./activation.ts";

/**
 * The activation sweep's rules (F-U10): the checks before a sweep starts,
 * each named when it fails; the eight steps the owner watches, derived from
 * the records; the status and what the owner can do at the end; and the
 * store on Postgres.
 */
const CHAIN = 143143;
const ACCOUNT = "0x00000000000000000000000000000000000ac007" as Hex;

const ready = (): ActivationCheckInput => ({
  goal: { aggressiveness: "BALANCED", tier: "MEDIUM" },
  provisioned: true,
  account: ACCOUNT,
  mode: "NORMAL",
  tradingValueUsdcE6: 90_000_000n,
  spendableUsdcE6: 12_000_000n,
  restricted: false,
  ceilingUsdcE6: 3_800_000n,
  armingState: "unarmed",
  sweepOpen: false,
  cycleOpen: false,
});

describe("the checks before an activation sweep (F-U10, A-53)", () => {
  it("passes every check for a configured, funded, idle agent; the grant is a step to come, not a block", () => {
    const checks = activationChecks(ready());
    expect(checks.map((c) => c.code)).toEqual([
      "GOAL",
      "PROVISIONED",
      "ACCOUNT",
      "ACCOUNT_MODE",
      "TRADING_BALANCE",
      "CREDITS",
      "GRANT",
      "NOT_BUSY",
    ]);
    expect(checks.filter((c) => !c.ok).map((c) => c.code)).toEqual(["GRANT"]);
    expect(blockingCheck(checks)).toBeNull();
    expect(checks[0]?.message).toBe("Goal: Balanced on the Medium tier (Claude Sonnet 5.5).");
    expect(checks[4]?.message).toBe("The account holds 90.00 USDC to trade with.");
    expect(checks[5]?.message).toBe(
      "Credits cover the sweep: 12.00 USDC available, at most 3.80 USDC needed.",
    );
  });

  it("names each failure and what the owner can do", () => {
    expect(blockingCheck(activationChecks({ ...ready(), goal: null }))).toMatchObject({
      code: "GOAL",
      message: "Set a goal first: the sweep reads it to know how aggressive to be.",
    });
    expect(
      blockingCheck(activationChecks({ ...ready(), account: null, tradingValueUsdcE6: null })),
    ).toMatchObject({ code: "ACCOUNT" });
    expect(blockingCheck(activationChecks({ ...ready(), mode: "REDUCE_ONLY" }))).toMatchObject({
      code: "ACCOUNT_MODE",
      message: "The account is reduce only; automatic trading needs its normal mode.",
    });
    expect(
      blockingCheck(
        activationChecks({ ...ready(), tradingValueUsdcE6: ACTIVATION_MIN_TRADING_USDC_E6 - 1n }),
      ),
    ).toMatchObject({
      code: "TRADING_BALANCE",
      message:
        "The account holds 4.99 USDC; automatic trading needs at least 5.00 USDC. Deposit more first.",
    });
    expect(blockingCheck(activationChecks({ ...ready(), tradingValueUsdcE6: null }))).toMatchObject(
      { code: "TRADING_BALANCE" },
    );
    expect(
      blockingCheck(activationChecks({ ...ready(), spendableUsdcE6: 3_000_000n })),
    ).toMatchObject({
      code: "CREDITS",
      message:
        "Credits are short: 3.00 USDC available, the sweep may cost up to 3.80 USDC. Add USDC to the funding address first.",
    });
    expect(
      blockingCheck(activationChecks({ ...ready(), spendableUsdcE6: 0n, restricted: true })),
    ).toMatchObject({ code: "CREDITS" });
    expect(blockingCheck(activationChecks({ ...ready(), sweepOpen: true }))).toMatchObject({
      code: "NOT_BUSY",
      message: "A sweep is already under way for this agent.",
    });
    expect(blockingCheck(activationChecks({ ...ready(), cycleOpen: true }))).toMatchObject({
      code: "NOT_BUSY",
    });
    expect(blockingCheck(activationChecks({ ...ready(), provisioned: false }))).toMatchObject({
      code: "PROVISIONED",
    });
  });

  it("the trading balance is checked at exactly the minimum", () => {
    expect(
      blockingCheck(
        activationChecks({ ...ready(), tradingValueUsdcE6: ACTIVATION_MIN_TRADING_USDC_E6 }),
      ),
    ).toBeNull();
  });
});

const T0 = new Date("2026-10-10T20:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const record = (over: Partial<ActivationRecord> = {}): ActivationRecord => ({
  activationId: "act-00000000-0000-4000-8000-000000000001",
  chainId: CHAIN,
  agentId: 7,
  armingId: "arming-1",
  cycleId: "cycle-00000000-0000-4000-8000-000000000001",
  taskId: "task-1",
  reasoningAlias: "research-medium",
  tier: "MEDIUM",
  ceilingUsdcE6: 3_800_000n,
  checks: {
    aggressiveness: "BALANCED",
    tier: "MEDIUM",
    account: ACCOUNT,
    mode: "NORMAL",
    tradingValueUsdcE6: "90000000",
    spendableUsdcE6: "12000000",
  },
  market: null,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});
const stage = (
  s: ActivationStage["stage"],
  status: ActivationStage["status"],
  over: Partial<ActivationStage> = {},
): ActivationStage => ({
  stage: s,
  themeCode: null,
  status,
  stopReason: status === "completed" ? "COMPLETED" : null,
  chargedUsdcE6: 0n,
  ceilingUsdcE6: 0n,
  outcome: null,
  candidates: null,
  decision: null,
  startedAt: at(1),
  finishedAt: status === "pending" || status === "running" ? null : at(2),
  ...over,
});
const marketOk = {
  ok: true as const,
  tokens: 12,
  priced: 11,
  pools: 42,
  screensFresh: 9,
  startedAt: at(3).toISOString(),
  finishedAt: at(3).toISOString(),
};
const input = (over: Partial<ActivationViewInput> = {}): ActivationViewInput => ({
  activation: record(),
  cycle: { status: "running", stopReason: null, startedAt: at(0.5), finishedAt: null },
  stages: [],
  proposal: null,
  arming: { status: "awaiting_first_trade", endedReason: null },
  ...over,
});
const states = (i: ActivationViewInput) => activationSteps(i).map((s) => `${s.key}:${s.state}`);

describe("the sweep's steps as the owner watches them (F-U10)", () => {
  it("has the eight steps in order, the first done from the start and the Scan running while the sandbox boots", () => {
    expect(ACTIVATION_STEPS.map((s) => s.key)).toEqual([
      "account",
      "scan",
      "market",
      "dives",
      "challenge",
      "test",
      "plan",
      "active",
    ]);
    const steps = activationSteps(input());
    expect(steps.map((s) => s.state)).toEqual([
      "done",
      "running",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(steps[0]?.result).toBe(
      "Balanced on the Medium tier; 90.00 USDC to trade with; 12.00 USDC of credits.",
    );
    expect(activationStatus(input({ cycle: null }))).toBe("running");
    expect(states(input({ cycle: null }))[1]).toBe("scan:pending");
  });

  it("moves through the steps as the stages run, with each result a fixed line over the records and its cost against its ceiling", () => {
    const scan = stage("SCAN", "completed", {
      candidates: 3,
      chargedUsdcE6: 210_000n,
      ceilingUsdcE6: 500_000n,
    });
    // After the Scan, the pools and prices are being read.
    expect(states(input({ stages: [scan] }))).toEqual([
      "account:done",
      "scan:done",
      "market:running",
      "dives:pending",
      "challenge:pending",
      "test:pending",
      "plan:pending",
      "active:pending",
    ]);
    const withMarket = input({ activation: record({ market: marketOk }), stages: [scan] });
    const s = activationSteps(withMarket);
    expect(s[1]).toMatchObject({
      result: "3 themes worth a closer look.",
      chargedUsdcE6: "210000",
      ceilingUsdcE6: "500000",
    });
    expect(s[2]).toMatchObject({
      state: "done",
      result: "11 of 12 tokens priced across 42 pools; 9 safety screens fresh.",
    });
    expect(s[3]?.state).toBe("running");
    const dive1 = stage("DIVE", "completed", {
      themeCode: "WBTC_ADD",
      chargedUsdcE6: 900_000n,
      ceilingUsdcE6: 1_200_000n,
    });
    const dive2 = stage("DIVE", "running", { themeCode: "CHOG_ADD", ceilingUsdcE6: 1_200_000n });
    const mid = activationSteps({ ...withMarket, stages: [scan, dive1, dive2] });
    expect(mid[3]).toMatchObject({
      state: "running",
      result: "1 of 2 themes researched.",
      chargedUsdcE6: "900000",
      ceilingUsdcE6: "2400000",
    });
    const dive2Done = { ...dive2, status: "completed" as const, chargedUsdcE6: 1_000_000n };
    const challenge = stage("CHALLENGE", "completed", { candidates: 1, chargedUsdcE6: 150_000n });
    const test = stage("TEST", "completed");
    const zoom = stage("ZOOM_OUT", "completed", { decision: "PROPOSE", chargedUsdcE6: 400_000n });
    const done: ActivationViewInput = {
      ...withMarket,
      cycle: {
        status: "completed",
        stopReason: "COMPLETED",
        startedAt: at(0.5),
        finishedAt: at(20),
      },
      stages: [scan, dive1, dive2Done, challenge, test, zoom],
      proposal: {
        proposalId: "prop-1",
        kind: "proposal",
        status: "pending_owner",
        positions: 2,
        reasonCode: null,
      },
    };
    const end = activationSteps(done);
    expect(end.map((x) => x.state)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
      "done",
      "done",
      "running",
    ]);
    expect(end[3]?.result).toBe("2 themes researched: WBTC_ADD, CHOG_ADD.");
    expect(end[4]?.result).toBe("1 of 2 theses stand after the skeptic's review.");
    expect(end[5]?.result).toBe("Your limits and the envelope are set for the plan.");
    expect(end[6]?.result).toBe("A portfolio of 2 positions proposed.");
    expect(end[7]?.result).toBe("Waiting for your approval of the plan.");
    const view = activationView(done);
    expect(view.status).toBe("plan_ready");
    expect(view.chargedUsdcE6).toBe("2660000");
    expect(view.ceilingUsdcE6).toBe("3800000");
    expect(view.proposalId).toBe("prop-1");
    expect(view.outcome.action).toBe("approve");
    // Approved: active, the last step done.
    const active = {
      ...done,
      proposal: {
        ...(done.proposal as NonNullable<typeof done.proposal>),
        status: "applied" as const,
      },
    };
    expect(activationStatus(active)).toBe("active");
    expect(activationSteps(active)[7]).toMatchObject({
      state: "done",
      result: "The plan is approved; the agent trades toward it within your limits.",
    });
    // Disarmed afterwards: off, with the arming's reason.
    expect(
      activationView({ ...active, arming: { status: "ended", endedReason: "disarmed" } }),
    ).toMatchObject({
      status: "off",
      outcome: { action: "retry", message: expect.stringContaining("disarmed") },
    });
  });

  it("stops early: a failed step shows its reason, later steps are skipped, and the outcome says what to do", () => {
    const scan = stage("SCAN", "completed", { candidates: 2 });
    const dive = stage("DIVE", "stopped", { themeCode: "WBTC_ADD", stopReason: "BILLING" });
    const i = input({
      activation: record({ market: marketOk }),
      cycle: { status: "stopped", stopReason: "BILLING", startedAt: at(0.5), finishedAt: at(9) },
      stages: [scan, dive],
    });
    expect(states(i)).toEqual([
      "account:done",
      "scan:done",
      "market:done",
      "dives:failed",
      "challenge:skipped",
      "test:skipped",
      "plan:skipped",
      "active:skipped",
    ]);
    expect(activationSteps(i)[3]?.reason).toBe("the credits ran out");
    const view = activationView(i);
    expect(view.status).toBe("out_of_credits");
    expect(view.outcome).toEqual({
      title: "The agent ran out of credits",
      message:
        '"Researching in depth" failed: the credits ran out. Nothing was traded; only the steps that ran were charged. Add USDC to the funding address, then try again.',
      action: "add_credits",
    });
    // A cap: the Scan stopped at its turn cap with no brief, and the cycle with it.
    const capped = input({
      cycle: { status: "stopped", stopReason: "TURN_CAP", startedAt: at(0.5), finishedAt: at(9) },
      stages: [stage("SCAN", "capped", { stopReason: "TURN_CAP" })],
    });
    expect(states(capped).slice(1, 4)).toEqual(["scan:capped", "market:skipped", "dives:skipped"]);
    expect(activationView(capped)).toMatchObject({
      status: "capped",
      outcome: { title: "The sweep stopped at a limit", action: "retry" },
    });
    expect(activationView(capped).outcome.message).toContain(
      '"Scanning the market" stopped: the step used all its model turns.',
    );
    // The pools and prices could not be read.
    const market = input({
      activation: record({
        market: {
          ok: false,
          error: "the pools and prices could not be read",
          startedAt: at(3).toISOString(),
          finishedAt: at(3).toISOString(),
        },
      }),
      cycle: {
        status: "failed",
        stopReason: "MARKET_UNAVAILABLE",
        startedAt: at(0.5),
        finishedAt: at(4),
      },
      stages: [scan],
    });
    expect(states(market).slice(1, 5)).toEqual([
      "scan:done",
      "market:failed",
      "dives:skipped",
      "challenge:skipped",
    ]);
    expect(activationView(market)).toMatchObject({
      status: "failed",
      outcome: { action: "retry" },
    });
    // The sweep failed before any stage ran (the sandbox never opened).
    const early = input({
      cycle: { status: "failed", stopReason: "FAILED", startedAt: null, finishedAt: at(1) },
    });
    expect(states(early).slice(1, 3)).toEqual(["scan:skipped", "market:skipped"]);
    expect(activationView(early).outcome.title).toBe("The sweep did not finish");
  });

  it("ends without a plan when the Zoom out keeps no change, and names a declined, expired or rejected plan", () => {
    const stages = [
      stage("SCAN", "completed", { candidates: 1 }),
      stage("DIVE", "completed", { themeCode: "MON_FLOW" }),
      stage("CHALLENGE", "completed", { candidates: 0 }),
      stage("TEST", "completed"),
      stage("ZOOM_OUT", "completed", { decision: "NO_CHANGE" }),
    ];
    const completed = {
      status: "completed" as const,
      stopReason: "COMPLETED",
      startedAt: at(0.5),
      finishedAt: at(20),
    };
    const none = input({
      activation: record({ market: marketOk }),
      cycle: completed,
      stages,
      proposal: {
        proposalId: "prop-nc",
        kind: "no_change",
        status: "recorded",
        positions: 0,
        reasonCode: "EVIDENCE_THIN",
      },
    });
    expect(activationSteps(none)[6]?.result).toBe("No plan proposed: evidence thin.");
    expect(activationView(none)).toMatchObject({
      status: "no_plan",
      proposalId: null,
      outcome: { title: "No plan yet", action: "retry" },
    });
    const proposal = (status: "declined" | "expired" | "rejected") =>
      input({
        activation: record({ market: marketOk }),
        cycle: completed,
        stages: [...stages.slice(0, 4), stage("ZOOM_OUT", "completed", { decision: "PROPOSE" })],
        proposal: {
          proposalId: "prop-1",
          kind: "proposal",
          status,
          positions: 1,
          reasonCode: null,
        },
      });
    expect(activationView(proposal("declined"))).toMatchObject({
      status: "declined",
      outcome: { title: "You declined the plan", action: "retry" },
    });
    expect(activationSteps(proposal("declined"))[7]).toMatchObject({
      state: "skipped",
      reason: "you declined the plan",
    });
    expect(activationView(proposal("expired")).status).toBe("expired");
    expect(activationView(proposal("rejected"))).toMatchObject({
      status: "failed",
      outcome: { title: "The sweep did not finish" },
    });
    // The Zoom out capped with no decision at all: the sweep stopped at a limit.
    const capped = input({
      activation: record({ market: marketOk }),
      cycle: { ...completed, stopReason: "TURN_CAP" },
      stages: [...stages.slice(0, 4), stage("ZOOM_OUT", "capped", { stopReason: "TURN_CAP" })],
    });
    expect(activationView(capped).status).toBe("capped");
  });
});

const dbUp = await databaseAvailable();

describe.skipIf(!dbUp)("the activation store (needs pnpm dev:up for Postgres)", () => {
  let t: TestDatabase;
  let store: ActivationStore;
  beforeAll(async () => {
    t = await createTestDatabase("activation");
    store = new ActivationStore(t.db);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    for (const table of [
      "platform.activations",
      "platform.plan_proposals",
      "platform.stage_records",
      "platform.stage_runs",
      "platform.research_cycles",
      "platform.arming",
    ] as const)
      await t.db.deleteFrom(table).execute();
  });

  const cycle = async (cycleId: string, status: "queued" | "running" | "completed") => {
    await t.db
      .insertInto("platform.research_cycles")
      .values({
        cycle_id: cycleId,
        chain_id: CHAIN,
        agent_id: 7,
        task_id: `task-${cycleId}`,
        kind: "ACTIVATION",
        status,
        reasoning_alias: "research-medium",
        canary: "AACANARY-test",
        ...(status === "completed" ? { stop_reason: "COMPLETED", finished_at: at(20) } : {}),
      })
      .execute();
  };

  it("creates, names its cycle, records the market read, and finds the newest, the open one and the one for a cycle", async () => {
    const a = await store.create({
      chainId: CHAIN,
      agentId: 7,
      armingId: null,
      reasoningAlias: "research-medium",
      tier: "MEDIUM",
      ceilingUsdcE6: 3_800_000n,
      checks: record().checks,
      now: T0,
    });
    expect(a).toMatchObject({
      tier: "MEDIUM",
      ceilingUsdcE6: 3_800_000n,
      cycleId: null,
      market: null,
    });
    expect(await store.latest(CHAIN, 7)).toMatchObject({ activationId: a.activationId });
    expect(await store.open(CHAIN, 7)).toBeNull();
    await cycle("cycle-1", "running");
    await store.setCycle(a.activationId, "cycle-1", "task-cycle-1");
    expect(await store.open(CHAIN, 7)).toMatchObject({ activationId: a.activationId });
    expect(await store.forCycle("cycle-1")).toMatchObject({ activationId: a.activationId });
    await store.setMarket(a.activationId, marketOk);
    expect((await store.get(a.activationId))?.market).toEqual(marketOk);
    // A second, newer activation is the latest; the first is still the open one until its cycle ends.
    const b = await store.create({
      chainId: CHAIN,
      agentId: 7,
      armingId: null,
      reasoningAlias: "research-low",
      tier: "LOW",
      ceilingUsdcE6: 3_800_000n,
      checks: record().checks,
      now: at(30),
    });
    expect((await store.latest(CHAIN, 7))?.activationId).toBe(b.activationId);
    expect((await store.open(CHAIN, 7))?.activationId).toBe(a.activationId);
    expect(await store.latest(CHAIN, 8)).toBeNull();
  });

  it("reads the view's inputs from the cycle, its stage runs with their records, the proposal and the arming", async () => {
    await t.db
      .insertInto("platform.arming")
      .values({
        arming_id: "arming-1",
        chain_id: CHAIN,
        agent_id: 7,
        owner: "0x00000000000000000000000000000000000a11ce",
        owner_epoch: "1",
        config_epoch: "0",
        session_key: "0x00000000000000000000000000000000000f00d7",
        valid_until: "1800000000",
        status: "awaiting_first_trade",
      })
      .execute();
    const a = await store.create({
      chainId: CHAIN,
      agentId: 7,
      armingId: "arming-1",
      reasoningAlias: "research-medium",
      tier: "MEDIUM",
      ceilingUsdcE6: 3_800_000n,
      checks: record().checks,
      now: T0,
    });
    await cycle("cycle-2", "completed");
    await store.setCycle(a.activationId, "cycle-2", "task-cycle-2");
    const runs = [
      ["SCAN", null, "completed", "210000", "500000"],
      ["DIVE", "WBTC_ADD", "completed", "900000", "1200000"],
      ["ZOOM_OUT", null, "completed", "400000", "600000"],
    ] as const;
    for (const [i, [s, theme, status, charged, ceiling]] of runs.entries()) {
      await t.db
        .insertInto("platform.stage_runs")
        .values({
          stage_run_id: `stage-run-${i}`,
          cycle_id: "cycle-2",
          chain_id: CHAIN,
          agent_id: 7,
          seq: i + 1,
          stage: s,
          theme_code: theme,
          idempotency_key: `k-${i}`,
          model_alias: "research-medium",
          caps: "{}",
          ceiling_usdc_e6: ceiling,
          status,
          stop_reason: "COMPLETED",
          charged_usdc_e6: charged,
          started_at: at(1 + i),
          finished_at: at(2 + i),
        })
        .execute();
    }
    await t.db
      .insertInto("platform.stage_records")
      .values([
        {
          stage_id: "stage-a",
          chain_id: CHAIN,
          agent_id: 7,
          lease_id: "lease-1",
          stage: "SCAN",
          outcome: "DONE",
          candidates: JSON.stringify([{ asset: "WBTC" }, { asset: "CHOG" }]),
          stage_run_id: "stage-run-0",
        },
        {
          stage_id: "stage-b",
          chain_id: CHAIN,
          agent_id: 7,
          lease_id: "lease-1",
          stage: "ZOOM_OUT",
          outcome: "DONE",
          candidates: "[]",
          stage_run_id: "stage-run-2",
          decision: JSON.stringify({ kind: "PROPOSE", template: "target_portfolio@1" }),
        },
      ])
      .execute();
    await t.db
      .insertInto("platform.plan_proposals")
      .values({
        proposal_id: "prop-00000000-0000-4000-8000-000000000002",
        chain_id: CHAIN,
        agent_id: 7,
        cycle_id: "cycle-2",
        stage_run_id: "stage-run-2",
        kind: "proposal",
        strategy_epoch: "1",
        owner_epoch: "1",
        template: "target_portfolio@1",
        params: "{}",
        params_hash: "0x00",
        rationale: "{}",
        positions: JSON.stringify([{ token: "0x1" }, { token: "0x2" }]),
        evaluation: "{}",
        status: "pending_owner",
        needs_approval: true,
        reason_code: null,
        explanation: null,
        decided_by: null,
        decided_at: null,
        plan_param_id: null,
        created_at: at(19),
        expires_at: at(19 + 24 * 60),
      })
      .execute();
    const i = await store.inputs((await store.get(a.activationId)) as ActivationRecord);
    expect(i.cycle).toMatchObject({ status: "completed", stopReason: "COMPLETED" });
    expect(i.stages.map((s) => [s.stage, s.themeCode, s.candidates, s.decision])).toEqual([
      ["SCAN", null, 2, null],
      ["DIVE", "WBTC_ADD", null, null],
      ["ZOOM_OUT", null, 0, "PROPOSE"],
    ]);
    expect(i.stages[0]).toMatchObject({ chargedUsdcE6: 210_000n, ceilingUsdcE6: 500_000n });
    expect(i.proposal).toEqual({
      proposalId: "prop-00000000-0000-4000-8000-000000000002",
      kind: "proposal",
      status: "pending_owner",
      positions: 2,
      reasonCode: null,
    });
    expect(i.arming).toEqual({ status: "awaiting_first_trade", endedReason: null });
    const view = activationView(i);
    expect(view.status).toBe("plan_ready");
    expect(view.chargedUsdcE6).toBe("1510000");
    // The cycle has ended, so the steps it never ran read as skipped.
    expect(view.steps.map((s) => s.state)).toEqual([
      "done",
      "done",
      "skipped",
      "done",
      "skipped",
      "skipped",
      "done",
      "running",
    ]);
  });
});
