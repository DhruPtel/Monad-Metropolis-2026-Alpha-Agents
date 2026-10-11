import type { ChainReaderV3 } from "@alpha-agents/chain-tools";
import { AGGRESSIVENESS_FACTS, MODEL_TIER_FACTS } from "@alpha-agents/domain";
import {
  ACTIVATION_STEPS,
  type ActivationCheck,
  type ActivationCheckCode,
  type ActivationCheckInput,
  type ActivationRecord,
  ActivationStore,
  type ActivationView,
  type GoalStore,
  type TradeStore,
  activationChecks,
  activationView,
  armingState,
  blockingCheck,
} from "@alpha-agents/trading";
import { type Hex, isAddressEqual } from "viem";
import type { CreditService } from "./credits/service.ts";
import { type CycleHooks, cyclePlan } from "./cycle/cycle.ts";
import { type CycleKind, type ReasoningAlias, isReasoningAlias } from "./cycle/stages.ts";
import type { Cycle, CycleStore } from "./cycle/store.ts";
import type { TestInputsV2 } from "./cycle/test-stage.ts";
import { type ActivationFacts, type Narrator, formatUsdc } from "./narrator.ts";
import type { Log } from "./secrets.ts";
import type { AgentRef, Store, TaskRequester } from "./store.ts";

/**
 * The activation sweep (F-U10, D-279, D-291). When the owner turns on
 * automatic trading, the control API asks here: the checks of the first step
 * run (the goal, the account and its mode, the trading balance, the credits
 * against the sweep's ceiling, the grant, one sweep at a time), each named
 * when it fails; then an ACTIVATION cycle is queued as the owner's task and
 * recorded as the activation. While it runs, the cycle's hooks record the
 * deterministic "pools and prices" step after the Scan and the sweep's end,
 * and the narrator writes an entry for the start, each of the two
 * deterministic steps (the stages have their own) and the result. The
 * sweep's plan is the F-U9 proposal, which always waits for the owner; its
 * approval arms the agent (the control API).
 */
export interface ActivationServiceOptions {
  readonly store: Store;
  readonly cycles: CycleStore;
  readonly goals: GoalStore;
  readonly trades: TradeStore;
  readonly credits: CreditService | null;
  readonly narrator: Narrator | null;
  /** The fund agent's set, or null where it is not deployed. */
  readonly readerV3: ChainReaderV3 | null;
  /** The Test stage v2's inputs for the agent (the market, the account, the screens), or null off the set. */
  readonly inputs: (ref: AgentRef) => Promise<TestInputsV2 | null>;
  readonly enqueueCycle: (
    ref: AgentRef,
    kind: CycleKind,
    requestedBy: TaskRequester,
  ) => Promise<{ taskId: string; cycleId: string }>;
  readonly log: Log;
  readonly now?: () => Date;
}

export interface ActivationRead {
  readonly agentId: string;
  /** The newest sweep, or null if trading was never turned on. */
  readonly activation: ActivationView | null;
  /** The checks as they stand now, for the card before a sweep starts. */
  readonly checks: readonly ActivationCheck[];
  /** The sweep's ceiling for the goal's tier (the Medium tier's without a goal). */
  readonly ceilingUsdcE6: string;
  readonly tier: { readonly choice: "LOW" | "MEDIUM" | "HIGH"; readonly label: string };
}

export type ActivationStart =
  | { readonly ok: true; readonly activation: ActivationView }
  | {
      readonly ok: false;
      readonly code: ActivationCheckCode;
      readonly message: string;
      readonly checks: readonly ActivationCheck[];
    };

const agentName = (agentId: number) => `Alpha Agent #${agentId}`;

export class ActivationService {
  readonly store: ActivationStore;
  private readonly o: ActivationServiceOptions;

