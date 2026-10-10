import {
  AGGRESSIVENESS_ENVELOPES,
  AGGRESSIVENESS_OF_PRESET,
  RISK_PRESET_FACTS,
} from "@alpha-agents/domain";
import {
  type RebalanceBandsParams,
  TARGET_PORTFOLIO_ID,
  type TargetPortfolioParams,
  checkPlan,
  checkTargetPortfolioParams,
} from "@alpha-agents/policy";
import { type RunnerDecision, type StoredPlan, isBandsPlan } from "@alpha-agents/trading";
import type { Hono } from "hono";
import type { Hex } from "viem";
import { z } from "zod";
import type { Orchestrator } from "./orchestrator.ts";
import { holdMessage } from "./runner.ts";

/**
 * The console's plan and runner routes (P3-U3): an agent's plan with the
 * goal's defaults and limits, the runner's recent decisions, setting a plan
 * (until P3-U6's proposals the owner or the console sets it) and running the
 * runner once now (local only). Setting a plan bumps the strategy epoch.
 * F-U6 adds the target portfolio (D-344): a plan names its template, a
 * target portfolio is checked by the Test stage v2 before it is set, a draft
 * can be checked without setting it, and the view carries the aggressiveness
 * envelope and the registered tokens the console's form offers.
 */
export const PlanInput = z.strictObject({
  template: z.literal("rebalance_bands@1").optional(),
  targetWmonBps: z.int().min(0).max(10_000),
  bandHalfWidthBps: z.int().min(0).max(10_000),
  /** USDC base units as a decimal string. */
  minTradeUsdcE6: z.string().regex(/^\d{1,12}$/),
  volatilityBrakeBps: z.int().min(0).max(100_000),
  costHurdleBps: z.int().min(0).max(10_000),
  maxLegBps: z.int().min(0).max(10_000),
});

export const PortfolioPlanInput = z.strictObject({
  template: z.literal(TARGET_PORTFOLIO_ID),
  positions: z
    .array(
      z.strictObject({
        token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        targetWeightBps: z.int().min(0).max(10_000),
        bandBps: z.int().min(0).max(10_000),
        thesisId: z.string().min(1).max(64),
        exit: z.strictObject({
          killCriterion: z.string().min(1).max(280),
          recheckAt: z.string().min(1).max(40),
          trimAboveBps: z.int().min(0).max(10_000).optional(),
        }),
      }),
    )
    .max(16),
  cashTargetBps: z.int().min(0).max(10_000),
  minTradeUsdcE6: z.string().regex(/^\d{1,12}$/),
  volatilityBrakeBps: z.int().min(0).max(100_000),
  costHurdleBps: z.int().min(0).max(10_000),
  maxLegBps: z.int().min(0).max(10_000),
});

export const paramsJson = (p: RebalanceBandsParams) => ({
  ...p,
  minTradeUsdcE6: p.minTradeUsdcE6.toString(),
});

export const portfolioParamsView = (p: TargetPortfolioParams) => ({
  positions: p.positions.map((pos) => ({
    token: pos.token,
    targetWeightBps: pos.targetWeightBps,
    bandBps: pos.bandBps,
    thesisId: pos.thesisId,
    exit: pos.exit,
  })),
  cashTargetBps: p.cashTargetBps,
  minTradeUsdcE6: p.minTradeUsdcE6.toString(),
  volatilityBrakeBps: p.volatilityBrakeBps,
  costHurdleBps: p.costHurdleBps,
  maxLegBps: p.maxLegBps,
});

