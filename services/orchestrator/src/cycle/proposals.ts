import type { Db } from "@alpha-agents/db";
import {
  type GoalError,
  type RebalanceBandsParams,
  TARGET_PORTFOLIO_ID,
  type TargetPortfolioParams,
  checkPlan,
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
  type StoredPlan,
  type StoredProposal,
  type TradeStore,
  isPortfolioPlan,
} from "@alpha-agents/trading";
import type { Hex } from "viem";
import type { Narrator } from "../narrator.ts";
import type { BriefRow, Cycle, CycleStore, StageRun } from "./store.ts";
import {
  type PlanInputsFingerprint,
  type TargetPortfolioDecisionParams,
  checkTargetPortfolio,
  stateChangedFinding,
  targetPortfolioFromDecision,
} from "./plan-rules.ts";
import type { TestFindingV2, TestInputsV2 } from "./test-stage.ts";

export { estimateMoveCost } from "./plan-rules.ts";

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
  /**
   * The evaluator: one rule set with the Test stage (F-T2, `checkTargetPortfolio`), with the cost to
   * move. With `tested`, the fingerprint the Test took when it accepted the plan, a refusal now names
   * what changed since (STATE_CHANGED), so a plan the Test accepted fails here only for a reason.
   */
  async evaluate(
    ref: AgentRef,
    plan:
      | { template: typeof TARGET_PORTFOLIO_ID; params: TargetPortfolioParams }
      | { template: "rebalance_bands@1"; params: RebalanceBandsParams },
    o: { readonly tested?: PlanInputsFingerprint | null } = {},
  ): Promise<ProposalEvaluation> {
    const goal = await this.o.goals.currentGoal(ref.chainId, ref.agentId);
    const approval = await this.approvalNeeded(ref);
    let findings: TestFindingV2[];
    let cost: ProposalEvaluation["cost"] = null;
    if (plan.template === TARGET_PORTFOLIO_ID) {
      const inputs = await this.o.inputs(ref);
      if (!inputs)
        findings = [
          {
            code: "VALUES_UNUSABLE",
            field: "account",
            message:
              "A target portfolio needs the fund agent's set: the agent has no PersonalAccountV3 here, or the set is not deployed.",
          },
        ];
      else {
        const verdict = await checkTargetPortfolio(plan.params, inputs);
        findings = verdict.findings;
        cost = verdict.cost;
        if (findings.length > 0 && o.tested) {
          const symbols = Object.fromEntries(
            inputs.market.tokens.map((t) => [t.token.toLowerCase(), t.symbol]),
          );
          findings.push(stateChangedFinding(o.tested, verdict.fingerprint, symbols));
        }
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
    // 2026-10-15: a draft of the allocation already in force is the plan kept, said as such.
    if (sameAllocation(plan, current)) {
      const stored = await this.store.recordNoChange({
        ...ref,
        cycleId: cycle.cycleId,
        stageRunId: stage.stageRunId,
        strategyEpoch,
        ownerEpoch,
        rationale: { ...rationale, decision: "NO_CHANGE", reasonCode: "NO_MATERIAL_CHANGE" },
        reasonCode: "NO_MATERIAL_CHANGE",
        explanation: [
          "The research kept the plan in force.",
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
    // F-T2: the fingerprint the Test took when it accepted this plan, so a refusal now names what changed.
    const testStage = (await this.o.cycles.stages(cycle.cycleId)).find((s) => s.stage === "TEST");
    const checked = (
      (testStage?.outcome ?? {}) as {
        checked?: { passed: boolean; fingerprint?: PlanInputsFingerprint }[];
      }
    ).checked;
    const tested = [...(checked ?? [])].reverse().find((c) => c.passed)?.fingerprint ?? null;
    const evaluation = await this.evaluate(ref, plan, { tested });
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

/**
 * 2026-10-15: whether a drafted plan keeps the allocation in force: the same template, the
 * same tokens at the same target weights and the same cash (or the same WMON target on the
 * two-asset plan). Exits, bands and trade settings may differ; the owner sees the plan kept.
 */
export function sameAllocation(
  draft:
    | { readonly template: typeof TARGET_PORTFOLIO_ID; readonly params: TargetPortfolioParams }
    | { readonly template: "rebalance_bands@1"; readonly params: RebalanceBandsParams },
  current: StoredPlan | null,
): boolean {
  if (!current || current.template !== draft.template) return false;
  if (draft.template === "rebalance_bands@1")
    return (current.params as RebalanceBandsParams).targetWmonBps === draft.params.targetWmonBps;
  const now = current.params as TargetPortfolioParams;
  if (now.cashTargetBps !== draft.params.cashTargetBps) return false;
  if (now.positions.length !== draft.params.positions.length) return false;
  const weights = new Map(now.positions.map((p) => [lower(p.token), p.targetWeightBps]));
  return draft.params.positions.every((p) => weights.get(lower(p.token)) === p.targetWeightBps);
}

/** The Zoom out's decision params, as complete_stage accepted them, into the policy's shape: the Test's own conversion (F-T2, L-220). */
export function portfolioParamsFromDecision(raw: Record<string, unknown>): TargetPortfolioParams {
  return targetPortfolioFromDecision(raw as unknown as TargetPortfolioDecisionParams);
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