  constructor(o: ActivationServiceOptions) {
    this.o = o;
    this.store = new ActivationStore(o.store.db);
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  /** The sweep's ceiling on an alias: every stage's ceiling, the Dives twice (A-51). */
  static ceilingFor(alias: ReasoningAlias): bigint {
    return BigInt(cyclePlan("ACTIVATION", alias, 2).maxUsdcE6);
  }

  /** Everything the checks read, from the stores and the chain. */
  private async facts(ref: AgentRef): Promise<{
    input: ActivationCheckInput;
    alias: ReasoningAlias | null;
    account: Hex | null;
  }> {
    const [runtime, goal, arming, sweep, cycle] = await Promise.all([
      this.o.store.runtime(ref),
      this.o.goals.currentGoal(ref.chainId, ref.agentId),
      this.o.trades.openArming(ref.chainId, ref.agentId),
      this.store.open(ref.chainId, ref.agentId),
      this.o.cycles.openCycle(ref),
    ]);
    const credits = this.o.credits
      ? await this.o.credits.creditsOf(ref.agentId)
      : { spendable: 0n, restricted: true };
    const agent = this.o.readerV3
      ? await this.o.readerV3.agent(ref.agentId).catch(() => null)
      : null;
    const rawAlias = goal?.config.model.alias ?? null;
    const alias = rawAlias && isReasoningAlias(rawAlias) ? rawAlias : null;
    return {
      input: {
        goal: goal
          ? { aggressiveness: goal.config.aggressiveness, tier: goal.config.model.choice }
          : null,
        provisioned: runtime?.status === "ready",
        account: agent?.account ?? null,
        mode: agent?.account ? agent.mode : null,
        tradingValueUsdcE6: agent?.account ? (agent.values?.nav ?? null) : null,
        spendableUsdcE6: credits.spendable,
        restricted: credits.restricted,
        ceilingUsdcE6: ActivationService.ceilingFor(alias ?? "research-medium"),
        armingState: armingState(arming),
        sweepOpen: sweep !== null,
        cycleOpen: cycle !== null,
      },
      alias,
      account: agent?.account ?? null,
    };
  }

  /** The owner's read: the newest sweep as the panel shows it, and the checks before the next. */
  async view(ref: AgentRef): Promise<ActivationRead> {
    const { input } = await this.facts(ref);
    const latest = await this.store.latest(ref.chainId, ref.agentId);
    const activation = latest ? activationView(await this.store.inputs(latest)) : null;
    const tier = input.goal?.tier ?? "MEDIUM";
    return {
      agentId: String(ref.agentId),
      activation,
      checks: activationChecks(input),
      ceilingUsdcE6: input.ceilingUsdcE6.toString(),
      tier: { choice: tier, label: MODEL_TIER_FACTS[tier].label },
    };
  }

  /**
   * Turns automatic trading on: every check, then the sweep queued as the
   * owner's task and recorded. The grant must be on chain already (the
   * owner's wallet registers it first, D-291).
   */
  async start(ref: AgentRef): Promise<ActivationStart> {
    const { input, alias, account } = await this.facts(ref);
    const checks = activationChecks(input);
    const blocked =
      blockingCheck(checks) ?? checks.find((c) => c.code === "GRANT" && !c.ok) ?? null;
    if (blocked)
      return {
        ok: false,
        code: blocked.code,
        message:
          blocked.code === "GRANT"
            ? "Register the agent's trading permission from your wallet first; the sweep starts once it is on chain."
            : blocked.message,
        checks,
      };
    const goal = input.goal as NonNullable<ActivationCheckInput["goal"]>;
    const arming = await this.o.trades.openArming(ref.chainId, ref.agentId);
    const record = await this.store.create({
      chainId: ref.chainId,
      agentId: ref.agentId,
      armingId: arming?.armingId ?? null,
      reasoningAlias: alias ?? "research-medium",
      tier: goal.tier,
      ceilingUsdcE6: input.ceilingUsdcE6,
      checks: {
        aggressiveness: goal.aggressiveness,
        tier: goal.tier,
        account: account as Hex,
        mode: input.mode ?? "NORMAL",
        tradingValueUsdcE6: (input.tradingValueUsdcE6 ?? 0n).toString(),
        spendableUsdcE6: input.spendableUsdcE6.toString(),
      },
      now: this.now(),
    });
    try {
      const { taskId, cycleId } = await this.o.enqueueCycle(ref, "ACTIVATION", "owner");
      await this.store.setCycle(record.activationId, cycleId, taskId);
    } catch (err) {
      await this.o.store.db
        .deleteFrom("platform.activations")
        .where("activation_id", "=", record.activationId)
        .execute();
      const message = err instanceof Error ? err.message : String(err);
      this.o.log(`agent ${ref.agentId}: the activation sweep could not start: ${message}`);
      return {
        ok: false,
        code: /credits/i.test(message) ? "CREDITS" : /goal/i.test(message) ? "GOAL" : "NOT_BUSY",
        message,
        checks,
      };
    }
    this.o.log(
      `agent ${ref.agentId}: activation ${record.activationId} started on ${record.reasoningAlias} (ceiling ${formatUsdc(record.ceilingUsdcE6)} USDC)`,
    );
    await this.narrate(ref, record, {
      event: "started",
      step: null,
      result: null,
      status: null,
      chargedUsdc: null,
      positions: null,
    });
    await this.narrate(ref, record, {
      event: "step",
      step: ACTIVATION_STEPS[0].label,
      result: `${AGGRESSIVENESS_FACTS[goal.aggressiveness].label} on the ${MODEL_TIER_FACTS[goal.tier].label} tier; ${formatUsdc(input.tradingValueUsdcE6 ?? 0n)} USDC to trade with; ${formatUsdc(input.spendableUsdcE6)} USDC of credits`,
      status: null,
      chargedUsdc: null,
      positions: null,
    });
    const view = activationView(await this.store.inputs(record));
    return { ok: true, activation: view };
  }

  /** The cycle engine's hooks for an activation's cycle: a cycle without an activation is left alone. */
  hooks(): CycleHooks {
    return {
      afterScan: (cycle) => this.afterScan(cycle),
      onEnd: (cycle) => this.onEnd(cycle),
    };
  }

  /**
   * The third step, "Reading pools and prices": the deterministic read of the
   * registry's tokens, their prices and pools and the platform's safety
   * screens, as the Test stage v2 reads them. Fails the sweep when the set
   * cannot be read, since no plan could be checked against it.
   */
  async afterScan(
    cycle: Cycle,
  ): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
    const a = await this.store.forCycle(cycle.cycleId);
    if (!a) return { ok: true };
    const ref = { chainId: cycle.chainId, agentId: cycle.agentId };
    const startedAt = this.now().toISOString();
    const inputs = await this.o.inputs(ref).catch(() => null);
    if (!inputs) {
      const error =
        "The pools and prices could not be read: the agent's account on the fund agent's set did not answer.";
      await this.store.setMarket(a.activationId, {
        ok: false,
        error,
        startedAt,
        finishedAt: this.now().toISOString(),
      });
      await this.narrate(ref, a, {
        event: "step",
        step: ACTIVATION_STEPS[2].label,
        result: "failed: the pools and prices could not be read",
        status: null,
        chargedUsdc: null,
        positions: null,
      });
      return { ok: false, reason: "MARKET_UNAVAILABLE", message: error };
    }
    const m = inputs.market;
    const tokens = m.tokens.filter((t) => !isAddressEqual(t.token, m.usdc));
    const priced = tokens.filter((t) => {
      const p = m.prices[t.token.toLowerCase()];
      return p !== undefined && p.reason === "OK" && p.priceE18 > 0n;
    }).length;
    const screens = await Promise.all(
      tokens.map((t) => inputs.screenFresh(t.token).catch(() => null)),
    );
    const facts = {
      ok: true as const,
      tokens: tokens.length,
      priced,
      pools: m.pools.length,
      screensFresh: screens.filter((s) => s === true).length,
      startedAt,
      finishedAt: this.now().toISOString(),
    };
    await this.store.setMarket(a.activationId, facts);
    await this.narrate(ref, a, {
      event: "step",
      step: ACTIVATION_STEPS[2].label,
      result: `${facts.priced} of ${facts.tokens} tokens priced across ${facts.pools} pools; ${facts.screensFresh} safety screens fresh`,
      status: null,
      chargedUsdc: null,
      positions: null,
    });
    return { ok: true };
  }

