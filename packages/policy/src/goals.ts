import {
  AGGRESSIVENESS_ENVELOPES,
  AGGRESSIVENESS_FACTS,
  type Aggressiveness,
  type AggressivenessEnvelope,
  COST_PREVIEW_DAYS,
  type GoalInput,
  GoalInputSchema,
  MAX_CREDIT_RESERVE_USDC_E6,
  MODEL_TIER_FACTS,
  type ModelTier,
  OWNER_LIMIT_FACTS,
  OWNER_LIMIT_FIELDS,
  type OwnerLimitField,
  PLAN_CHANGE_WORKFLOW_MODE,
  type PlanChangeMode,
  RESEARCH_INTENSITIES,
  RESEARCH_INTENSITY_FACTS,
  type ResearchIntensity,
} from "@alpha-agents/domain";
import { keccak256, toBytes } from "viem";
import { LAUNCH_LIMITS, type PolicyLimits } from "./limits.ts";

/**
 * The goal translator (P3-U1, F-U7; FINAL_PLAN 0.6, 4.3.6, D-098, D-345): a
 * pure, deterministic function from the owner's structured goal to the
 * configuration every later stage reads: the brief the agent interprets (a
 * fixed text per aggressiveness, never the owner's words), the envelope the
 * deterministic Test enforces, the effective limits, the two-asset fallback's
 * parameters, the policy hash and the goal block of SOUL.md. It refuses
 * anything that would loosen a hard limit, so the owner's stricter limits can
 * only tighten the Executor's.
 */

/** `rebalance_bands@1`'s parameters: the two-asset case and fallback (D-344). P3-U3's runner reads them. */
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
 * The two-asset fallback per aggressiveness (A-75): the range the target may
 * move in, where it starts and the band, carried from D-278's presets; the
 * buy brake and the cost limit per level were measured in P3-U3 (A-58).
 */
export interface BandsDefaults {
  readonly targetMinBps: number;
  readonly targetMaxBps: number;
  readonly defaultTargetBps: number;
  readonly bandHalfWidthBps: number;
  readonly volatilityBrakeBps: number;
  readonly costHurdleBps: number;
}

export const BANDS_DEFAULTS: Readonly<Record<Aggressiveness, BandsDefaults>> = Object.freeze({
  CONSERVATIVE: {
    targetMinBps: 0,
    targetMaxBps: 2_000,
    defaultTargetBps: 1_000,
    bandHalfWidthBps: 300,
    volatilityBrakeBps: 15_000,
    costHurdleBps: 30,
  },
  BALANCED: {
    targetMinBps: 0,
    targetMaxBps: 3_000,
    defaultTargetBps: 2_000,
    bandHalfWidthBps: 500,
    volatilityBrakeBps: 20_000,
    costHurdleBps: 40,
  },
  AGGRESSIVE: {
    targetMinBps: 0,
    targetMaxBps: 4_000,
    defaultTargetBps: 3_000,
    bandHalfWidthBps: 500,
    volatilityBrakeBps: 25_000,
    costHurdleBps: 50,
  },
});
const DEFAULT_MIN_TRADE_USDC_E6 = 500_000n;

/** The limits the account trades under: the hard limit, or the owner's stricter value. */
export interface EffectiveLimits {
  readonly maxTradeBps: number;
  /** The most in any one token (F-U7; the WMON share before it). */
  readonly maxPositionBps: number;
  readonly minUsdcShareBps: number;
  readonly maxSlippageBps: number;
  readonly maxTradesPer24h: number;
}

export interface GoalConfig {
  /** The goal exactly as validated. */
  readonly goal: GoalInput;
  readonly aggressiveness: Aggressiveness;
  /** The envelope the deterministic Test enforces on a target portfolio (A-60). */
  readonly envelope: AggressivenessEnvelope;
  /** The brief the agent reads: a fixed text per level, with the owner's exclusions and opt-in. */
  readonly brief: string;
  /** The two-asset fallback's parameters (`rebalance_bands@1`, D-344), inside the owner's limits. */
  readonly template: { readonly id: "rebalance_bands@1"; readonly params: RebalanceBandsParams };
  /** The range the two-asset plan may move its target in: the level's, narrowed by the owner's limits. */
  readonly targetRange: { readonly minBps: number; readonly maxBps: number };
  /** A move in a held token that triggers a position review (A-60). */
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
  readonly model: { readonly choice: ModelTier; readonly alias: string };
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
    maxPositionBps: limits.maxAssetBps,
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
  // Excluded tokens are kept lowercase and once each, so the goal hashes the same however typed.
  const excluded = [...new Set(parsed.data.excludedTokens.map((t) => t.toLowerCase()))];
  const goal: GoalInput = { ...parsed.data, excludedTokens: excluded };
  const errors: GoalError[] = [];

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