/** The portfolio input's parameters in the template's units. */
export function portfolioParamsOf(
  input: z.infer<typeof PortfolioPlanInput>,
): TargetPortfolioParams {
  return {
    positions: input.positions.map((pos) => ({
      token: pos.token.toLowerCase() as Hex,
      targetWeightBps: pos.targetWeightBps,
      bandBps: pos.bandBps,
      thesisId: pos.thesisId,
      exit: {
        killCriterion: pos.exit.killCriterion,
        recheckAt: pos.exit.recheckAt,
        ...(pos.exit.trimAboveBps === undefined ? {} : { trimAboveBps: pos.exit.trimAboveBps }),
      },
    })),
    cashTargetBps: input.cashTargetBps,
    minTradeUsdcE6: BigInt(input.minTradeUsdcE6),
    volatilityBrakeBps: input.volatilityBrakeBps,
    costHurdleBps: input.costHurdleBps,
    maxLegBps: input.maxLegBps,
  };
}

export const planJson = (p: StoredPlan) => ({
  paramId: p.paramId,
  template: p.template,
  params: isBandsPlan(p) ? paramsJson(p.params) : portfolioParamsView(p.params),
  paramsHash: p.paramsHash,
  strategyEpoch: p.strategyEpoch.toString(),
  setBy: p.setBy,
  createdAt: p.createdAt.toISOString(),
});

export const decisionJson = (d: RunnerDecision) => ({
  decisionId: d.decisionId,
  outcome: d.outcome,
  code: d.code,
  codes: d.codes,
  message: d.outcome === "leg" ? "Proposed a leg toward the target." : holdMessage(d.code),
  leg: d.leg,
  intentId: d.intentId,
  facts: d.facts,
  strategyEpoch: d.strategyEpoch.toString(),
  paramId: d.paramId,
  block: d.block?.toString() ?? null,
  firstAt: d.firstAt.toISOString(),
  lastAt: d.lastAt.toISOString(),
  ticks: d.ticks,
});

