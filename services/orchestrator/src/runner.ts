import { createHash } from "node:crypto";
import {
  type Blocker,
  type ChainReader,
  type IntentStore,
  blockersFor,
  oracleImplied,
  proposalVerdict,
} from "@alpha-agents/chain-tools";
import {
  ASSET_DECIMALS,
  REJECTION_MESSAGES,
  type RejectionCode,
  RUNNER_HOLD_FACTS,
  type RunnerHoldCode,
  TRADE_FLOW_MESSAGES,
} from "@alpha-agents/domain";
import {
  REBALANCE_BANDS_V1,
  type TemplateDecision,
  type TemplateHoldCode,
} from "@alpha-agents/policy";
import type {
  DecisionStore,
  GoalStore,
  NewDecision,
  PlanStore,
  RunnerDecision,
  StoredPlan,
  TradeStore,
} from "@alpha-agents/trading";
import type { AgentIdentity } from "@alpha-agents/tool-server";
import { type Hex, formatUnits } from "viem";
import type { RunnerFacts } from "./narrator.ts";
import type { TradeFlowGas } from "./trade-flow.ts";

/**
 * The template runner (P3-U3, D-094, D-290): every minute, for each agent
 * with an active plan, it reads the account, the prices and the limits and
 * decides one leg or one hold by the template's rule. It uses no model and
 * no sandbox and costs nothing (D-297: the model changes the plan, the runner
 * makes the trades). A leg goes through the same checks and intent store as
 * `propose_swap`, with source `template`, the plan's strategy epoch and a
 * deterministic client request ID, and then through the trade flow like any
 * proposal: approval while armed, every check again at submission, the
 * signer, the Executor and reconciliation. A leg larger than the per-trade
 * cap is split across ticks: one leg per decision, the next only once the
 * previous one has settled (D-096).
 *
 * Holds are recorded with their reason (the runner's, the Executor's or the
 * trade flow's), a new row only when the reason changes, and served through
 * why-not-traded. A plan set under an earlier strategy epoch never trades.
 */
export const RUNNER_EVERY_MS = 60_000;
/** A refused leg whose reasons give no time is tried again after this long. */
export const REFUSED_RETRY_MS = 10 * 60_000;
/** A leg waits for the owner (or the armed trade flow) as long as any proposal (A-43). */
export const RUNNER_INTENT_TTL_SECONDS = 1_800;

/** The intents of an agent that mean a leg is still on its way. */
const IN_FLIGHT = new Set(["awaiting_approval", "approved", "submitted", "confirmed"]);

/** Holds worth an activity entry when they start: what an owner would want to know. */
const NOTABLE_HOLDS = new Set<string>([
  "VOLATILITY_BRAKE",
  "VOLATILITY_UNAVAILABLE",
  "COST_HURDLE",
  "OWNER_TRADE_LIMIT",
  "STRATEGY_EPOCH_STALE",
  "NOT_ARMED",
  "GAS_UNFUNDED",
  "ORACLE_STALE",
  "ORACLE_POOL_DEVIATION",
  "DAILY_TRADE_LIMIT",
  "TURNOVER_CAP",
  "REDUCE_ONLY_MODE",
  "PAUSED",
]);

export interface RunnerNarrator {
  narrateEvent(chainId: number, agentId: number, key: string, facts: RunnerFacts): Promise<unknown>;
}

export interface TemplateRunnerOptions {
  readonly chainId: number;
  readonly reader: ChainReader;
  readonly plans: PlanStore;
  readonly decisions: DecisionStore;
  readonly goals: GoalStore;
  readonly trades: TradeStore;
  readonly intents: IntentStore;
  /** The agent's session key (its funding address, D-243), as the trade flow's signer gives it. */
  readonly sessionKeyOf: (agentId: number) => Promise<Hex | null>;
  /** MON's annualized 24-hour realized volatility in percent, or null when it cannot be read. */
  readonly volatility24hPct: () => Promise<number | null>;
  /** Without `topUp` (off the fork) a funding address with too little MON holds GAS_UNFUNDED. */
  readonly gas?: TradeFlowGas | null;
  readonly narrator?: RunnerNarrator | null;
  readonly now?: () => Date;
  readonly log: (line: string) => void;
}

