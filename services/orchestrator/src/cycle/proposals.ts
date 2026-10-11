import type { Db } from "@alpha-agents/db";
import {
  type GoalError,
  type RebalanceBandsParams,
  TARGET_PORTFOLIO_ID,
  type TargetPortfolioParams,
  checkPlan,
  checkTargetPortfolioParams,
  valueE6,
} from "@alpha-agents/policy";
import {
  type GoalStore,
  type PlanStore,
  type ProposalEvaluation,
  type ProposalFacts,
  type ProposalPosition,
  type ProposalRationale,
  ProposalStore,
  proposalFacts,
  type SourceCount,
  type StoredProposal,
  type TradeStore,
  isPortfolioPlan,
} from "@alpha-agents/trading";
import { type Hex, isAddressEqual } from "viem";
import type { Narrator } from "../narrator.ts";
import type { BriefRow, Cycle, CycleStore, StageRun } from "./store.ts";
import { type TestFindingV2, type TestInputsV2, checkPortfolioProposal } from "./test-stage.ts";

/**
 * Portfolio proposals (F-U9): the Zoom out's decision, read from the cycle's
 * own records once its stage ends, becomes a stored proposal the owner reads
 * on the plan card, or a stored "no change" with its reason. The evaluator
 * runs every proposal through the Test stage v2 (the registry, the screens,
 * the envelope, the caps, depth, turnover, the cooldown, the evals) and the
 * goal's limits, estimates the cost to move to it, and decides whether it
 * waits for the owner (the goal's setting, or the first plan after arming)
 * or becomes the plan at once with the owner told. A rejected proposal is
 * stored with every finding and never offered.
 */
export interface ProposalServiceOptions {
  readonly db: Db;
  readonly cycles: CycleStore;
  readonly goals: GoalStore;
  readonly plans: PlanStore;
  readonly trades: TradeStore;
  readonly narrator: Narrator | null;
  /** The Test stage v2's inputs for the agent, or null off the fund agent's set. */
  readonly inputs: (ref: AgentRef) => Promise<TestInputsV2 | null>;
  readonly log: (line: string) => void;
  readonly now?: () => Date;
}

export interface AgentRef {
  readonly chainId: number;
  readonly agentId: number;
}

const BPS = 10_000n;
const lower = (t: string) => t.toLowerCase();

/** The classes of every claim a Dive's brief carries, counted. */
export function sourceCounts(theme: Record<string, unknown> | null): SourceCount {
  const out = { onchain: 0, market: 0, primary: 0, news: 0, social: 0 };
  if (!theme) return out;
  const claims: { class?: string }[] = [];
  for (const k of ["evidenceFor", "evidenceAgainst"])
    for (const c of (theme[k] as { class?: string }[] | undefined) ?? []) claims.push(c);
  for (const f of Object.values((theme.fundamentals as Record<string, unknown>) ?? {}))
    if (f && typeof f === "object") claims.push(f as { class?: string });
  for (const c of claims) if (c.class && c.class in out) out[c.class as keyof SourceCount] += 1;
  return out;
}

/**
 * Each proposed position as the owner reads it, from the draft, the plan in
 * force, the RATIONALE's calls, the Dive's brief for its thesis and the
 * Challenge's verdict.
 */
