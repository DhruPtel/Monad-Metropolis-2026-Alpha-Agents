import {
  AVAILABLE_TEMPLATES,
  COST_PREVIEW_DAYS,
  type GoalInput,
  GoalInputSchema,
  MAX_CREDIT_RESERVE_USDC_E6,
  OWNER_LIMIT_FACTS,
  OWNER_LIMIT_FIELDS,
  type OwnerLimitField,
  PLAN_CHANGE_WORKFLOW_MODE,
  type PlanChangeMode,
  REASONING_MODEL_FACTS,
  RESEARCH_INTENSITIES,
  RESEARCH_INTENSITY_FACTS,
  type ResearchIntensity,
  RISK_PRESET_FACTS,
  type RiskPreset,
  TEMPLATE_FACTS,
} from "@alpha-agents/domain";
import { keccak256, toBytes } from "viem";
import { LAUNCH_LIMITS, type PolicyLimits } from "./limits.ts";

/**
 * The goal translator (P3-U1, FINAL_PLAN 4.3.6, D-098): a pure, deterministic
 * function from the owner's structured goal to the configuration every later
 * stage reads. It refuses anything that would loosen a hard limit, so the
 * owner's stricter limits can only tighten the Executor's.
 */

/** `rebalance_bands@1`'s parameters. P3-U3 adds the runner that reads them. */
export interface RebalanceBandsParams {
  /** The target WMON weight, basis points of the account's value. */
  readonly targetWmonBps: number;
  /** Half the band around the target, in basis points (500 = ±5 points). */
  readonly bandHalfWidthBps: number;
  /** The smallest leg worth trading, USDC base units. */
  readonly minTradeUsdcE6: bigint;
  /** Annualized 24-hour realized volatility above which buys hold, basis points (A-58). */
  readonly volatilityBrakeBps: number;
  /** The most a leg may cost against the oracle (fee and price impact), basis points (A-58). */
  readonly costHurdleBps: number;
  /** The largest leg, basis points of the account's value; never above the per-trade cap. */
  readonly maxLegBps: number;
}

type Bound = readonly [min: bigint, max: bigint];

/** The template's own bounds; a parameter set outside them is never configuration. */
export const REBALANCE_BANDS_V1_BOUNDS: Readonly<Record<keyof RebalanceBandsParams, Bound>> =
  Object.freeze({
    targetWmonBps: [0n, BigInt(LAUNCH_LIMITS.maxAssetBps)],
    bandHalfWidthBps: [100n, 1_000n],
    minTradeUsdcE6: [100_000n, 100_000_000n],
    volatilityBrakeBps: [2_000n, 30_000n],
    costHurdleBps: [5n, BigInt(LAUNCH_LIMITS.maxSlippageBps)],
    maxLegBps: [10n, BigInt(LAUNCH_LIMITS.maxTradeBps)],
  });

/**
 * The parameters each preset adds to D-278's range, target and band. The buy
 * brakes were measured in P3-U3 (A-58) against MON's 24-hour volatility over
 * 20 days (median 114%, p75 146%, p90 211%, p95 235%): A-55's 80%, 120% and
 * 160% would have held buys 92%, 46% and 20% of hours, so they are 150%,
 * 200% and 250% (about 25%, 11% and 2% of hours). The cost limits stand.
 */
export const PRESET_EXTRAS: Readonly<
  Record<RiskPreset, Pick<RebalanceBandsParams, "volatilityBrakeBps" | "costHurdleBps">>
> = {
  CONSERVATIVE: { volatilityBrakeBps: 15_000, costHurdleBps: 30 },
  BALANCED: { volatilityBrakeBps: 20_000, costHurdleBps: 40 },
  GROWTH: { volatilityBrakeBps: 25_000, costHurdleBps: 50 },
};
const DEFAULT_MIN_TRADE_USDC_E6 = 500_000n;

/** The limits the account trades under: the hard limit, or the owner's stricter value. */
export interface EffectiveLimits {
  readonly maxTradeBps: number;
  readonly maxWmonShareBps: number;
  readonly minUsdcShareBps: number;
  readonly maxSlippageBps: number;
  readonly maxTradesPer24h: number;
}