  /** The sweep's end, whatever it was: one entry with the status, the cost and the plan. */
  async onEnd(cycle: Cycle): Promise<void> {
    const a = await this.store.forCycle(cycle.cycleId);
    if (!a) return;
    const ref = { chainId: cycle.chainId, agentId: cycle.agentId };
    const view = activationView(await this.store.inputs(a));
    this.o.log(
      `agent ${ref.agentId}: activation ${a.activationId} ended ${view.status} (${formatUsdc(BigInt(view.chargedUsdcE6))} of ${formatUsdc(a.ceilingUsdcE6)} USDC)`,
    );
    const plan = view.steps.find((s) => s.key === "plan");
    await this.narrate(ref, a, {
      event: "finished",
      step: null,
      result: plan?.result ?? null,
      status: STATUS_WORDS[view.status],
      chargedUsdc: formatUsdc(BigInt(view.chargedUsdcE6)),
      positions: null,
    });
  }

  private async narrate(
    ref: AgentRef,
    a: ActivationRecord,
    f: Pick<ActivationFacts, "event" | "step" | "result" | "status" | "chargedUsdc" | "positions">,
  ): Promise<void> {
    if (!this.o.narrator) return;
    const tier = MODEL_TIER_FACTS[a.tier].label;
    const ceilingUsdc = formatUsdc(a.ceilingUsdcE6);
    const summary =
      f.event === "started"
        ? `${agentName(ref.agentId)} started its activation sweep on the ${tier} tier, which may cost at most ${ceilingUsdc} USDC of credits; nothing is traded until the owner approves the plan it ends with.`
        : f.event === "step"
          ? `${agentName(ref.agentId)}'s activation sweep finished its step "${f.step ?? ""}": ${f.result ?? "done"}.`
          : `${agentName(ref.agentId)}'s activation sweep ended: ${f.status ?? "it ended"}. It cost ${f.chargedUsdc ?? "0"} of at most ${ceilingUsdc} USDC.${f.result ? ` ${f.result}` : ""}`;
    const facts: ActivationFacts = {
      agent: agentName(ref.agentId),
      activity: "activation",
      tier,
      ceilingUsdc,
      summary,
      ...f,
    };
    const key = `${a.activationId}:${f.event}${f.step ? `:${f.step.toLowerCase().replaceAll(/[^a-z]+/g, "-")}` : ""}`;
    try {
      await this.o.narrator.narrateEvent(ref.chainId, ref.agentId, key, facts);
    } catch (err) {
      this.o.log(`agent ${ref.agentId}: activation narration failed: ${String(err)}`);
    }
  }
}

/** Each status in the owner's words, for the entry that ends a sweep. */
const STATUS_WORDS: Readonly<Record<ActivationView["status"], string>> = {
  running: "still running",
  plan_ready: "a plan waits for the owner's approval",
  active: "the plan is approved and automatic trading is on",
  off: "the plan was approved but trading was turned off",
  declined: "the owner declined the plan",
  expired: "the plan expired before it was approved",
  no_plan: "the agent proposed no plan",
  failed: "a step failed, so there is no plan",
  capped: "a step reached a limit, so there is no plan",
  out_of_credits: "the credits ran out, so there is no plan",
};
