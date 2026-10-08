import {
  COST_PREVIEW_DAYS,
  DEFAULT_GOAL_INPUT,
  MAX_CREDIT_RESERVE_USDC_E6,
  OWNER_LIMIT_FACTS,
  OWNER_LIMIT_FIELDS,
  RESEARCH_INTENSITIES,
  RESEARCH_INTENSITY_FACTS,
  RISK_PRESETS,
  RISK_PRESET_FACTS,
} from "@alpha-agents/domain";
import {
  type GoalConfig,
  type GoalError,
  canonicalJson,
  hardGoalLimits,
  ownerLimitRanges,
} from "@alpha-agents/policy";
import type { AgentGoalView, StoredGoal } from "@alpha-agents/trading";

/**
 * The goal's JSON for the Goal page (P3-U1): the saved goal and what it
 * translated to, and the form's ranges and cost preview, every amount a
 * base-unit string. The labels and explanations come from packages/domain;
 * the numbers that depend on the hard limits come from here.
 */

/** The activation sweep's shown maximum per reasoning model (A-51), for the cost preview. */
const SWEEP_MAX_USDC_E6 = { STANDARD: 4_000_000n, DEEP: 7_500_000n } as const;

/** Every bound the form needs, from the hard limits and the presets (D-278, D-293, D-299). */
export function goalForm() {
  const ranges = ownerLimitRanges();
  const hard = hardGoalLimits();
  return {
    defaults: DEFAULT_GOAL_INPUT,
    hardLimits: hard,
    limits: OWNER_LIMIT_FIELDS.map((field) => ({
      field,
      direction: OWNER_LIMIT_FACTS[field].direction,
      unit: OWNER_LIMIT_FACTS[field].unit,
      min: ranges[field].min,
      max: ranges[field].max,
      hard: hard[field],
    })),
    presets: RISK_PRESETS.map((id) => ({ id, ...RISK_PRESET_FACTS[id] })),
    intensities: RESEARCH_INTENSITIES.map((id) => {
      const f = RESEARCH_INTENSITY_FACTS[id];
      return {
        id,
        scanEveryHours: f.scanEveryHours,
        divesPerDay: f.divesPerDay,
        defaultDailyBudgetUsdcE6: f.defaultDailyBudgetUsdcE6.toString(),
        minDailyBudgetUsdcE6: f.minDailyBudgetUsdcE6.toString(),
        maxDailyBudgetUsdcE6: f.maxDailyBudgetUsdcE6.toString(),
        // D-299: what a month costs at most at the default budget, which is a hard cap.
        monthlyAtDefaultUsdcE6: (f.defaultDailyBudgetUsdcE6 * BigInt(COST_PREVIEW_DAYS)).toString(),
      };
    }),
    costPreviewDays: COST_PREVIEW_DAYS,
    sweepMaxUsdcE6: {
      STANDARD: SWEEP_MAX_USDC_E6.STANDARD.toString(),
      DEEP: SWEEP_MAX_USDC_E6.DEEP.toString(),
    },
    maxCreditReserveUsdcE6: MAX_CREDIT_RESERVE_USDC_E6.toString(),
  };
}

/** A translated configuration as JSON: bigints as decimal strings, the SOUL.md block left out. */
export function configJson(c: GoalConfig | StoredGoal["config"]) {
  const rest: Record<string, unknown> = { ...c };
  delete rest.soulBlock;
  return JSON.parse(canonicalJson(rest)) as StoredGoal["config"];
}

export function goalViewJson(v: AgentGoalView) {
  return {
    state: v.state,
    strategyEpoch: v.strategyEpoch.toString(),
    goal: v.goal?.goal ?? null,
    config: v.goal ? configJson(v.goal.config) : null,
    policyHash: v.goal?.policyHash ?? null,
    savedAt: v.goal?.createdAt.toISOString() ?? null,
    savedBy: v.goal?.savedBy ?? null,
  };
}

/** The public summary (FINAL_PLAN 6.1): template and risk preset only. */
export function goalSummaryJson(v: AgentGoalView) {
  return v.goal
    ? { configured: true, template: v.goal.goal.template, riskPreset: v.goal.goal.riskPreset }
    : { configured: false, template: null, riskPreset: null };
}

export function goalErrorsJson(errors: readonly GoalError[]) {
  return errors.map((e) => ({ field: e.field, code: e.code, message: e.message }));
}