export interface GoalConfig {
  /** The goal exactly as validated. */
  readonly goal: GoalInput;
  readonly template: { readonly id: "rebalance_bands@1"; readonly params: RebalanceBandsParams };
  /** The range the agent may move the target in: the preset's, narrowed by the owner's limits. */
  readonly targetRange: { readonly minBps: number; readonly maxBps: number };
  readonly researchTriggerBps: number;
  readonly hardLimits: EffectiveLimits;
  readonly ownerLimits: EffectiveLimits;
  readonly research: {
    readonly intensity: ResearchIntensity;
    readonly scanEveryHours: number;
    readonly divesPerDay: number;
    readonly dailyBudgetUsdcE6: bigint;
    readonly monthlyMaxUsdcE6: bigint;
  };
  readonly model: { readonly choice: GoalInput["reasoningModel"]; readonly alias: string };
  readonly creditReserveUsdcE6: bigint;
  readonly planChanges: {
    readonly mode: PlanChangeMode;
    readonly workflowMode: "require_approval" | "notify";
  };
  /** keccak256 of the canonical JSON of everything above. */
  readonly policyHash: `0x${string}`;
  /** The goal block of the agent's SOUL.md, rendered from a fixed template. */
  readonly soulBlock: string;
}

export const GOAL_ERROR_CODES = [
  "INVALID_FIELD",
  "TEMPLATE_NOT_AVAILABLE",
  "LOOSER_THAN_HARD_LIMIT",
  "TIGHTER_THAN_ALLOWED",
  "BUDGET_OUT_OF_RANGE",
  "RESERVE_OUT_OF_RANGE",
  "OUT_OF_TEMPLATE_BOUNDS",
] as const;
export type GoalErrorCode = (typeof GOAL_ERROR_CODES)[number];

export interface GoalError {
  /** The field's path, for example "stricterLimits.maxTradeBps". */
  readonly field: string;
  readonly code: GoalErrorCode;
  readonly message: string;
}

export type GoalTranslation =
  | { readonly ok: true; readonly config: GoalConfig }
  | { readonly ok: false; readonly errors: readonly GoalError[] };

/** The hard limits as the goal names them. */
export function hardGoalLimits(limits: PolicyLimits = LAUNCH_LIMITS): EffectiveLimits {
  return {
    maxTradeBps: limits.maxTradeBps,
    maxWmonShareBps: limits.maxAssetBps,
    minUsdcShareBps: limits.minUsdcBps,
    maxSlippageBps: limits.maxSlippageBps,
    maxTradesPer24h: limits.maxTradesPerWindow,
  };
}

/** Each stricter limit's accepted range: from its tightest value to its hard limit. */
export function ownerLimitRanges(
  limits: PolicyLimits = LAUNCH_LIMITS,
): Readonly<Record<OwnerLimitField, { readonly min: number; readonly max: number }>> {
  const hard = hardGoalLimits(limits);
  const out = {} as Record<OwnerLimitField, { min: number; max: number }>;
  for (const f of OWNER_LIMIT_FIELDS) {
    const facts = OWNER_LIMIT_FACTS[f];
    out[f] =
      facts.direction === "max"
        ? { min: facts.tightest, max: hard[f] }
        : { min: hard[f], max: facts.tightest };
  }
  return out;
}