  // The two-asset fallback: the target may move inside the level's range, narrowed by the owner's limits.
  const level = BANDS_DEFAULTS[goal.aggressiveness];
  const envelope = AGGRESSIVENESS_ENVELOPES[goal.aggressiveness];
  const maxBps = Math.min(level.targetMaxBps, owner.maxPositionBps, 10_000 - owner.minUsdcShareBps);
  const minBps = Math.min(level.targetMinBps, maxBps);
  const params: RebalanceBandsParams = {
    targetWmonBps: Math.min(Math.max(level.defaultTargetBps, minBps), maxBps),
    bandHalfWidthBps: level.bandHalfWidthBps,
    minTradeUsdcE6: DEFAULT_MIN_TRADE_USDC_E6,
    volatilityBrakeBps: level.volatilityBrakeBps,
    costHurdleBps: Math.min(level.costHurdleBps, owner.maxSlippageBps),
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
    aggressiveness: goal.aggressiveness,
    envelope,
    brief: briefOf(goal),
    template: { id: "rebalance_bands@1" as const, params },
    targetRange: { minBps, maxBps },
    researchTriggerBps: envelope.reviewTriggerBps,
    hardLimits: hard,
    ownerLimits: owner,
    research: {
      intensity: goal.research.intensity,
      scanEveryHours: intensity.scanEveryHours,
      divesPerDay: intensity.divesPerDay,
      dailyBudgetUsdcE6: budget,
      monthlyMaxUsdcE6: budget * BigInt(COST_PREVIEW_DAYS),
    },
    model: { choice: goal.modelTier, alias: MODEL_TIER_FACTS[goal.modelTier].alias },
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

/**
 * The brief the agent interprets (D-333, D-345): the level's fixed text, then
 * the owner's screened-lane choice and exclusions. Never the owner's words.
 */
export function briefOf(goal: GoalInput): string {
  const lane = goal.screenedOptIn
    ? "The owner opted into the screened lane: tokens that passed the platform's safety screen may be held under the class A caps, beside the core lane."
    : "Hold core-lane tokens only; the owner has not opted into the screened lane.";
  const excluded =
    goal.excludedTokens.length === 0
      ? "No token is excluded."
      : `Never buy these tokens, whatever the research says: ${goal.excludedTokens.join(", ")}.`;
  return `${AGGRESSIVENESS_FACTS[goal.aggressiveness].brief} ${lane} ${excluded}`;
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
  const o = c.ownerLimits;
  const e = c.envelope;
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
    `- Aggressiveness: ${AGGRESSIVENESS_FACTS[c.aggressiveness].label}`,
    `- Brief: ${c.brief}`,
    `- Envelope the Test enforces on a target portfolio: at most ${e.maxPositions} positions, at most ${bps(e.maxPositionBps)} in any one, at least ${bps(e.minStableBps)} in stablecoins${e.classAAllowed ? `, class A at most ${bps(e.maxClassAPositionBps)} each and ${bps(e.maxClassATotalBps)} together` : ", class F tokens only"}`,
    `- Limits: largest trade ${bps(o.maxTradeBps)} of value, at most ${bps(o.maxPositionBps)} in any one token, at least ${bps(o.minUsdcShareBps)} in USDC, slippage at most ${bps(o.maxSlippageBps)}, at most ${o.maxTradesPer24h} trades in 24 hours`,
    `- Two-asset fallback: ${c.template.id}, target WMON ${bps(c.template.params.targetWmonBps)} within ${bps(c.targetRange.minBps)} to ${bps(c.targetRange.maxBps)}`,
    `- Model tier: ${MODEL_TIER_FACTS[c.model.choice].label} (${c.model.alias})`,
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