export function proposalPositions(o: {
  readonly params: TargetPortfolioParams;
  readonly current: readonly { token: string; targetWeightBps: number }[];
  readonly rationale: ProposalRationale & {
    readonly positions?: readonly {
      token: string;
      symbol: string;
      action: ProposalPosition["action"];
      themeCode: string | null;
      reason: string;
    }[];
  };
  readonly themes: readonly Record<string, unknown>[];
  readonly challenges: readonly Record<string, unknown>[];
  readonly symbols: Readonly<Record<string, string>>;
}): ProposalPosition[] {
  const calls = new Map((o.rationale.positions ?? []).map((p) => [lower(p.token), p]));
  const current = new Map(o.current.map((p) => [lower(p.token), p.targetWeightBps]));
  const themeOf = (code: string | null) =>
    code ? (o.themes.find((t) => t.themeCode === code) ?? null) : null;
  const verdictOf = (code: string | null) =>
    code
      ? ((o.challenges.find((c) => c.themeCode === code)?.verdict as
          ProposalPosition["verdict"] | undefined) ?? null)
      : null;
  return o.params.positions.map((p) => {
    const call = calls.get(lower(p.token));
    const code = call?.themeCode ?? p.thesisId;
    const theme = themeOf(code);
    const thesis = (theme?.thesis as { statement?: string; confidence?: string } | null) ?? null;
    return {
      token: p.token as Hex,
      symbol: call?.symbol ?? o.symbols[lower(p.token)] ?? String(theme?.symbol ?? p.token),
      targetWeightBps: p.targetWeightBps,
      bandBps: p.bandBps,
      currentWeightBps: current.get(lower(p.token)) ?? null,
      action: call?.action ?? (current.has(lower(p.token)) ? "HOLD" : "ADD"),
      thesisCode: code,
      thesis: thesis?.statement ?? null,
      killCriterion: p.exit.killCriterion,
      recheckAt: p.exit.recheckAt,
      trimAboveBps: p.exit.trimAboveBps ?? null,
      confidence: (thesis?.confidence as ProposalPosition["confidence"]) ?? null,
      sources: sourceCounts(theme),
      verdict: verdictOf(code),
      reason: call?.reason ?? "",
    };
  });
}

/**
 * The estimated cost to move the account to the draft: one leg per token
 * whose value must change by at least the plan's minimum trade (buys quoted
 * at today's depth against the oracle, sells counted at the plan's cost
 * hurdle), with the turnover it implies. Null while a held price is unusable.
 */
export async function estimateMoveCost(
  p: TargetPortfolioParams,
  t: TestInputsV2,
): Promise<ProposalEvaluation["cost"]> {
  const values = new Map<string, bigint>();
  let nav = 0n;
  for (const h of t.agent.holdings) {
    if (h.balance === 0n) continue;
    let v: bigint;
    if (isAddressEqual(h.token as Hex, t.market.usdc)) v = h.balance;
    else {
      const price = t.market.prices[lower(h.token)];
      if (!price || price.priceE18 <= 0n || price.reason !== "OK") return null;
      v = valueE6(h.balance, price.priceE18, h.decimals);
    }
    values.set(lower(h.token), v);
    nav += v;
  }
  if (nav === 0n)
    return {
      legs: 0,
      turnoverUsdcE6: "0",
      estimatedCostUsdcE6: "0",
      costBps: 0,
      basis: "an empty account moves nothing",
    };
  let legs = 0;
  let turnover = 0n;
  let cost = 0n;
  const targets = new Map(p.positions.map((x) => [lower(x.token), x]));
  const tokens = new Set([...values.keys(), ...targets.keys()]);
  tokens.delete(lower(t.market.usdc));
  for (const token of tokens) {
    const target = ((targets.get(token)?.targetWeightBps ?? 0) * Number(nav)) / Number(BPS);
    const now = Number(values.get(token) ?? 0n);
    const delta = BigInt(Math.round(target - now));
    const size = delta < 0n ? -delta : delta;
    if (size < p.minTradeUsdcE6) continue;
    legs += 1;
    turnover += size;
    if (delta > 0n) {
      const out = await t.quoteBuy(token as Hex, size);
      const price = t.market.prices[token];
      const info = t.market.tokens.find((x) => lower(x.token) === token);
      if (out !== null && price && price.priceE18 > 0n && info) {
        const got = valueE6(out, price.priceE18, info.decimals);
        cost += got < size ? size - got : 0n;
      } else cost += (size * BigInt(p.costHurdleBps)) / BPS;
    } else cost += (size * BigInt(p.costHurdleBps)) / BPS;
  }
  return {
    legs,
    turnoverUsdcE6: turnover.toString(),
    estimatedCostUsdcE6: cost.toString(),
    costBps: turnover > 0n ? Number((cost * BPS) / turnover) : 0,
    basis:
      "buys quoted at today's depth against the oracle price, sells counted at the plan's cost hurdle; one leg per token whose value moves by at least the minimum trade",
  };
}