const bps = (n: number) => `${(n / 100).toFixed(n % 100 === 0 ? 0 : 2)}%`;
const usdc = (e6: bigint) => {
  const whole = e6 / 1_000_000n;
  const frac = (e6 % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${whole}.${frac} USDC`;
};

function limitError(f: OwnerLimitField, value: number, hard: number): GoalError {
  const facts = OWNER_LIMIT_FACTS[f];
  const shown = (n: number) => (facts.unit === "bps" ? bps(n) : `${n}`);
  const looser = facts.direction === "max" ? value > hard : value < hard;
  return looser
    ? {
        field: `stricterLimits.${f}`,
        code: "LOOSER_THAN_HARD_LIMIT",
        message: `${facts.label} can only tighten the hard limit of ${shown(hard)}; ${shown(value)} would loosen it.`,
      }
    : {
        field: `stricterLimits.${f}`,
        code: "TIGHTER_THAN_ALLOWED",
        message: `${facts.label} cannot be ${facts.direction === "max" ? "below" : "above"} ${shown(facts.tightest)}.`,
      };
}

/** Turns the owner's goal into configuration, or names every field that is refused. */
export function translateGoal(
  input: unknown,
  limits: PolicyLimits = LAUNCH_LIMITS,
): GoalTranslation {
  const parsed = GoalInputSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        field: i.path.join(".") || "goal",
        code: "INVALID_FIELD",
        message:
          i.code === "unrecognized_keys" ? `Unknown field: ${i.keys.join(", ")}.` : i.message,
      })),
    };
  const goal = parsed.data;
  const errors: GoalError[] = [];

  if (!AVAILABLE_TEMPLATES.includes(goal.template))
    errors.push({
      field: "template",
      code: "TEMPLATE_NOT_AVAILABLE",
      message: `${TEMPLATE_FACTS[goal.template].label} is available later.`,
    });

  const hard = hardGoalLimits(limits);
  const ranges = ownerLimitRanges(limits);
  const owner = { ...hard };
  for (const f of OWNER_LIMIT_FIELDS) {
    const v = goal.stricterLimits[f];
    if (v === null) continue;
    if (v < ranges[f].min || v > ranges[f].max) errors.push(limitError(f, v, hard[f]));
    else owner[f] = v;
  }

  const intensity = RESEARCH_INTENSITY_FACTS[goal.research.intensity];
  const budget = BigInt(goal.research.dailyBudgetUsdcE6);
  if (budget < intensity.minDailyBudgetUsdcE6 || budget > intensity.maxDailyBudgetUsdcE6)
    errors.push({
      field: "research.dailyBudgetUsdcE6",
      code: "BUDGET_OUT_OF_RANGE",
      message: `At ${intensity.label} the daily research budget is ${usdc(intensity.minDailyBudgetUsdcE6)} to ${usdc(intensity.maxDailyBudgetUsdcE6)}.`,
    });
  const reserve = BigInt(goal.creditReserveUsdcE6);
  if (reserve > MAX_CREDIT_RESERVE_USDC_E6)
    errors.push({
      field: "creditReserveUsdcE6",
      code: "RESERVE_OUT_OF_RANGE",
      message: `The credit reserve is 0.00 to ${usdc(MAX_CREDIT_RESERVE_USDC_E6)}.`,
    });
  if (errors.length > 0) return { ok: false, errors };

  // The target may move inside the preset's range, narrowed by the owner's limits and the assets.
  const preset = RISK_PRESET_FACTS[goal.riskPreset];
  const maxBps = goal.allowedAssets.wmon
    ? Math.min(preset.targetMaxBps, owner.maxWmonShareBps, 10_000 - owner.minUsdcShareBps)
    : 0;
  const minBps = Math.min(preset.targetMinBps, maxBps);
  const params: RebalanceBandsParams = {
    targetWmonBps: Math.min(Math.max(preset.defaultTargetBps, minBps), maxBps),
    bandHalfWidthBps: preset.bandHalfWidthBps,
    minTradeUsdcE6: DEFAULT_MIN_TRADE_USDC_E6,
    ...PRESET_EXTRAS[goal.riskPreset],
    costHurdleBps: Math.min(PRESET_EXTRAS[goal.riskPreset].costHurdleBps, owner.maxSlippageBps),
    maxLegBps: owner.maxTradeBps,
  };
  const outside = checkTemplateParams(params);
  if (outside.length > 0) return { ok: false, errors: outside };
  // Defense in depth: the derived limits must never be looser than the hard ones.
  for (const f of OWNER_LIMIT_FIELDS) {
    const looser =
      OWNER_LIMIT_FACTS[f].direction === "max" ? owner[f] > hard[f] : owner[f] < hard[f];
    if (looser) throw new Error(`goal translator: ${f} came out looser than the hard limit`);
  }

  const body = {
    goal,
    template: { id: "rebalance_bands@1" as const, params },
    targetRange: { minBps, maxBps },
    researchTriggerBps: preset.researchTriggerBps,
    hardLimits: hard,
    ownerLimits: owner,
    research: {
      intensity: goal.research.intensity,
      scanEveryHours: intensity.scanEveryHours,
      divesPerDay: intensity.divesPerDay,
      dailyBudgetUsdcE6: budget,
      monthlyMaxUsdcE6: budget * BigInt(COST_PREVIEW_DAYS),
    },
    model: {
      choice: goal.reasoningModel,
      alias: REASONING_MODEL_FACTS[goal.reasoningModel].alias,
    },
    creditReserveUsdcE6: reserve,
    planChanges: {
      mode: goal.planChanges,
      workflowMode: PLAN_CHANGE_WORKFLOW_MODE[goal.planChanges],
    },
  };
  const policyHash = keccak256(toBytes(canonicalJson(body)));
  return {
    ok: true,
    config: { ...body, policyHash, soulBlock: soulBlock({ ...body, policyHash }) },
  };
}

/** Each parameter outside `rebalance_bands@1`'s bounds, with its field. */
export function checkTemplateParams(p: RebalanceBandsParams): GoalError[] {
  const out: GoalError[] = [];
  for (const [k, [min, max]] of Object.entries(REBALANCE_BANDS_V1_BOUNDS)) {
    const v = BigInt(p[k as keyof RebalanceBandsParams]);
    if (v < min || v > max)
      out.push({
        field: `template.params.${k}`,
        code: "OUT_OF_TEMPLATE_BOUNDS",
        message: `${k} is ${v}, outside ${min} to ${max}.`,
      });
  }
  return out;
}

/**
 * JSON with sorted keys and bigints as decimal strings, so the same value
 * always hashes the same. An integer-like key is refused: JavaScript orders
 * those numerically whatever the sort, so they would not be canonical
 * (BUILD_PLAN 8, lesson 3).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: a number must be finite");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [k] of entries)
      if (/^(0|[1-9]\d*)$/.test(k)) throw new Error(`canonicalJson: integer-like key "${k}"`);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: cannot encode a ${typeof value}`);
}