const agentName = (agentId: number) => `Agent #${agentId}`;
const pct = (bps: number) => (bps / 100).toString();

/** The message and how a code clears, whichever list it is from. */
export function holdMessage(code: string): string {
  return (
    RUNNER_HOLD_FACTS[code as RunnerHoldCode]?.message ??
    TRADE_FLOW_MESSAGES[code as keyof typeof TRADE_FLOW_MESSAGES] ??
    REJECTION_MESSAGES[code as RejectionCode] ??
    code
  );
}

export class TemplateRunner {
  private readonly o: TemplateRunnerOptions;
  private running = false;

  constructor(o: TemplateRunnerOptions) {
    this.o = o;
  }

  private now() {
    return this.o.now?.() ?? new Date();
  }

  /** One pass over every agent with an active plan. Returns each agent's decision. */
  async tick(): Promise<RunnerDecision[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const out: RunnerDecision[] = [];
      for (const plan of await this.o.plans.activePlans(this.o.chainId)) {
        try {
          out.push(await this.decide(plan));
        } catch (err) {
          this.o.log(
            `runner: agent ${plan.agentId}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
          );
        }
      }
      return out;
    } finally {
      this.running = false;
    }
  }

  /** Decides one leg or one hold for the agent now (the console's "run now"); null without a plan. */
  async runAgent(agentId: number): Promise<RunnerDecision | null> {
    const plan = await this.o.plans.active(this.o.chainId, agentId);
    return plan ? this.decide(plan) : null;
  }

  private async decide(plan: StoredPlan): Promise<RunnerDecision> {
    const { chainId } = this.o;
    const agentId = plan.agentId;
    const base = {
      chainId,
      agentId,
      paramId: plan.paramId,
      strategyEpoch: plan.strategyEpoch,
    };
    const hold = (
      code: TemplateHoldCode | string,
      facts: Record<string, unknown>,
      codes: readonly string[] = [code],
      block: bigint | null = null,
    ) =>
      this.record(plan, {
        ...base,
        outcome: "hold",
        code,
        codes,
        leg: null,
        intentId: null,
        facts,
        block,
      });

    // A plan set before the goal changed never trades (D-281).
    const epoch = await this.o.trades.strategyEpoch(chainId, agentId);
    if (plan.strategyEpoch !== epoch)
      return hold("STRATEGY_EPOCH_STALE", {
        planEpoch: plan.strategyEpoch.toString(),
        epoch: epoch.toString(),
      });
    const goal = await this.o.goals.currentGoal(chainId, agentId);
    if (!goal) return hold("NO_PLAN", {});
    const arming = await this.o.trades.openArming(chainId, agentId);
    if (!arming) return hold("NOT_ARMED", {});
    const open = (await this.o.trades.intents(chainId, agentId, 20)).filter((i) =>
      IN_FLIGHT.has(i.status),
    );
    if (open.length > 0)
      return hold("LEG_PENDING", { intents: open.map((i) => `${i.intentId}:${i.status}`) });
    // A leg the trade flow refused at submission (plan item 5): hold with its reasons, and try
    // again only once they can have cleared by waiting; a reason only the owner or the platform
    // clears holds until the plan changes.
    const refused = await this.lastRefusedLeg(agentId, plan.paramId);
    if (refused) return hold(refused.code, refused.facts, refused.codes);

    const [m, a] = await Promise.all([this.o.reader.market(), this.o.reader.agent(agentId)]);
    if (!a) return hold("NO_PLAN", { reason: "the agent is not on this chain" });
    // The owner's limits from the goal: each the hard limit or a stricter value (P3-U1).
    const owner = goal.config.ownerLimits;
    const dayAgo = a.timestamp - 86_400n;
    const tradesToday = a.trades.filter((t) => t.at > dayAgo && t.at > 0n).length;
    if (tradesToday >= owner.maxTradesPer24h)
      return hold(
        "OWNER_TRADE_LIMIT",
        { tradesToday, limit: owner.maxTradesPer24h },
        undefined,
        a.block,
      );

    const params = plan.params;
    const priceE18 = m.monUsd.priceE18 > 0n ? m.monUsd.priceE18 : null;
    const volatility = await this.o.volatility24hPct().catch(() => null);
    let d: TemplateDecision = REBALANCE_BANDS_V1.plan(params, {
      usdcRaw: a.usdc,
      wmonRaw: a.wmon,
      priceE18,
      volatility24hPct: volatility,
      limits: {
        maxTradeBps: owner.maxTradeBps,
        maxWmonShareBps: owner.maxWmonShareBps,
        minUsdcShareBps: owner.minUsdcShareBps,
      },
    });
    if (d.action === "hold") return hold(d.code, { ...d.facts }, undefined, a.block);

    const leg = d.leg;
    const quote = await this.o.reader.quote(leg.sell, leg.amountIn).catch(() => null);
    if (quote && priceE18 !== null) {
      d = REBALANCE_BANDS_V1.checkCost(params, d, {
        oracleOut: oracleImplied(leg.sell, leg.amountIn, priceE18),
        quotedOut: quote.amountOut,
      });
      if (d.action === "hold") return hold(d.code, { ...d.facts }, undefined, a.block);
    }
    // Every check propose_swap runs, on the same reads (the Executor's rules, slots, the grant).
    const [key, reserved] = await Promise.all([
      this.o.sessionKeyOf(agentId),
      this.o.intents.reservedSlots(this.identity(agentId)),
    ]);
    const blockers: Blocker[] = blockersFor(leg.sell, leg.amountIn, a, m, quote, key, reserved);
    const verdict = proposalVerdict(blockers);
    if (verdict.rejecting.length > 0) {
      const codes = verdict.rejecting.map((b) => b.code);
      return hold(codes[0] as string, { ...d.facts, blockers: verdict.rejecting }, codes, a.block);
    }
    // Off the fork a funding address short of gas MON would only be refused at submission.
    const gas = this.o.gas;
    if (gas && !gas.topUp && key) {
      const [have, need] = await Promise.all([gas.balance(key), gas.swapCost()]);
      if (have < need)
        return hold(
          "GAS_UNFUNDED",
          { ...d.facts, gasWei: have.toString(), needWei: need.toString() },
          undefined,
          a.block,
        );
    }

    const identity = this.identity(agentId);
    const requestId = createHash("sha256")
      .update(`${plan.paramId}:${leg.sell}:${leg.amountIn}:${a.block}`)
      .digest("hex")
      .slice(0, 32);
    const share = d.facts.wmonShareBps;
    const { record } = await this.o.intents.propose(
      identity,
      {
        idempotencyKey: `template:${agentId}:${requestId}`,
        account: a.account,
        sell: leg.sell,
        buy: leg.buy,
        amountIn: leg.amountIn,
        reason: `The runner rebalances toward the plan's ${pct(params.targetWmonBps)}% WMON target${share === null ? "" : `; the account is at ${pct(share)}%`}.`,
        clientRequestId: `template-${requestId}`,
        status: verdict.status,
        reasonCodes: [],
        blockers,
        checks: {
          template: plan.template,
          paramId: plan.paramId,
          paramsHash: plan.paramsHash,
          block: a.block.toString(),
          ...(quote ? { expectedOut: quote.amountOut.toString() } : {}),
          facts: d.facts,
        },
        ownerEpoch: a.ownerEpoch,
        configEpoch: a.configEpoch,
        expiresAt: new Date(this.now().getTime() + RUNNER_INTENT_TTL_SECONDS * 1000),
        source: "template",
        strategyEpoch: plan.strategyEpoch,
      },
      3,
    );
    return this.record(plan, {
      ...base,
      outcome: "leg",
      code: "LEG",
      codes: [],
      leg: {
        sell: leg.sell,
        buy: leg.buy,
        amountIn: leg.amountIn.toString(),
        valueUsdcE6: leg.valueUsdcE6.toString(),
      },
      intentId: record.intentId,
      facts: { ...d.facts },
      block: a.block,
    });
  }

  /** The latest refused leg of this plan, while its reasons still hold the runner back. */
  private async lastRefusedLeg(agentId: number, paramId: string) {
    const last = (await this.o.trades.intents(this.o.chainId, agentId, 20)).find(
      (i) => i.source === "template",
    );
    if (!last || (last.status !== "rejected" && last.status !== "failed")) return null;
    // A leg of an earlier plan never holds a new one back.
    const row = await this.o.trades.db
      .selectFrom("platform.intents")
      .select("checks")
      .where("intent_id", "=", last.intentId)
      .executeTakeFirst();
    if ((row?.checks as { paramId?: unknown } | undefined)?.paramId !== paramId) return null;
    const codes = last.blockers.length > 0 ? last.blockers.map((b) => b.code) : ["SEND_FAILED"];
    const facts = { intentId: last.intentId, refusedAt: last.updatedAt.toISOString() };
    if (last.blockers.some((b) => b.clears === "by_the_owner" || b.clears === "by_the_platform"))
      return { code: codes[0] as string, codes, facts };
    const times = last.blockers
      .map((b) => (b.clearsAt ? Date.parse(b.clearsAt) : Number.NaN))
      .filter((t) => !Number.isNaN(t));
    const until =
      times.length > 0 ? Math.max(...times) : last.updatedAt.getTime() + REFUSED_RETRY_MS;
    if (this.now().getTime() >= until) return null;
    return {
      code: codes[0] as string,
      codes,
      facts: { ...facts, retryAt: new Date(until).toISOString() },
    };
  }

  /** The runner acts as the agent with a platform identity, not a sandbox lease (D-290). */
  private identity(agentId: number): AgentIdentity {
    return {
      chainId: this.o.chainId,
      agentId,
      tier: "platform",
      leaseId: `template-runner:${agentId}`,
    };
  }

  private async record(plan: StoredPlan, d: NewDecision): Promise<RunnerDecision> {
    const previous = await this.o.decisions.latest(d.chainId, d.agentId);
    const { decision, changed } = await this.o.decisions.record(d, this.now());
    if (changed) {
      this.o.log(
        `runner: agent ${d.agentId}: ${d.outcome === "leg" ? `leg ${d.leg?.amountIn} ${d.leg?.sell}` : `hold ${d.code}`}`,
      );
      this.narrate(plan, decision, previous);
    }
    return decision;
  }

  /** An entry for a leg, a notable hold as it starts, and the account back in band after legs. */
  private narrate(plan: StoredPlan, d: RunnerDecision, previous: RunnerDecision | null) {
    const narrator = this.o.narrator;
    if (!narrator) return;
    const event: RunnerFacts["event"] | null =
      d.outcome === "leg"
        ? "leg"
        : d.code === "IN_BAND"
          ? previous && previous.outcome !== "hold"
            ? "in_band"
            : previous?.code === "LEG_PENDING"
              ? "in_band"
              : null
          : NOTABLE_HOLDS.has(d.code)
            ? "hold"
            : null;
    if (!event) return;
    const share = d.facts.wmonShareBps;
    const facts: RunnerFacts = {
      agent: agentName(d.agentId),
      activity: "runner",
      event,
      targetPercent: pct(plan.params.targetWmonBps),
      bandPercent: pct(plan.params.bandHalfWidthBps),
      wmonSharePercent: typeof share === "number" ? pct(share) : null,
      sell: d.leg
        ? {
            asset: d.leg.sell,
            amount: formatUnits(BigInt(d.leg.amountIn), ASSET_DECIMALS[d.leg.sell]),
          }
        : null,
      buy: d.leg?.buy ?? null,
      reason: d.outcome === "hold" ? { code: d.code, message: holdMessage(d.code) } : null,
    };
    void narrator
      .narrateEvent(d.chainId, d.agentId, `runner:${d.agentId}:${d.decisionId}`, facts)
      .catch((err: unknown) =>
        this.o.log(
          `runner: agent ${d.agentId}: no activity entry: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
        ),
      );
  }
}
