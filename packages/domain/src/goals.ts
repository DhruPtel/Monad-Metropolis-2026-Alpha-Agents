import { z } from "zod";

/**
 * The owner's goal (P3-U1, D-010, FINAL_PLAN 4.3.6): structured fields only,
 * no free text. Every object is strict, so an unknown field is refused. The
 * bounds that depend on the hard limits (each stricter limit only at or inside
 * its hard limit) are checked by packages/policy's goal translator, which is
 * the only way a goal becomes configuration.
 */

/** Strategy templates. `dca@1` is listed and shown as "available later" until W-2. */
export const STRATEGY_TEMPLATES = ["rebalance_bands@1", "dca@1"] as const;
export type StrategyTemplate = (typeof STRATEGY_TEMPLATES)[number];
export const AVAILABLE_TEMPLATES: readonly StrategyTemplate[] = ["rebalance_bands@1"];

export const TEMPLATE_FACTS: Readonly<
  Record<StrategyTemplate, { readonly label: string; readonly explanation: string }>
> = Object.freeze({
  "rebalance_bands@1": {
    label: "Band rebalancer",
    explanation:
      "Keeps a target share of the account in WMON and trades back toward it when the share drifts outside a band.",
  },
  "dca@1": {
    label: "Steady buying",
    explanation: "Buys WMON with USDC on a schedule. Available later.",
  },
});

export const RISK_PRESETS = ["CONSERVATIVE", "BALANCED", "GROWTH"] as const;
export type RiskPreset = (typeof RISK_PRESETS)[number];

export interface RiskPresetFacts {
  readonly label: string;
  /** The range the agent may move the target WMON weight in, in basis points of the account's value. */
  readonly targetMinBps: number;
  readonly targetMaxBps: number;
  readonly defaultTargetBps: number;
  /** Half the band around the target, in percentage points as basis points (500 = ±5 points). */
  readonly bandHalfWidthBps: number;
  /** A MON price move since the last Zoom out that triggers research (D-283), in basis points. */
  readonly researchTriggerBps: number;
}

/** D-278. The hard limits (the 40% cap, the 10% USDC floor) stay the Executor's. */
export const RISK_PRESET_FACTS: Readonly<Record<RiskPreset, RiskPresetFacts>> = Object.freeze({
  CONSERVATIVE: {
    label: "Conservative",
    targetMinBps: 0,
    targetMaxBps: 2_000,
    defaultTargetBps: 1_000,
    bandHalfWidthBps: 300,
    researchTriggerBps: 500,
  },
  BALANCED: {
    label: "Balanced",
    targetMinBps: 0,
    targetMaxBps: 3_000,
    defaultTargetBps: 2_000,
    bandHalfWidthBps: 500,
    researchTriggerBps: 700,
  },
  GROWTH: {
    label: "Growth",
    targetMinBps: 0,
    targetMaxBps: 4_000,
    defaultTargetBps: 3_000,
    bandHalfWidthBps: 500,
    researchTriggerBps: 1_000,
  },
});

/** The owner's reasoning model for the Dive, Challenge and Zoom out (D-037, D-285). */
export const REASONING_MODELS = ["STANDARD", "DEEP"] as const;
export type ReasoningModel = (typeof REASONING_MODELS)[number];

export const REASONING_MODEL_FACTS: Readonly<
  Record<ReasoningModel, { readonly label: string; readonly alias: string; readonly model: string }>
> = Object.freeze({
  STANDARD: { label: "Standard", alias: "research-strong", model: "Claude Sonnet 5.5" },
  DEEP: { label: "Deep", alias: "research-deep", model: "Claude Opus 5.5" },
});

export const RESEARCH_INTENSITIES = ["LIGHT", "STANDARD", "DEEP"] as const;
export type ResearchIntensity = (typeof RESEARCH_INTENSITIES)[number];

export interface ResearchIntensityFacts {
  readonly label: string;
  readonly scanEveryHours: number;
  readonly divesPerDay: number;
  /** USDC base units (6 decimals). */
  readonly defaultDailyBudgetUsdcE6: bigint;
  readonly minDailyBudgetUsdcE6: bigint;
  readonly maxDailyBudgetUsdcE6: bigint;
}

/** D-293, D-299: new goals default to Light. */
export const DEFAULT_RESEARCH_INTENSITY: ResearchIntensity = "LIGHT";

export const RESEARCH_INTENSITY_FACTS: Readonly<Record<ResearchIntensity, ResearchIntensityFacts>> =
  Object.freeze({
    LIGHT: {
      label: "Light",
      scanEveryHours: 12,
      divesPerDay: 1,
      defaultDailyBudgetUsdcE6: 1_000_000n,
      minDailyBudgetUsdcE6: 500_000n,
      maxDailyBudgetUsdcE6: 2_000_000n,
    },
    STANDARD: {
      label: "Standard",
      scanEveryHours: 6,
      divesPerDay: 2,
      defaultDailyBudgetUsdcE6: 2_500_000n,
      minDailyBudgetUsdcE6: 1_000_000n,
      maxDailyBudgetUsdcE6: 5_000_000n,
    },
    DEEP: {
      label: "Deep",
      scanEveryHours: 3,
      divesPerDay: 4,
      defaultDailyBudgetUsdcE6: 6_000_000n,
      minDailyBudgetUsdcE6: 3_000_000n,
      maxDailyBudgetUsdcE6: 12_000_000n,
    },
  });

