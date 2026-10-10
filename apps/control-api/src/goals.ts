import {
  AGGRESSIVENESS_ENVELOPES,
  AGGRESSIVENESS_FACTS,
  AGGRESSIVENESS_LEVELS,
  COST_PREVIEW_DAYS,
  DEFAULT_GOAL_INPUT,
  MAX_CREDIT_RESERVE_USDC_E6,
  MAX_EXCLUDED_TOKENS,
  MODEL_TIERS,
  MODEL_TIER_FACTS,
  OWNER_LIMIT_FACTS,
  OWNER_LIMIT_FIELDS,
  RESEARCH_INTENSITIES,
  RESEARCH_INTENSITY_FACTS,
} from "@alpha-agents/domain";
import type { Db } from "@alpha-agents/db";
import {
  type GoalConfig,
  type GoalError,
  canonicalJson,
  hardGoalLimits,
  ownerLimitRanges,
} from "@alpha-agents/policy";
import type { AgentGoalView, StoredGoal } from "@alpha-agents/trading";

/**
 * The goal's JSON for the Goal page (P3-U1, F-U7): the saved goal and what it
 * translated to, and the form's levels, tiers, tokens, ranges and cost
 * preview, every amount a base-unit string. The labels and explanations come
 * from packages/domain; the numbers that depend on the hard limits come from
 * here; the tokens the owner may exclude come from the platform's registry.
 */

/** The activation sweep's shown maximum per model tier (A-51, A-75), for the cost preview. */
const SWEEP_MAX_USDC_E6 = { LOW: 2_000_000n, MEDIUM: 4_000_000n, HIGH: 7_500_000n } as const;

/** Every bound the form needs, from the hard limits, the levels and the registry (D-293, D-299, D-345). */
export async function goalForm(db: Db | null = null, chainId: number | null = null) {
  const ranges = ownerLimitRanges();
  const hard = hardGoalLimits();
  const tokens =
    db && chainId !== null
      ? (
          await db
            .selectFrom("platform.tokens")
            .select(["address", "symbol", "price_class"])
            .where("chain_id", "=", chainId)
            .orderBy("liquidity_usd", "desc")
            .limit(200)
            .execute()
        ).map((t) => ({ address: t.address, symbol: t.symbol, priceClass: t.price_class }))
      : [];
  return {
    defaults: DEFAULT_GOAL_INPUT,
    hardLimits: hard,
    levels: AGGRESSIVENESS_LEVELS.map((id) => ({
      id,
      label: AGGRESSIVENESS_FACTS[id].label,
      summary: AGGRESSIVENESS_FACTS[id].summary,
      brief: AGGRESSIVENESS_FACTS[id].brief,
      envelope: AGGRESSIVENESS_ENVELOPES[id],
    })),
    tiers: MODEL_TIERS.map((id) => ({ id, ...MODEL_TIER_FACTS[id] })),
    tokens,
    maxExcludedTokens: MAX_EXCLUDED_TOKENS,
    limits: OWNER_LIMIT_FIELDS.map((field) => ({
      field,
      direction: OWNER_LIMIT_FACTS[field].direction,
      unit: OWNER_LIMIT_FACTS[field].unit,
      min: ranges[field].min,
      max: ranges[field].max,
      hard: hard[field],
    })),
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
      LOW: SWEEP_MAX_USDC_E6.LOW.toString(),
      MEDIUM: SWEEP_MAX_USDC_E6.MEDIUM.toString(),
      HIGH: SWEEP_MAX_USDC_E6.HIGH.toString(),
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

/** The public summary (FINAL_PLAN 6.1): the aggressiveness only. */
export function goalSummaryJson(v: AgentGoalView) {
  return v.goal
    ? { configured: true, aggressiveness: v.goal.config.aggressiveness }
    : { configured: false, aggressiveness: null };
}

export function goalErrorsJson(errors: readonly GoalError[]) {
  return errors.map((e) => ({ field: e.field, code: e.code, message: e.message }));
}
