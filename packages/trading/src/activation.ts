import { randomUUID } from "node:crypto";
import type { Db } from "@alpha-agents/db";
import {
  AGGRESSIVENESS_FACTS,
  ARMING_END_MESSAGES,
  type AccountMode,
  type Aggressiveness,
  type ArmingState,
  MODEL_TIER_FACTS,
  type ModelTier,
} from "@alpha-agents/domain";
import type { Hex } from "viem";
import type { ArmingRecord } from "./arming.ts";
import type { ProposalStatus } from "./proposals.ts";

/**
 * The activation sweep (F-U10, D-279, D-291): when the owner turns on
 * automatic trading, the agent runs one full research cycle (Scan, Dives,
 * Challenge, Test, Zoom out) and its result becomes the first plan, which
 * always waits for the owner; approving it completes the arming and lets the
 * runner trade. This module holds the pure rules: the checks before a sweep
 * may start, each named when it fails; the eight steps the owner watches,
 * derived from the activation's record, the cycle's stage runs and the plan
 * proposal, every result a fixed template over records and never model
 * text; and what happened and what the owner can do when a sweep ends
 * without a plan in force.
 */

/** A-53: the trading account must be worth at least this much to turn automatic trading on. */
export const ACTIVATION_MIN_TRADING_USDC_E6 = 5_000_000n;

export const ACTIVATION_STEPS = [
  { key: "account", label: "Reading your goal and account" },
  { key: "scan", label: "Scanning the market" },
  { key: "market", label: "Reading pools and prices" },
  { key: "dives", label: "Researching in depth" },
  { key: "challenge", label: "Checking risk" },
  { key: "test", label: "Testing the plan against your limits" },
  { key: "plan", label: "Building a plan" },
  { key: "active", label: "Active" },
] as const;
export type ActivationStepKey = (typeof ACTIVATION_STEPS)[number]["key"];

// ---- the checks before a sweep starts ----------------------------------------

export const ACTIVATION_CHECK_CODES = [
  "GOAL",
  "PROVISIONED",
  "ACCOUNT",
  "ACCOUNT_MODE",
  "TRADING_BALANCE",
  "CREDITS",
  "GRANT",
  "NOT_BUSY",
] as const;
export type ActivationCheckCode = (typeof ACTIVATION_CHECK_CODES)[number];

export interface ActivationCheckInput {
  /** The saved goal's level and tier, or null without a goal. */
  readonly goal: { readonly aggressiveness: Aggressiveness; readonly tier: ModelTier } | null;
  /** Whether the agent's runtime is provisioned (it is, within a minute of the mint). */
  readonly provisioned: boolean;
  /** The agent's trading account on the fund agent's set, or null before it is opened. */
  readonly account: Hex | null;
  readonly mode: AccountMode | null;
  /** The account's value in USDC base units; null while a held token has no usable price. */
  readonly tradingValueUsdcE6: bigint | null;
  readonly spendableUsdcE6: bigint;
  readonly restricted: boolean;
  /** The sweep's ceiling for the goal's tier (every stage's ceiling, Dives twice). */
  readonly ceilingUsdcE6: bigint;
  readonly armingState: ArmingState;
  /** A sweep already queued or running, or a research cycle under way. */
  readonly sweepOpen: boolean;
  readonly cycleOpen: boolean;
}

export interface ActivationCheck {
  readonly code: ActivationCheckCode;
  readonly ok: boolean;
  /** One line: what passed, or what fails and what the owner can do. */
  readonly message: string;
  /**
   * Whether a failure stops the owner from pressing the button. The grant is
   * registered by the owner's wallet as part of turning trading on, so its
   * absence is a step to come rather than a block.
   */
  readonly blocking: boolean;
}

/** Two decimals, truncated (L-94): a balance is never shown as more than it is. */
const usdc = (e6: bigint) => {
  const cents = e6 / 10_000n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")} USDC`;
};