/** A month for the cost preview (D-299): 30 days at the daily budget, which is a hard cap. */
export const COST_PREVIEW_DAYS = 30;

/** The credit reserve kept unspent for gas (D-293): 1.00 USDC by default, 0 to 20 USDC (A-52). */
export const DEFAULT_CREDIT_RESERVE_USDC_E6 = 1_000_000n;
export const MAX_CREDIT_RESERVE_USDC_E6 = 20_000_000n;

/** The goal's plan-change setting (D-294): D-020's `require_approval` or `notify`. */
export const PLAN_CHANGE_MODES = ["ASK_FIRST", "APPLY_AND_TELL"] as const;
export type PlanChangeMode = (typeof PLAN_CHANGE_MODES)[number];
export const PLAN_CHANGE_WORKFLOW_MODE: Readonly<
  Record<PlanChangeMode, "require_approval" | "notify">
> = Object.freeze({ ASK_FIRST: "require_approval", APPLY_AND_TELL: "notify" });

/**
 * The stricter limits an owner may set. Each only tightens its hard limit:
 * `lower` limits must be at or below it, `upper` ones at or above it.
 */
export const OWNER_LIMIT_FIELDS = [
  "maxTradeBps",
  "maxWmonShareBps",
  "minUsdcShareBps",
  "maxSlippageBps",
  "maxTradesPer24h",
] as const;
export type OwnerLimitField = (typeof OWNER_LIMIT_FIELDS)[number];

export interface OwnerLimitFacts {
  readonly label: string;
  readonly explanation: string;
  /** "max": tighter is lower; "min": tighter is higher. */
  readonly direction: "max" | "min";
  /** The tightest value accepted, so a limit cannot stop the account working at all. */
  readonly tightest: number;
  readonly unit: "bps" | "trades";
}

export const OWNER_LIMIT_FACTS: Readonly<Record<OwnerLimitField, OwnerLimitFacts>> = Object.freeze({
  maxTradeBps: {
    label: "Largest trade",
    explanation: "The most one trade may move, as a share of the account's value.",
    direction: "max",
    tightest: 10,
    unit: "bps",
  },
  maxWmonShareBps: {
    label: "Most in WMON",
    explanation: "The largest share of the account the agent may hold in WMON.",
    direction: "max",
    tightest: 0,
    unit: "bps",
  },
  minUsdcShareBps: {
    label: "Least in USDC",
    explanation: "The smallest share of the account the agent must keep in USDC.",
    direction: "min",
    tightest: 10_000,
    unit: "bps",
  },
  maxSlippageBps: {
    label: "Most slippage",
    explanation: "How far below the oracle price a trade may fill.",
    direction: "max",
    tightest: 10,
    unit: "bps",
  },
  maxTradesPer24h: {
    label: "Most trades a day",
    explanation: "How many trades the agent may make in any 24 hours.",
    direction: "max",
    tightest: 1,
    unit: "trades",
  },
});

const usdcE6 = z
  .string()
  .regex(/^(0|[1-9]\d{0,14})$/, "an amount in USDC base units, as a whole number");
const limit = z.number().int().nonnegative().nullable();

/** The goal as the owner sends it. Strict at every level: unknown fields are refused. */
export const GoalInputSchema = z.strictObject({
  template: z.enum(STRATEGY_TEMPLATES),
  riskPreset: z.enum(RISK_PRESETS),
  /** USDC is always allowed; WMON on or off. */
  allowedAssets: z.strictObject({ wmon: z.boolean() }),
  /** Each null keeps the hard limit. */
  stricterLimits: z.strictObject({
    maxTradeBps: limit,
    maxWmonShareBps: limit,
    minUsdcShareBps: limit,
    maxSlippageBps: limit,
    maxTradesPer24h: limit,
  }),
  reasoningModel: z.enum(REASONING_MODELS),
  research: z.strictObject({
    intensity: z.enum(RESEARCH_INTENSITIES),
    dailyBudgetUsdcE6: usdcE6,
  }),
  creditReserveUsdcE6: usdcE6,
  planChanges: z.enum(PLAN_CHANGE_MODES),
});
export type GoalInput = z.infer<typeof GoalInputSchema>;

/** The goal a new agent's form starts from: Balanced, WMON on, no stricter limits, Light (D-299). */
export const DEFAULT_GOAL_INPUT: GoalInput = Object.freeze({
  template: "rebalance_bands@1",
  riskPreset: "BALANCED",
  allowedAssets: { wmon: true },
  stricterLimits: {
    maxTradeBps: null,
    maxWmonShareBps: null,
    minUsdcShareBps: null,
    maxSlippageBps: null,
    maxTradesPer24h: null,
  },
  reasoningModel: "STANDARD",
  research: {
    intensity: DEFAULT_RESEARCH_INTENSITY,
    dailyBudgetUsdcE6:
      RESEARCH_INTENSITY_FACTS[DEFAULT_RESEARCH_INTENSITY].defaultDailyBudgetUsdcE6.toString(),
  },
  creditReserveUsdcE6: DEFAULT_CREDIT_RESERVE_USDC_E6.toString(),
  planChanges: "ASK_FIRST",
}) as GoalInput;