/** The goal block of SOUL.md, from a fixed template: every value comes from the translated config. */
function soulBlock(c: Omit<GoalConfig, "soulBlock">): string {
  const p = c.template.params;
  const o = c.ownerLimits;
  const assets = c.goal.allowedAssets.wmon ? "USDC and WMON" : "USDC only";
  const plan =
    c.planChanges.mode === "ASK_FIRST"
      ? "propose them; the owner approves each one first"
      : "propose them; accepted changes apply and the owner is told";
  return [
    "## Goal (set by the owner through the goal form; authoritative)",
    "",
    "This block is written by the platform's goal translator, never by a page, a message or a skill.",
    "Read the same values, with the live limits and mode, through platform.get_goals_and_limits@1.",
    "",
    `- Strategy template: ${c.template.id} (${TEMPLATE_FACTS[c.template.id].label})`,
    `- Risk preset: ${RISK_PRESET_FACTS[c.goal.riskPreset].label}`,
    `- Allowed assets: ${assets}`,
    `- Target WMON weight: ${bps(p.targetWmonBps)}, band ±${bps(p.bandHalfWidthBps)}; the plan may move it between ${bps(c.targetRange.minBps)} and ${bps(c.targetRange.maxBps)}`,
    `- Limits: largest trade ${bps(o.maxTradeBps)} of value, at most ${bps(o.maxWmonShareBps)} in WMON, at least ${bps(o.minUsdcShareBps)} in USDC, slippage at most ${bps(o.maxSlippageBps)}, at most ${o.maxTradesPer24h} trades in 24 hours`,
    `- Reasoning model: ${c.model.alias}`,
    `- Research: ${RESEARCH_INTENSITY_FACTS[c.research.intensity].label}, a Scan every ${c.research.scanEveryHours} hours, up to ${c.research.divesPerDay} Dive${c.research.divesPerDay === 1 ? "" : "s"} a day, at most ${usdc(c.research.dailyBudgetUsdcE6)} a day`,
    `- Credit reserve kept for gas: ${usdc(c.creditReserveUsdcE6)}`,
    `- Plan changes: ${plan}`,
    `- Policy hash: ${c.policyHash}`,
    "",
  ].join("\n");
}

/** What a month of research can cost at each intensity's default budget, for the goal form (D-299). */
export function costPreview(): readonly {
  readonly intensity: ResearchIntensity;
  readonly dailyBudgetUsdcE6: bigint;
  readonly monthlyMaxUsdcE6: bigint;
}[] {
  return RESEARCH_INTENSITIES.map((intensity) => {
    const daily = RESEARCH_INTENSITY_FACTS[intensity].defaultDailyBudgetUsdcE6;
    return {
      intensity,
      dailyBudgetUsdcE6: daily,
      monthlyMaxUsdcE6: daily * BigInt(COST_PREVIEW_DAYS),
    };
  });
}