/** Every check in order, each with whether it passed and one line the owner reads. */
export function activationChecks(i: ActivationCheckInput): ActivationCheck[] {
  const out: ActivationCheck[] = [];
  const push = (code: ActivationCheckCode, ok: boolean, message: string, blocking = true) =>
    out.push({ code, ok, message, blocking });
  push(
    "GOAL",
    i.goal !== null,
    i.goal
      ? `Goal: ${AGGRESSIVENESS_FACTS[i.goal.aggressiveness].label} on the ${MODEL_TIER_FACTS[i.goal.tier].label} tier (${MODEL_TIER_FACTS[i.goal.tier].model}).`
      : "Set a goal first: the sweep reads it to know how aggressive to be.",
  );
  push(
    "PROVISIONED",
    i.provisioned,
    i.provisioned
      ? "The agent is set up to run."
      : "The agent is not set up to run yet; try again in a minute.",
  );
  push(
    "ACCOUNT",
    i.account !== null,
    i.account
      ? "The trading account is open on the fund agent's set."
      : "Open the trading account and deposit USDC first.",
  );
  push(
    "ACCOUNT_MODE",
    i.account === null || i.mode === "NORMAL",
    i.account === null
      ? "The account's mode is checked once it is open."
      : i.mode === "NORMAL"
        ? "The account is in its normal mode."
        : `The account is ${(i.mode ?? "unknown").toLowerCase().replace("_", " ")}; automatic trading needs its normal mode.`,
  );
  const value = i.tradingValueUsdcE6;
  push(
    "TRADING_BALANCE",
    value !== null && value >= ACTIVATION_MIN_TRADING_USDC_E6,
    value === null
      ? i.account
        ? "The account's value cannot be read right now: a held token has no usable price."
        : `The account needs at least ${usdc(ACTIVATION_MIN_TRADING_USDC_E6)} to trade with.`
      : value >= ACTIVATION_MIN_TRADING_USDC_E6
        ? `The account holds ${usdc(value)} to trade with.`
        : `The account holds ${usdc(value)}; automatic trading needs at least ${usdc(ACTIVATION_MIN_TRADING_USDC_E6)}. Deposit more first.`,
  );
  const creditsOk = !i.restricted && i.spendableUsdcE6 >= i.ceilingUsdcE6;
  push(
    "CREDITS",
    creditsOk,
    creditsOk
      ? `Credits cover the sweep: ${usdc(i.spendableUsdcE6)} available, at most ${usdc(i.ceilingUsdcE6)} needed.`
      : i.restricted
        ? `The agent has no credits. Add at least ${usdc(i.ceilingUsdcE6)} of USDC to its funding address first.`
        : `Credits are short: ${usdc(i.spendableUsdcE6)} available, the sweep may cost up to ${usdc(i.ceilingUsdcE6)}. Add USDC to the funding address first.`,
  );
  push(
    "GRANT",
    i.armingState !== "unarmed",
    i.armingState === "unarmed"
      ? "Your wallet registers the agent's trading permission (30 days at most) when you turn trading on."
      : i.armingState === "awaiting_first_trade"
        ? "The trading permission is on chain; approving the sweep's plan arms the agent."
        : "The agent is armed.",
    false,
  );
  push(
    "NOT_BUSY",
    !i.sweepOpen && !i.cycleOpen,
    i.sweepOpen
      ? "A sweep is already under way for this agent."
      : i.cycleOpen
        ? "The agent is in the middle of a research cycle; the sweep starts once it ends."
        : "The agent is free to start.",
  );
  return out;
}

/** The first failing check that blocks the start, or null when the sweep may start. */
export const blockingCheck = (checks: readonly ActivationCheck[]): ActivationCheck | null =>
  checks.find((c) => !c.ok && c.blocking) ?? null;

// ---- the record ---------------------------------------------------------------

/** The first step's facts, stored when the sweep starts and read as its result line. */
export interface ActivationCheckFacts {
  readonly aggressiveness: Aggressiveness;
  readonly tier: ModelTier;
  readonly account: Hex;
  readonly mode: AccountMode;
  readonly tradingValueUsdcE6: string;
  readonly spendableUsdcE6: string;
}

/** The third step's facts (the deterministic read of the registry, prices and screens), or why it failed. */
export type ActivationMarketFacts =
  | {
      readonly ok: true;
      readonly tokens: number;
      readonly priced: number;
      readonly pools: number;
      readonly screensFresh: number;
      readonly startedAt: string;
      readonly finishedAt: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly startedAt: string;
      readonly finishedAt: string;
    };