const finding = (e: GoalError): TestFindingV2 => ({
  code: "HARD_LIMIT",
  field: e.field,
  message: e.message,
});

export class ProposalService {
  readonly store: ProposalStore;
  private readonly o: ProposalServiceOptions;

  constructor(o: ProposalServiceOptions) {
    this.o = o;
    this.store = new ProposalStore(o.db);
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  /**
   * Why a proposal waits for the owner: the goal says ask first, or no plan
   * has been set since the agent's open arming began (the first plan after
   * arming always needs approval). Null when it may apply at once.
   */
  async approvalNeeded(ref: AgentRef): Promise<ProposalEvaluation["approval"]> {
    const goal = await this.o.goals.currentGoal(ref.chainId, ref.agentId);
    if (!goal) return "ask_first";
    if (goal.config.planChanges.workflowMode === "require_approval") return "ask_first";
    const arming = await this.o.trades.openArming(ref.chainId, ref.agentId);
    if (!arming) return null;
    const plan = await this.o.plans.active(ref.chainId, ref.agentId);
    if (!plan || plan.createdAt.getTime() < arming.createdAt.getTime())
      return "first_plan_after_arming";
    return null;
  }

  /** The evaluator: the template's shape, the Test stage v2 and the goal's limits, with the cost to move. */
  async evaluate(
    ref: AgentRef,
    plan:
      | { template: typeof TARGET_PORTFOLIO_ID; params: TargetPortfolioParams }
      | { template: "rebalance_bands@1"; params: RebalanceBandsParams },
  ): Promise<ProposalEvaluation> {
    const goal = await this.o.goals.currentGoal(ref.chainId, ref.agentId);
    const approval = await this.approvalNeeded(ref);
    let findings: TestFindingV2[];
    let cost: ProposalEvaluation["cost"] = null;
    if (plan.template === TARGET_PORTFOLIO_ID) {
      findings = checkTargetPortfolioParams(plan.params).map((e) => ({
        code: "OUT_OF_BOUNDS" as const,
        field: e.field,
        message: e.message,
      }));
      const inputs = await this.o.inputs(ref);
      if (!inputs)
        findings.push({
          code: "VALUES_UNUSABLE",
          field: "account",
          message:
            "A target portfolio needs the fund agent's set: the agent has no PersonalAccountV3 here, or the set is not deployed.",
        });
      else {
        findings.push(...(await checkPortfolioProposal(plan.params, inputs)));
        cost = await estimateMoveCost(plan.params, inputs);
        if (cost && cost.legs > 0 && cost.costBps > plan.params.costHurdleBps)
          findings.push({
            code: "COST_HURDLE",
            field: "params.costHurdleBps",
            message: `Moving to this portfolio would cost about ${(cost.costBps / 100).toFixed(2)}% of the ${cost.legs} legs' value at today's depth, above the plan's cost hurdle of ${(plan.params.costHurdleBps / 100).toFixed(2)}%.`,
          });
      }
    } else if (goal) findings = checkPlan(plan.params, goal.config).map(finding);
    else findings = [{ code: "HARD_LIMIT", field: "goal", message: "The agent has no goal." }];
    return {
      checkedAt: this.now().toISOString(),
      passed: findings.length === 0,
      findings,
      cost,
      approval,
    };
  }

  /**
   * The Zoom out's decision, once its stage ended with a record: a stored
   * proposal (evaluated, waiting or applied) or a stored "no change".
   * Returns null when the stage left no decision.
   */
  async fromZoomOut(cycle: Cycle, stage: StageRun): Promise<StoredProposal | null> {
    const ref = { chainId: cycle.chainId, agentId: cycle.agentId };
    const record = await this.o.db
      .selectFrom("platform.stage_records")
      .select(["decision"])
      .where("stage_run_id", "=", stage.stageRunId)
      .executeTakeFirst();
    const decision = record?.decision as
      | { kind: "NO_CHANGE"; reasonCode: string }
      | { kind: "PROPOSE"; template: string; params: Record<string, unknown> }
      | null
      | undefined;
    if (!decision) return null;
    const briefs = await this.o.cycles.briefs({ cycleId: cycle.cycleId, status: "accepted" }, 60);
    const bodyOf = (b: BriefRow) => b.body as Record<string, unknown>;
    const rationaleBrief = briefs.find(
      (b) => b.kind === "RATIONALE" && b.stageRunId === stage.stageRunId,
    );
    const raw = rationaleBrief ? bodyOf(rationaleBrief) : {};
    const rationale: ProposalRationale & {
      positions: {
        token: string;
        symbol: string;
        action: ProposalPosition["action"];
        themeCode: string | null;
        reason: string;
      }[];
    } = {
      decision: decision.kind,
      reasonCode: (raw.reasonCode as string | null) ?? null,
      portfolioView: String(raw.portfolioView ?? ""),
      evidenceStrength: (raw.evidenceStrength as ProposalRationale["evidenceStrength"]) ?? "weak",
      whatWouldChangeIt: String(raw.whatWouldChangeIt ?? ""),
      allocationNote: typeof raw.allocationNote === "string" ? raw.allocationNote : null,
      themeCodes: (raw.themeCodes as string[]) ?? [],
      points: ((raw.points as { text: string; class: string; confidence: string }[]) ?? []).map(
        (p) => ({ text: p.text, class: p.class, confidence: p.confidence }),
      ),
      positions: (raw.positions as never) ?? [],
    };
    // Tied to the epochs the goal was saved under: a sale or a new goal makes the proposal stale.
    const goal = await this.o.goals.currentGoal(ref.chainId, ref.agentId);
    const strategyEpoch = await this.o.goals.strategyEpoch(ref.chainId, ref.agentId);
    const ownerEpoch = goal?.ownerEpoch ?? 0n;
    if (decision.kind === "NO_CHANGE") {
      const stored = await this.store.recordNoChange({
        ...ref,
        cycleId: cycle.cycleId,
        stageRunId: stage.stageRunId,
        strategyEpoch,
        ownerEpoch,
        rationale,
        reasonCode: decision.reasonCode,
        explanation: [
          rationale.portfolioView,
          rationale.whatWouldChangeIt && `What would change it: ${rationale.whatWouldChangeIt}`,
        ]
          .filter(Boolean)
          .join(" "),
        now: this.now(),
      });
      await this.narrate(ref, stored, "no_change");
      return stored;
    }
    const plan =
      decision.template === TARGET_PORTFOLIO_ID
        ? {
            template: TARGET_PORTFOLIO_ID as typeof TARGET_PORTFOLIO_ID,
            params: portfolioParamsFromDecision(decision.params),
          }
        : {
            template: "rebalance_bands@1" as const,
            params: bandsParamsFromDecision(decision.params),
          };
    const current = await this.o.plans.active(ref.chainId, ref.agentId);
    const evaluation = await this.evaluate(ref, plan);
    const positions =
      plan.template === TARGET_PORTFOLIO_ID
        ? proposalPositions({
            params: plan.params,
            current: current && isPortfolioPlan(current) ? current.params.positions : [],
            rationale,
            themes: briefs.filter((b) => b.kind === "THEME").map(bodyOf),
            challenges: briefs.filter((b) => b.kind === "CHALLENGE").map(bodyOf),
            symbols: await this.symbols(ref),
          })
        : [];
    const needsApproval = evaluation.approval !== null;
    let status: "pending_owner" | "applied" | "rejected" = evaluation.passed
      ? needsApproval
        ? "pending_owner"
        : "applied"
      : "rejected";
    let planParamId: string | null = null;
    if (status === "applied") {
      try {
        const set = await this.o.plans.set({ ...ref, setBy: "agent", ...plan });
        planParamId = set.paramId;
      } catch (err) {
        this.o.log(`agent ${ref.agentId}: the proposal could not become the plan: ${String(err)}`);
        status = "rejected";
      }
    }
    const stored = await this.store.create({
      ...ref,
      cycleId: cycle.cycleId,
      stageRunId: stage.stageRunId,
      strategyEpoch,
      ownerEpoch,
      plan,
      rationale,
      positions,
      evaluation,
      status,
      needsApproval,
      planParamId,
      now: this.now(),
    });
    await this.narrate(
      ref,
      stored,
      status === "applied" ? "applied" : status === "rejected" ? "rejected" : "proposed",
    );
    return stored;
  }

  /** The registry's symbols by lowercase address, for a position whose Dive did not name one. */
  async symbols(ref: AgentRef): Promise<Record<string, string>> {
    const inputs = await this.o.inputs(ref).catch(() => null);
    return Object.fromEntries((inputs?.market.tokens ?? []).map((t) => [lower(t.token), t.symbol]));
  }

  /** One activity entry per event, held to the number validator like every other entry. */
  async narrate(ref: AgentRef, p: StoredProposal, event: ProposalFacts["event"]): Promise<void> {
    if (!this.o.narrator) return;
    const facts = proposalFacts(`Alpha Agent #${ref.agentId}`, p, event);
    try {
      await this.o.narrator.narrateEvent(
        ref.chainId,
        ref.agentId,
        `${p.proposalId}:${event}`,
        facts,
      );
    } catch (err) {
      this.o.log(`agent ${ref.agentId}: proposal narration failed: ${String(err)}`);
    }
  }
}

/** The Zoom out's decision params, as complete_stage accepted them, into the policy's shapes. */
export function portfolioParamsFromDecision(raw: Record<string, unknown>): TargetPortfolioParams {
  const r = raw as {
    positions: TargetPortfolioParams["positions"];
    cashTargetBps: number;
    minTradeUsdc: string;
    volatilityBrakeBps: number;
    costHurdleBps: number;
    maxLegBps: number;
  };
  return {
    positions: r.positions.map((p) => ({
      token: p.token as Hex,
      targetWeightBps: p.targetWeightBps,
      bandBps: p.bandBps,
      thesisId: p.thesisId,
      exit: {
        killCriterion: p.exit.killCriterion,
        recheckAt: p.exit.recheckAt,
        ...(p.exit.trimAboveBps === undefined ? {} : { trimAboveBps: p.exit.trimAboveBps }),
      },
    })),
    cashTargetBps: r.cashTargetBps,
    minTradeUsdcE6: usdcE6(r.minTradeUsdc),
    volatilityBrakeBps: r.volatilityBrakeBps,
    costHurdleBps: r.costHurdleBps,
    maxLegBps: r.maxLegBps,
  };
}

export function bandsParamsFromDecision(raw: Record<string, unknown>): RebalanceBandsParams {
  const r = raw as {
    targetWmonBps: number;
    bandHalfWidthBps: number;
    minTradeUsdc: string;
    volatilityBrakeBps: number;
    costHurdleBps: number;
    maxLegBps: number;
  };
  return {
    targetWmonBps: r.targetWmonBps,
    bandHalfWidthBps: r.bandHalfWidthBps,
    minTradeUsdcE6: usdcE6(r.minTradeUsdc),
    volatilityBrakeBps: r.volatilityBrakeBps,
    costHurdleBps: r.costHurdleBps,
    maxLegBps: r.maxLegBps,
  };
}

/** "1.5" USDC as micro-USDC. */
function usdcE6(amount: string): bigint {
  const [whole = "0", frac = ""] = amount.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}