export function registerPlanRoutes(
  app: Hono,
  o: {
    orchestrator: Orchestrator;
    chainId: number;
    agentRef: (raw: string) => { chainId: number; agentId: number } | null;
    canSet: boolean;
    canRun: boolean;
  },
): void {
  const orch = o.orchestrator;

  app.get("/v1/agents/:agentId/plan", async (c) => {
    const ref = o.agentRef(c.req.param("agentId"));
    if (!ref) return c.json({ error: "bad_agent_id" }, 400);
    const [goal, plan, decisions, epoch, portfolio] = await Promise.all([
      orch.goals.currentGoal(ref.chainId, ref.agentId),
      orch.plans.active(ref.chainId, ref.agentId),
      orch.decisions.recent(ref.chainId, ref.agentId, 10),
      orch.goals.strategyEpoch(ref.chainId, ref.agentId),
      orch.portfolioPlanView(ref).catch(() => null),
    ]);
    const aggressiveness = goal ? AGGRESSIVENESS_OF_PRESET[goal.goal.riskPreset] : null;
    return c.json({
      agentId: String(ref.agentId),
      runner: {
        on: Boolean(orch.runner),
        canSet: o.canSet,
        canRun: o.canRun && Boolean(orch.runner),
      },
      strategyEpoch: epoch.toString(),
      goal: goal
        ? {
            riskPreset: goal.goal.riskPreset,
            presetLabel: RISK_PRESET_FACTS[goal.goal.riskPreset].label,
            defaults: goal.config.template.params,
            targetRange: goal.config.targetRange,
            ownerLimits: goal.config.ownerLimits,
            aggressiveness,
            envelope: aggressiveness ? AGGRESSIVENESS_ENVELOPES[aggressiveness] : null,
          }
        : null,
      plan: plan ? { ...planJson(plan), stale: plan.strategyEpoch !== epoch } : null,
      decisions: decisions.map(decisionJson),
      // F-U6: the fund agent's set, when the agent is on it: its tokens for the console's form.
      portfolio,
    });
  });

  if (o.canSet) {
    /** F-U6: checks a target portfolio draft with the Test stage v2 without setting it. */
    app.post("/v1/agents/:agentId/plan/check", async (c) => {
      const ref = o.agentRef(c.req.param("agentId"));
      if (!ref) return c.json({ error: "bad_agent_id" }, 400);
      const parsed = PortfolioPlanInput.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        return c.json(
          { error: "invalid_plan", issues: parsed.error.issues.map((i) => i.path.join(".")) },
          400,
        );
      const goal = await orch.goals.currentGoal(ref.chainId, ref.agentId);
      if (!goal)
        return c.json(
          { error: "no_goal", message: "The agent has no goal yet; its owner saves one first." },
          409,
        );
      const r = await orch.checkPortfolioPlan(ref, portfolioParamsOf(parsed.data));
      if (!r.ok) return c.json({ error: r.error, message: r.message }, 409);
      return c.json({ findings: r.findings, passed: r.findings.length === 0 });
    });

    app.put("/v1/agents/:agentId/plan", async (c) => {
      const ref = o.agentRef(c.req.param("agentId"));
      if (!ref) return c.json({ error: "bad_agent_id" }, 400);
      const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      const goal = await orch.goals.currentGoal(ref.chainId, ref.agentId);
      const noGoal = () =>
        c.json(
          { error: "no_goal", message: "The agent has no goal yet; its owner saves one first." },
          409,
        );
      if (raw?.template === TARGET_PORTFOLIO_ID) {
        const parsed = PortfolioPlanInput.safeParse(raw);
        if (!parsed.success)
          return c.json(
            { error: "invalid_plan", issues: parsed.error.issues.map((i) => i.path.join(".")) },
            400,
          );
        if (!goal) return noGoal();
        const params = portfolioParamsOf(parsed.data);
        const shape = checkTargetPortfolioParams(params);
        if (shape.length > 0)
          return c.json(
            {
              error: "plan_out_of_bounds",
              message: shape.map((e) => e.message).join(" "),
              errors: shape,
            },
            400,
          );
        const r = await orch.checkPortfolioPlan(ref, params);
        if (!r.ok) return c.json({ error: r.error, message: r.message }, 409);
        if (r.findings.length > 0)
          return c.json(
            {
              error: "plan_refused",
              message: r.findings.map((f) => `${f.code}: ${f.message}`).join(" "),
              findings: r.findings,
            },
            400,
          );
        const plan = await orch.plans.set({
          ...ref,
          template: TARGET_PORTFOLIO_ID,
          params,
          setBy: "console",
        });
        return c.json({ plan: planJson(plan) }, 201);
      }
      const parsed = PlanInput.safeParse(raw);
      if (!parsed.success)
        return c.json(
          { error: "invalid_plan", issues: parsed.error.issues.map((i) => i.path.join(".")) },
          400,
        );
      if (!goal) return noGoal();
      const params: RebalanceBandsParams = {
        targetWmonBps: parsed.data.targetWmonBps,
        bandHalfWidthBps: parsed.data.bandHalfWidthBps,
        minTradeUsdcE6: BigInt(parsed.data.minTradeUsdcE6),
        volatilityBrakeBps: parsed.data.volatilityBrakeBps,
        costHurdleBps: parsed.data.costHurdleBps,
        maxLegBps: parsed.data.maxLegBps,
      };
      const errors = checkPlan(params, goal.config);
      if (errors.length > 0)
        return c.json(
          { error: "plan_out_of_bounds", message: errors.map((e) => e.message).join(" "), errors },
          400,
        );
      const plan = await orch.plans.set({ ...ref, params, setBy: "console" });
      return c.json({ plan: planJson(plan) }, 201);
    });
  }

  if (o.canRun)
    app.post("/v1/agents/:agentId/runner/run", async (c) => {
      const ref = o.agentRef(c.req.param("agentId"));
      if (!ref) return c.json({ error: "bad_agent_id" }, 400);
      if (!orch.runner)
        return c.json(
          { error: "runner_off", message: "The runner is off: trading is not running here." },
          409,
        );
      const d = await orch.runner.runAgent(ref.agentId);
      if (!d) return c.json({ error: "no_plan", message: "The agent has no plan." }, 409);
      return c.json({ decision: decisionJson(d) });
    });
}