export interface ActivationRecord {
  readonly activationId: string;
  readonly chainId: number;
  readonly agentId: number;
  readonly armingId: string | null;
  readonly cycleId: string | null;
  readonly taskId: string | null;
  readonly reasoningAlias: string;
  readonly tier: ModelTier;
  readonly ceilingUsdcE6: bigint;
  readonly checks: ActivationCheckFacts;
  readonly market: ActivationMarketFacts | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface Row {
  activation_id: string;
  chain_id: number;
  agent_id: number;
  arming_id: string | null;
  cycle_id: string | null;
  task_id: string | null;
  reasoning_alias: string;
  tier: ModelTier;
  ceiling_usdc_e6: string;
  checks: Record<string, unknown>;
  market: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const record = (r: Row): ActivationRecord => ({
  activationId: r.activation_id,
  chainId: r.chain_id,
  agentId: r.agent_id,
  armingId: r.arming_id,
  cycleId: r.cycle_id,
  taskId: r.task_id,
  reasoningAlias: r.reasoning_alias,
  tier: r.tier,
  ceilingUsdcE6: BigInt(r.ceiling_usdc_e6),
  checks: r.checks as unknown as ActivationCheckFacts,
  market: (r.market as ActivationMarketFacts | null) ?? null,
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
});

/** What the view reads of the cycle that runs the sweep (the orchestrator's `platform.research_cycles`). */
export interface ActivationCycle {
  readonly status: "queued" | "running" | "completed" | "stopped" | "failed";
  readonly stopReason: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

/** What the view reads of one stage run. */
export interface ActivationStage {
  readonly stage: "SCAN" | "DIVE" | "CHALLENGE" | "TEST" | "ZOOM_OUT";
  readonly themeCode: string | null;
  readonly status:
    "pending" | "running" | "completed" | "capped" | "stopped" | "failed" | "skipped";
  readonly stopReason: string | null;
  readonly chargedUsdcE6: bigint;
  readonly ceilingUsdcE6: bigint;
  /** The stage record's outcome and candidate count, when the stage ended with one. */
  readonly outcome: string | null;
  readonly candidates: number | null;
  readonly decision: "NO_CHANGE" | "PROPOSE" | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

/** What the view reads of the sweep's proposal, if the Zoom out made one. */
export interface ActivationProposal {
  readonly proposalId: string;
  readonly kind: "proposal" | "no_change";
  readonly status: ProposalStatus;
  readonly positions: number;
  readonly reasonCode: string | null;
}

export class ActivationStore {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async create(a: {
    readonly chainId: number;
    readonly agentId: number;
    readonly armingId: string | null;
    readonly reasoningAlias: string;
    readonly tier: ModelTier;
    readonly ceilingUsdcE6: bigint;
    readonly checks: ActivationCheckFacts;
    readonly now?: Date;
  }): Promise<ActivationRecord> {
    const id = `act-${randomUUID()}`;
    const now = a.now ?? new Date();
    await this.db
      .insertInto("platform.activations")
      .values({
        activation_id: id,
        chain_id: a.chainId,
        agent_id: a.agentId,
        arming_id: a.armingId,
        cycle_id: null,
        task_id: null,
        reasoning_alias: a.reasoningAlias,
        tier: a.tier,
        ceiling_usdc_e6: a.ceilingUsdcE6.toString(),
        checks: JSON.stringify(a.checks),
        market: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return (await this.get(id)) as ActivationRecord;
  }

  /** Names the cycle and task that run the sweep, once they are queued. */
  async setCycle(activationId: string, cycleId: string, taskId: string): Promise<void> {
    await this.db
      .updateTable("platform.activations")
      .set({ cycle_id: cycleId, task_id: taskId, updated_at: new Date() })
      .where("activation_id", "=", activationId)
      .execute();
  }

  async setMarket(activationId: string, market: ActivationMarketFacts): Promise<void> {
    await this.db
      .updateTable("platform.activations")
      .set({ market: JSON.stringify(market), updated_at: new Date() })
      .where("activation_id", "=", activationId)
      .execute();
  }

  async get(activationId: string): Promise<ActivationRecord | null> {
    const r = await this.db
      .selectFrom("platform.activations")
      .selectAll()
      .where("activation_id", "=", activationId)
      .executeTakeFirst();
    return r ? record(r as unknown as Row) : null;
  }

  /** The agent's newest activation, or null if trading was never turned on. */
  async latest(chainId: number, agentId: number): Promise<ActivationRecord | null> {
    const r = await this.db
      .selectFrom("platform.activations")
      .selectAll()
      .where("chain_id", "=", chainId)
      .where("agent_id", "=", agentId)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return r ? record(r as unknown as Row) : null;
  }

  async forCycle(cycleId: string): Promise<ActivationRecord | null> {
    const r = await this.db
      .selectFrom("platform.activations")
      .selectAll()
      .where("cycle_id", "=", cycleId)
      .executeTakeFirst();
    return r ? record(r as unknown as Row) : null;
  }

  /** An activation whose sweep is queued or running, if any: one at a time per agent. */
  async open(chainId: number, agentId: number): Promise<ActivationRecord | null> {
    const r = await this.db
      .selectFrom("platform.activations as a")
      .innerJoin("platform.research_cycles as c", "c.cycle_id", "a.cycle_id")
      .selectAll("a")
      .where("a.chain_id", "=", chainId)
      .where("a.agent_id", "=", agentId)
      .where("c.status", "in", ["queued", "running"])
      .orderBy("a.created_at", "desc")
      .executeTakeFirst();
    return r ? record(r as unknown as Row) : null;
  }

  /** Everything the view derives the steps from: the cycle, its stage runs, the proposal and the arming. */
  async inputs(a: ActivationRecord): Promise<ActivationViewInput> {
    const cycle = a.cycleId
      ? await this.db
          .selectFrom("platform.research_cycles")
          .select(["status", "stop_reason", "started_at", "finished_at"])
          .where("cycle_id", "=", a.cycleId)
          .executeTakeFirst()
      : undefined;
    const stageRows = a.cycleId
      ? await this.db
          .selectFrom("platform.stage_runs as s")
          .leftJoin("platform.stage_records as r", "r.stage_run_id", "s.stage_run_id")
          .select([
            "s.stage",
            "s.theme_code",
            "s.status",
            "s.stop_reason",
            "s.charged_usdc_e6",
            "s.ceiling_usdc_e6",
            "s.started_at",
            "s.finished_at",
            "r.outcome",
            "r.candidates",
            "r.decision",
          ])
          .where("s.cycle_id", "=", a.cycleId)
          .orderBy("s.seq")
          .execute()
      : [];
    const proposalRow = a.cycleId
      ? await this.db
          .selectFrom("platform.plan_proposals")
          .select(["proposal_id", "kind", "status", "positions", "reason_code"])
          .where("cycle_id", "=", a.cycleId)
          .orderBy("created_at", "desc")
          .executeTakeFirst()
      : undefined;
    const armingRow = a.armingId
      ? await this.db
          .selectFrom("platform.arming")
          .select(["status", "ended_reason"])
          .where("arming_id", "=", a.armingId)
          .executeTakeFirst()
      : undefined;
    return {
      activation: a,
      cycle: cycle
        ? {
            status: cycle.status,
            stopReason: cycle.stop_reason,
            startedAt: cycle.started_at ? new Date(cycle.started_at) : null,
            finishedAt: cycle.finished_at ? new Date(cycle.finished_at) : null,
          }
        : null,
      stages: stageRows.map((s) => {
        const decision = (s.decision as { kind?: string } | null)?.kind;
        return {
          stage: s.stage,
          themeCode: s.theme_code,
          status: s.status,
          stopReason: s.stop_reason,
          chargedUsdcE6: BigInt(s.charged_usdc_e6),
          ceilingUsdcE6: BigInt(s.ceiling_usdc_e6),
          outcome: (s.outcome as string | null) ?? null,
          candidates: Array.isArray(s.candidates) ? s.candidates.length : null,
          decision: decision === "NO_CHANGE" || decision === "PROPOSE" ? decision : null,
          startedAt: s.started_at ? new Date(s.started_at) : null,
          finishedAt: s.finished_at ? new Date(s.finished_at) : null,
        };
      }),
      proposal: proposalRow
        ? {
            proposalId: proposalRow.proposal_id,
            kind: proposalRow.kind,
            status: proposalRow.status,
            positions: Array.isArray(proposalRow.positions) ? proposalRow.positions.length : 0,
            reasonCode: proposalRow.reason_code,
          }
        : null,
      arming: armingRow ? { status: armingRow.status, endedReason: armingRow.ended_reason } : null,
    };
  }
}

// ---- the view -----------------------------------------------------------------

export type ActivationStepState = "pending" | "running" | "done" | "failed" | "skipped" | "capped";

export interface ActivationStepView {
  readonly key: ActivationStepKey;
  readonly label: string;
  readonly state: ActivationStepState;
  /** One line from the records, or null while nothing is known. */
  readonly result: string | null;
  /** Why it failed, was capped or skipped, in the owner's words. */
  readonly reason: string | null;
  readonly chargedUsdcE6: string;
  readonly ceilingUsdcE6: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export const ACTIVATION_STATUSES = [
  "running",
  "plan_ready",
  "active",
  "off",
  "declined",
  "expired",
  "no_plan",
  "failed",
  "capped",
  "out_of_credits",
] as const;
export type ActivationStatus = (typeof ACTIVATION_STATUSES)[number];

export interface ActivationView {
  readonly activationId: string;
  readonly status: ActivationStatus;
  readonly tier: { readonly choice: ModelTier; readonly label: string; readonly model: string };
  readonly ceilingUsdcE6: string;
  readonly chargedUsdcE6: string;
  readonly steps: readonly ActivationStepView[];
  readonly proposalId: string | null;
  /** What happened and what the owner can do, once the sweep has ended. */
  readonly outcome: {
    readonly title: string;
    readonly message: string;
    readonly action: "approve" | "retry" | "add_credits" | "none";
  };
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface ActivationViewInput {
  readonly activation: ActivationRecord;
  readonly cycle: ActivationCycle | null;
  readonly stages: readonly ActivationStage[];
  readonly proposal: ActivationProposal | null;
  readonly arming: Pick<ArmingRecord, "status" | "endedReason"> | null;
}

/** Every stop reason a stage or the cycle can end with, in the owner's words. */
export const STOP_REASON_TEXT: Readonly<Record<string, string>> = {
  COMPLETED: "finished",
  TASK_CAP: "the task reached its model spend cap",
  CEILING: "the step reached its cost ceiling",
  TURN_CAP: "the step used all its model turns",
  TOKEN_CAP: "the step used all its tokens",
  STAGE_CALL_CAP: "the step used all its paid data calls",
  DEADLINE: "the step ran out of time",
  BUDGET_SHORT: "the day's research budget could not cover the next step",
  CREDITS_SHORT: "the credits could not cover the next step",
  BILLING: "the credits ran out",
  PROVIDER_OUT_OF_CREDIT: "the model provider refused the call",
  NO_STAGE_RECORD: "the agent ended the step without recording it",
  NOTHING_MATERIAL: "nothing was worth a closer look",
  MARKET_UNAVAILABLE: "the pools and prices could not be read",
  FAILED: "the step failed",
  INTERRUPTED: "the platform restarted during the step",
  STALLED: "the sweep stopped moving for an hour (its worker was lost); start it again",
};

const reasonText = (code: string | null): string | null =>
  code === null || code === "COMPLETED"
    ? null
    : (STOP_REASON_TEXT[code] ?? code.toLowerCase().replaceAll("_", " "));

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const e6 = (v: bigint) => v.toString();
const STAGE_FOR: Readonly<Partial<Record<ActivationStepKey, ActivationStage["stage"]>>> = {
  scan: "SCAN",
  dives: "DIVE",
  challenge: "CHALLENGE",
  test: "TEST",
  plan: "ZOOM_OUT",
};

const stageState = (s: ActivationStage): ActivationStepState =>
  s.status === "completed"
    ? "done"
    : s.status === "capped"
      ? "capped"
      : s.status === "skipped"
        ? "skipped"
        : s.status === "failed" || s.status === "stopped"
          ? "failed"
          : "running";

const CAPS = new Set([
  "TASK_CAP",
  "CEILING",
  "TURN_CAP",
  "TOKEN_CAP",
  "STAGE_CALL_CAP",
  "DEADLINE",
  "BUDGET_SHORT",
]);
const CREDITS = new Set(["BILLING", "CREDITS_SHORT"]);

/** The sweep's status, from the cycle, the proposal and the arming (pure). */
export function activationStatus(i: ActivationViewInput): ActivationStatus {
  const c = i.cycle;
  if (!c || c.status === "queued" || c.status === "running") return "running";
  if (c.status === "failed") return CREDITS.has(c.stopReason ?? "") ? "out_of_credits" : "failed";
  if (c.status === "stopped") {
    if (CREDITS.has(c.stopReason ?? "")) return "out_of_credits";
    return CAPS.has(c.stopReason ?? "") ? "capped" : "failed";
  }
  const p = i.proposal;
  if (!p || p.kind === "no_change")
    return c.stopReason && c.stopReason !== "COMPLETED" && !p ? "capped" : "no_plan";
  switch (p.status) {
    case "pending_owner":
      return "plan_ready";
    case "applied":
      return i.arming && i.arming.status === "ended" ? "off" : "active";
    case "declined":
      return "declined";
    case "expired":
      return "expired";
    case "rejected":
      return "failed";
    case "recorded":
      return "no_plan";
  }
}

/** The eight steps as the owner watches them (pure): every result a fixed template over the records. */
export function activationSteps(i: ActivationViewInput): ActivationStepView[] {
  const a = i.activation;
  const c = i.cycle;
  const ended = c !== null && c.status !== "queued" && c.status !== "running";
  const running = c !== null && c.status === "running";
  const free = { chargedUsdcE6: "0", ceilingUsdcE6: "0" };
  const steps: ActivationStepView[] = [];
  const stage = (s: ActivationStage["stage"]) => i.stages.filter((x) => x.stage === s);
  const sumCharged = (xs: readonly ActivationStage[]) =>
    xs.reduce((t, x) => t + x.chargedUsdcE6, 0n);
  const sumCeiling = (xs: readonly ActivationStage[]) =>
    xs.reduce((t, x) => t + x.ceilingUsdcE6, 0n);
  // A step after the one that ended the sweep is skipped; before any stage ran it is pending.
  let halted = false;
  const notYet = (): ActivationStepState => (ended || halted ? "skipped" : "pending");

  // 1. The goal and the account: read before the sweep was queued.
  const ch = a.checks;
  steps.push({
    key: "account",
    label: ACTIVATION_STEPS[0].label,
    state: "done",
    result: `${AGGRESSIVENESS_FACTS[ch.aggressiveness].label} on the ${MODEL_TIER_FACTS[ch.tier].label} tier; ${usdc(BigInt(ch.tradingValueUsdcE6))} to trade with; ${usdc(BigInt(ch.spendableUsdcE6))} of credits.`,
    reason: null,
    ...free,
    startedAt: a.createdAt.toISOString(),
    finishedAt: a.createdAt.toISOString(),
  });

  // 2. The Scan.
  const scan = stage("SCAN")[0] ?? null;
  if (scan) {
    const state = stageState(scan);
    if (state !== "done" && state !== "running") halted = true;
    steps.push({
      key: "scan",
      label: ACTIVATION_STEPS[1].label,
      state,
      result:
        state === "done" || state === "capped"
          ? scan.candidates === null
            ? null
            : `${scan.candidates} theme${scan.candidates === 1 ? "" : "s"} worth a closer look.`
          : null,
      reason: state === "done" ? null : reasonText(scan.stopReason),
      chargedUsdcE6: e6(scan.chargedUsdcE6),
      ceilingUsdcE6: e6(scan.ceilingUsdcE6),
      startedAt: iso(scan.startedAt),
      finishedAt: iso(scan.finishedAt),
    });
  } else {
    // The cycle is queued or booting its sandbox: the Scan is next, with nothing to show yet.
    const state: ActivationStepState = ended ? "skipped" : running ? "running" : "pending";
    if (ended) halted = true;
    steps.push({
      key: "scan",
      label: ACTIVATION_STEPS[1].label,
      state,
      result: null,
      reason: ended ? reasonText(c.stopReason) : null,
      ...free,
      startedAt: iso(c?.startedAt ?? null),
      finishedAt: null,
    });
  }

  // 3. Pools and prices: the deterministic read after the Scan.
  const m = a.market;
  const scanDone = scan !== null && stageState(scan) === "done";
  if (m) {
    if (!m.ok) halted = true;
    steps.push({
      key: "market",
      label: ACTIVATION_STEPS[2].label,
      state: m.ok ? "done" : "failed",
      result: m.ok
        ? `${m.priced} of ${m.tokens} tokens priced across ${m.pools} pools; ${m.screensFresh} safety screens fresh.`
        : null,
      reason: m.ok ? null : m.error,
      ...free,
      startedAt: m.startedAt,
      finishedAt: m.finishedAt,
    });
  } else {
    steps.push({
      key: "market",
      label: ACTIVATION_STEPS[2].label,
      state: scanDone && running && !halted ? "running" : notYet(),
      result: null,
      reason: null,
      ...free,
      startedAt: scanDone && running && !halted ? iso(scan.finishedAt) : null,
      finishedAt: null,
    });
  }

  // 4. The Dives, as one step.
  const dives = stage("DIVE");
  if (dives.length > 0) {
    const states = dives.map(stageState);
    const anyRunning = states.includes("running");
    const anyFailed = states.includes("failed");
    const allSkipped = states.every((s) => s === "skipped");
    const state: ActivationStepState = anyRunning
      ? "running"
      : anyFailed
        ? "failed"
        : allSkipped
          ? "skipped"
          : states.includes("capped") && !states.includes("done")
            ? "capped"
            : "done";
    if (state === "failed" || state === "skipped") halted = true;
    const researched = dives.filter((d) => stageState(d) === "done" || stageState(d) === "capped");
    const themes = researched.map((d) => d.themeCode).filter((t): t is string => t !== null);
    const bad = dives.find((d) => stageState(d) === "failed" || stageState(d) === "skipped");
    steps.push({
      key: "dives",
      label: ACTIVATION_STEPS[3].label,
      state,
      result:
        state === "running"
          ? `${researched.length} of ${dives.length} themes researched.`
          : researched.length > 0
            ? `${researched.length} theme${researched.length === 1 ? "" : "s"} researched${themes.length ? `: ${themes.join(", ")}` : ""}.`
            : null,
      reason: bad ? reasonText(bad.stopReason) : null,
      chargedUsdcE6: e6(sumCharged(dives)),
      ceilingUsdcE6: e6(sumCeiling(dives)),
      startedAt: iso(dives[0]?.startedAt ?? null),
      finishedAt: anyRunning ? null : iso(dives[dives.length - 1]?.finishedAt ?? null),
    });
  } else {
    const marketDone = m !== null && m.ok;
    steps.push({
      key: "dives",
      label: ACTIVATION_STEPS[3].label,
      state: marketDone && running && !halted ? "running" : notYet(),
      result: null,
      reason: null,
      ...free,
      startedAt: marketDone && running && !halted && m ? m.finishedAt : null,
      finishedAt: null,
    });
  }

  // 5 to 7. The Challenge, the Test and the Zoom out, each one stage.
  const single = (key: "challenge" | "test" | "plan", index: 4 | 5 | 6) => {
    const s = stage(STAGE_FOR[key] as ActivationStage["stage"])[0] ?? null;
    if (!s) {
      steps.push({
        key,
        label: ACTIVATION_STEPS[index].label,
        state: notYet(),
        result: null,
        reason: null,
        ...free,
        startedAt: null,
        finishedAt: null,
      });
      return;
    }
    const state = stageState(s);
    if (state === "failed" || (state === "skipped" && key !== "challenge")) halted = true;
    let result: string | null = null;
    if (key === "challenge" && (state === "done" || state === "capped") && s.candidates !== null) {
      const dived = stage("DIVE").length;
      result = `${s.candidates} of ${dived} theses stand after the skeptic's review.`;
    }
    if (key === "test" && state === "done")
      result = "Your limits and the envelope are set for the plan.";
    if (key === "plan" && (state === "done" || state === "capped")) {
      const p = i.proposal;
      if (p && p.kind === "proposal")
        result = `A portfolio of ${p.positions} position${p.positions === 1 ? "" : "s"} proposed.`;
      else if (p && p.kind === "no_change")
        result = `No plan proposed: ${(p.reasonCode ?? "no change").toLowerCase().replaceAll("_", " ")}.`;
      else if (s.decision === "NO_CHANGE") result = "No plan proposed.";
    }
    steps.push({
      key,
      label: ACTIVATION_STEPS[index].label,
      state,
      result,
      reason:
        state === "done"
          ? null
          : key === "challenge" && state === "skipped"
            ? "no thesis to challenge"
            : reasonText(s.stopReason),
      chargedUsdcE6: e6(s.chargedUsdcE6),
      ceilingUsdcE6: e6(s.ceilingUsdcE6),
      startedAt: iso(s.startedAt),
      finishedAt: iso(s.finishedAt),
    });
  };
  single("challenge", 4);
  single("test", 5);
  single("plan", 6);

  // 8. Active: the plan's approval.
  const p = i.proposal;
  const status = activationStatus(i);
  const active: ActivationStepView =
    status === "active"
      ? {
          key: "active",
          label: ACTIVATION_STEPS[7].label,
          state: "done",
          result: "The plan is approved; the agent trades toward it within your limits.",
          reason: null,
          ...free,
          startedAt: iso(c?.finishedAt ?? null),
          finishedAt: iso(c?.finishedAt ?? null),
        }
      : status === "plan_ready"
        ? {
            key: "active",
            label: ACTIVATION_STEPS[7].label,
            state: "running",
            result: "Waiting for your approval of the plan.",
            reason: null,
            ...free,
            startedAt: iso(c?.finishedAt ?? null),
            finishedAt: null,
          }
        : status === "off"
          ? {
              key: "active",
              label: ACTIVATION_STEPS[7].label,
              state: "done",
              result: "The plan was approved.",
              reason: i.arming?.endedReason ? ARMING_END_MESSAGES[i.arming.endedReason] : null,
              ...free,
              startedAt: iso(c?.finishedAt ?? null),
              finishedAt: iso(c?.finishedAt ?? null),
            }
          : {
              key: "active",
              label: ACTIVATION_STEPS[7].label,
              state: status === "running" ? "pending" : "skipped",
              result: null,
              reason:
                p?.status === "declined"
                  ? "you declined the plan"
                  : p?.status === "expired"
                    ? "the plan expired before it was approved"
                    : p?.status === "rejected"
                      ? "the plan no longer passed the platform's checks at approval"
                      : null,
              ...free,
              startedAt: null,
              finishedAt: null,
            };
  steps.push(active);
  return steps;
}

/** What happened and what the owner can do, per status (pure). */
export function activationOutcome(
  status: ActivationStatus,
  i: ActivationViewInput,
): ActivationView["outcome"] {
  const steps = activationSteps(i);
  const broken = steps.find((s) => s.state === "failed" || s.state === "capped");
  const where = broken
    ? `"${broken.label}" ${broken.state === "capped" ? "stopped" : "failed"}${broken.reason ? `: ${broken.reason}` : ""}.`
    : "";
  const reason = reasonText(i.cycle?.stopReason ?? null);
  switch (status) {
    case "running":
      return {
        title: "Building the first plan",
        message:
          "The agent reads the market, researches the most promising tokens, checks the risks and builds a plan for you to approve. Nothing is traded until you approve it.",
        action: "none",
      };
    case "plan_ready":
      return {
        title: "Your approval is needed",
        message:
          "The sweep ended with a plan. Read it below and approve it to turn automatic trading on; decline it and nothing is traded.",
        action: "approve",
      };
    case "active":
      return {
        title: "Automatic trading is on",
        message:
          "The agent trades toward its plan within your limits, one capped leg at a time, and keeps researching on its own.",
        action: "none",
      };
    case "off":
      return {
        title: "Automatic trading is off",
        message: `${i.arming?.endedReason ? ARMING_END_MESSAGES[i.arming.endedReason] : "The trading permission ended."} Turn it on again to run a new sweep.`,
        action: "retry",
      };
    case "declined":
      return {
        title: "You declined the plan",
        message:
          "Nothing was traded. Run the sweep again for a fresh plan, or change the goal first.",
        action: "retry",
      };
    case "expired":
      return {
        title: "The plan expired",
        message: "A plan waits 24 hours for your approval. Run the sweep again for a fresh one.",
        action: "retry",
      };
    case "no_plan":
      return {
        title: "No plan yet",
        message: `The agent found nothing worth buying now${i.proposal?.reasonCode ? ` (${i.proposal.reasonCode.toLowerCase().replaceAll("_", " ")})` : ""}. Nothing was traded. Try again later, or change the goal.`,
        action: "retry",
      };
    case "out_of_credits":
      return {
        title: "The agent ran out of credits",
        message:
          `${where || (reason ? `${reason[0]?.toUpperCase()}${reason.slice(1)}.` : "")} Nothing was traded; only the steps that ran were charged. Add USDC to the funding address, then try again.`.trim(),
        action: "add_credits",
      };
    case "capped":
      return {
        title: "The sweep stopped at a limit",
        message:
          `${where || (reason ? `${reason[0]?.toUpperCase()}${reason.slice(1)}.` : "")} Nothing was traded; only the steps that ran were charged. Try again.`.trim(),
        action: "retry",
      };
    case "failed":
      return {
        title: "The sweep did not finish",
        message:
          `${where || (reason ? `${reason[0]?.toUpperCase()}${reason.slice(1)}.` : "A step failed.")} Nothing was traded; only the steps that ran were charged. Try again.`.trim(),
        action: "retry",
      };
  }
}

export function activationView(i: ActivationViewInput): ActivationView {
  const status = activationStatus(i);
  const steps = activationSteps(i);
  const charged = i.stages.reduce((t, s) => t + s.chargedUsdcE6, 0n);
  const a = i.activation;
  return {
    activationId: a.activationId,
    status,
    tier: {
      choice: a.tier,
      label: MODEL_TIER_FACTS[a.tier].label,
      model: MODEL_TIER_FACTS[a.tier].model,
    },
    ceilingUsdcE6: e6(a.ceilingUsdcE6),
    chargedUsdcE6: e6(charged),
    steps,
    proposalId: i.proposal?.kind === "proposal" ? i.proposal.proposalId : null,
    outcome: activationOutcome(status, i),
    startedAt: a.createdAt.toISOString(),
    finishedAt: iso(i.cycle?.finishedAt ?? null),
  };
}
