import { RISK_PRESET_FACTS } from "@alpha-agents/domain";
import { type RebalanceBandsParams, checkPlan } from "@alpha-agents/policy";
import type { RunnerDecision, StoredPlan } from "@alpha-agents/trading";
import type { Hono } from "hono";
import { z } from "zod";
import type { Orchestrator } from "./orchestrator.ts";
import { holdMessage } from "./runner.ts";

/**
 * The console's plan and runner routes (P3-U3): an agent's plan with the
 * goal's defaults and limits, the runner's recent decisions, setting a plan
 * (until P3-U6's proposals the owner or the console sets it) and running the
 * runner once now (local only). Setting a plan bumps the strategy epoch.
 */
export const PlanInput = z.strictObject({
  targetWmonBps: z.int().min(0).max(10_000),
  bandHalfWidthBps: z.int().min(0).max(10_000),
  /** USDC base units as a decimal string. */
  minTradeUsdcE6: z.string().regex(/^\d{1,12}$/),
  volatilityBrakeBps: z.int().min(0).max(100_000),
  costHurdleBps: z.int().min(0).max(10_000),
  maxLegBps: z.int().min(0).max(10_000),
});

export const paramsJson = (p: RebalanceBandsParams) => ({
  ...p,
  minTradeUsdcE6: p.minTradeUsdcE6.toString(),
});

export const planJson = (p: StoredPlan) => ({
  paramId: p.paramId,
  template: p.template,
  params: paramsJson(p.params),
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
    const [goal, plan, decisions, epoch] = await Promise.all([
      orch.goals.currentGoal(ref.chainId, ref.agentId),
      orch.plans.active(ref.chainId, ref.agentId),
      orch.decisions.recent(ref.chainId, ref.agentId, 10),
      orch.goals.strategyEpoch(ref.chainId, ref.agentId),
    ]);
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
          }
        : null,
      plan: plan ? { ...planJson(plan), stale: plan.strategyEpoch !== epoch } : null,
      decisions: decisions.map(decisionJson),
    });
  });

  if (o.canSet)
    app.put("/v1/agents/:agentId/plan", async (c) => {
      const ref = o.agentRef(c.req.param("agentId"));
      if (!ref) return c.json({ error: "bad_agent_id" }, 400);
      const parsed = PlanInput.safeParse(await c.req.json().catch(() => null));
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
      const params: RebalanceBandsParams = {
        ...parsed.data,
        minTradeUsdcE6: BigInt(parsed.data.minTradeUsdcE6),
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
