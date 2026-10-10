import { z } from "zod";

/**
 * The owner's goal (P3-U1, F-U7; D-010, D-345, FINAL_PLAN 0.6, 4.3.6):
 * structured fields only, no free text. Every object is strict, so an
 * unknown field is refused. The bounds that depend on the hard limits (each
 * stricter limit only at or inside its hard limit) are checked by
 * packages/policy's goal translator, which is the only way a goal becomes
 * configuration.
 *
 * F-U7 replaces the strategy template, the risk preset and the WMON fields
 * with one choice, aggressiveness, which produces a brief the agent interprets
 * and the envelope the deterministic Test enforces (A-60); the model tier
 * (Low, Medium, High, D-353), the screened-lane opt-in and a list of excluded
 * tokens are new fields. The research intensity, the daily budget, the credit
 * reserve, the plan-change setting and the stricter limits stay.
 */

/** The templates a plan may run on (F-U6, D-344): the two-asset bands, or a target portfolio over any registered tokens. */
export const PLAN_TEMPLATES = ["rebalance_bands@1", "target_portfolio@1"] as const;
export type PlanTemplate = (typeof PLAN_TEMPLATES)[number];

/**
 * Aggressiveness (D-345, A-60): the owner's one choice. Each level has the
 * brief the agent reads (a fixed text, never the owner's words), the envelope
 * the deterministic Test enforces on a target portfolio, and the move in a
 * held token that triggers a position review.
 */
export const AGGRESSIVENESS_LEVELS = ["CONSERVATIVE", "BALANCED", "AGGRESSIVE"] as const;
export type Aggressiveness = (typeof AGGRESSIVENESS_LEVELS)[number];

export interface AggressivenessEnvelope {
  readonly label: string;
  /** Whether class A (attested) tokens may be held at all. */
  readonly classAAllowed: boolean;
  /** The most one position may weigh, basis points of the account's value (the registry's own cap also applies). */
  readonly maxPositionBps: number;
  readonly maxClassAPositionBps: number;
  readonly maxClassATotalBps: number;
  /** The least the plan keeps in stablecoins: USDC cash and stablecoin positions together. */
  readonly minStableBps: number;
  readonly maxPositions: number;
  /** A held token moving this much triggers a position review (the watcher, P3-U10). */
  readonly reviewTriggerBps: number;
}

export const AGGRESSIVENESS_ENVELOPES: Readonly<Record<Aggressiveness, AggressivenessEnvelope>> =
  Object.freeze({
    CONSERVATIVE: {
      label: "Conservative",
      classAAllowed: false,
      maxPositionBps: 2_000,
      maxClassAPositionBps: 0,
      maxClassATotalBps: 0,
      minStableBps: 3_000,
      maxPositions: 8,
      reviewTriggerBps: 1_000,
    },
    BALANCED: {
      label: "Balanced",
      classAAllowed: true,
      maxPositionBps: 4_500,
      maxClassAPositionBps: 800,
      maxClassATotalBps: 2_500,
      minStableBps: 1_500,
      maxPositions: 8,
      reviewTriggerBps: 1_500,
    },
    AGGRESSIVE: {
      label: "Aggressive",
      classAAllowed: true,
      maxPositionBps: 4_500,
      maxClassAPositionBps: 1_500,
      maxClassATotalBps: 5_000,
      minStableBps: 1_000,
      maxPositions: 12,
      reviewTriggerBps: 2_500,
    },
  });

export interface AggressivenessFacts {
  readonly label: string;
  /** One line for the form and the card. */
  readonly summary: string;
  /** The brief the agent reads, a fixed text per level (D-345). */
  readonly brief: string;
}

export const AGGRESSIVENESS_FACTS: Readonly<Record<Aggressiveness, AggressivenessFacts>> =
  Object.freeze({
    CONSERVATIVE: {
      label: "Conservative",
      summary: "The largest liquid assets and yield, few positions, long horizons.",
      brief:
        "Lean to the largest liquid assets on Monad (MON, the majors and stablecoins) and to yield-bearing tokens such as MON's liquid staking tokens. Hold few positions and think in long horizons. Hold class F tokens only: every position has a price feed. Keep at least 30% of the account in stablecoins and no more than 20% in any one position.",
    },
    BALANCED: {
      label: "Balanced",
      summary: "Large caps plus a few researched mid caps with a clear thesis.",
      brief:
        "Hold large caps, plus a few researched mid caps that each have a clear thesis and an exit plan. Attested (class A) tokens may take a small part, at most 8% each and 25% together, once a price attestor is live. Keep at least 15% of the account in stablecoins and no more than 45% in any one position.",
    },
    AGGRESSIVE: {
      label: "Aggressive",
      summary: "Anything that passes the safety check, with exit plans; larger swings.",
      brief:
        "Consider anything that passes the safety check, newer and high-beta tokens and memecoins included, with smaller positions and a required exit plan for each. Attested (class A) tokens may take up to 15% each and 50% together, once a price attestor is live. Keep at least 10% of the account in stablecoins and no more than 45% in any one position. Expect larger swings.",
    },
  });

/** Symbols the envelope's stablecoin minimum counts, beside USDC cash (A-74). */
export const STABLE_SYMBOLS = ["USDC", "USDT0", "USDT", "AUSD", "DAI", "USDE", "FDUSD"] as const;
export const isStableSymbol = (symbol: string): boolean =>
  (STABLE_SYMBOLS as readonly string[]).includes(symbol.toUpperCase());

/** The owner's model tier (D-334, D-353): mapped to models through LiteLLM aliases, never a vendor name in the goal. */
export const MODEL_TIERS = ["LOW", "MEDIUM", "HIGH"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const MODEL_TIER_FACTS: Readonly<
  Record<
    ModelTier,
    {
      readonly label: string;
      readonly alias: string;
      readonly model: string;
      readonly note: string;
    }
  >
> = Object.freeze({
  LOW: {
    label: "Low",
    alias: "research-low",
    model: "Claude Haiku 4.5",
    note: "Fast and cheap; fine for a light cadence.",
  },
  MEDIUM: {
    label: "Medium",
    alias: "research-medium",
    model: "Claude Sonnet 5.5",
    note: "Careful and economical; the default.",
  },
  HIGH: {
    label: "High",
    alias: "research-high",
    model: "Claude Opus 5.5",
    note: "Deeper reasoning; each research stage can cost about twice as much.",
  },
});

/** The Scan's alias for every agent (D-334): the Low tier. */
export const SCAN_ALIAS = MODEL_TIER_FACTS.LOW.alias;

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
 * `lower` limits must be at or below it, `upper` ones at or above it. F-U7
 * generalizes the WMON share to any one token.
 */
export const OWNER_LIMIT_FIELDS = [
  "maxTradeBps",
  "maxPositionBps",
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
  maxPositionBps: {
    label: "Most in one token",
    explanation: "The largest share of the account the agent may hold in any one token.",
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
const tokenAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "a token's address");

/** The most tokens an owner may exclude. */
export const MAX_EXCLUDED_TOKENS = 32;

/** The goal as the owner sends it. Strict at every level: unknown fields are refused. */
export const GoalInputSchema = z.strictObject({
  aggressiveness: z.enum(AGGRESSIVENESS_LEVELS),
  /** The owner's model tier for the Dive, the Challenge and the Zoom out (D-353). */
  modelTier: z.enum(MODEL_TIERS),
  /** Whether the agent may hold screened-lane tokens (D-351); the onchain opt-in is the owner's own transaction. */
  screenedOptIn: z.boolean(),
  /** Tokens the agent never buys, by address; held ones are sold down like any dropped position. */
  excludedTokens: z.array(tokenAddress).max(MAX_EXCLUDED_TOKENS),
  /** Each null keeps the hard limit. */
  stricterLimits: z.strictObject({
    maxTradeBps: limit,
    maxPositionBps: limit,
    minUsdcShareBps: limit,
    maxSlippageBps: limit,
    maxTradesPer24h: limit,
  }),
  research: z.strictObject({
    intensity: z.enum(RESEARCH_INTENSITIES),
    dailyBudgetUsdcE6: usdcE6,
  }),
  creditReserveUsdcE6: usdcE6,
  planChanges: z.enum(PLAN_CHANGE_MODES),
});
export type GoalInput = z.infer<typeof GoalInputSchema>;

/** A new goal's defaults (D-320 as amended by D-345): Balanced, Medium, core lane only, Light. */
export const DEFAULT_GOAL_INPUT: GoalInput = Object.freeze({
  aggressiveness: "BALANCED",
  modelTier: "MEDIUM",
  screenedOptIn: false,
  excludedTokens: [],
  stricterLimits: {
    maxTradeBps: null,
    maxPositionBps: null,
    minUsdcShareBps: null,
    maxSlippageBps: null,
    maxTradesPer24h: null,
  },
  research: {
    intensity: DEFAULT_RESEARCH_INTENSITY,
    dailyBudgetUsdcE6:
      RESEARCH_INTENSITY_FACTS[DEFAULT_RESEARCH_INTENSITY].defaultDailyBudgetUsdcE6.toString(),
  },
  creditReserveUsdcE6: DEFAULT_CREDIT_RESERVE_USDC_E6.toString(),
  planChanges: "ASK_FIRST",
}) as GoalInput;

/**
 * A goal saved before F-U7 (template, risk preset, allowed assets, reasoning
 * model): read from the database once and carried over (D-345: saved goals
 * migrate to Conservative). The WMON share limit becomes the one-token limit;
 * Standard reasoning becomes Medium, Deep becomes High.
 */
export const LEGACY_GOAL_KEYS = [
  "template",
  "riskPreset",
  "allowedAssets",
  "reasoningModel",
] as const;

export const isLegacyGoalInput = (goal: unknown): boolean =>
  typeof goal === "object" && goal !== null && "template" in goal && !("aggressiveness" in goal);

export function migrateLegacyGoalInput(legacy: Record<string, unknown>): GoalInput {
  const limits = (legacy.stricterLimits ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
  const research = (legacy.research ?? {}) as Record<string, unknown>;
  const intensity = RESEARCH_INTENSITIES.find((i) => i === research.intensity) ?? "LIGHT";
  const planChanges = PLAN_CHANGE_MODES.find((m) => m === legacy.planChanges) ?? "ASK_FIRST";
  return {
    aggressiveness: "CONSERVATIVE",
    modelTier: legacy.reasoningModel === "DEEP" ? "HIGH" : "MEDIUM",
    screenedOptIn: false,
    excludedTokens: [],
    stricterLimits: {
      maxTradeBps: num(limits.maxTradeBps),
      maxPositionBps: num(limits.maxWmonShareBps),
      minUsdcShareBps: num(limits.minUsdcShareBps),
      maxSlippageBps: num(limits.maxSlippageBps),
      maxTradesPer24h: num(limits.maxTradesPer24h),
    },
    research: {
      intensity,
      dailyBudgetUsdcE6:
        typeof research.dailyBudgetUsdcE6 === "string" &&
        /^(0|[1-9]\d{0,14})$/.test(research.dailyBudgetUsdcE6)
          ? research.dailyBudgetUsdcE6
          : RESEARCH_INTENSITY_FACTS[intensity].defaultDailyBudgetUsdcE6.toString(),
    },
    creditReserveUsdcE6:
      typeof legacy.creditReserveUsdcE6 === "string" &&
      /^(0|[1-9]\d{0,14})$/.test(legacy.creditReserveUsdcE6)
        ? legacy.creditReserveUsdcE6
        : DEFAULT_CREDIT_RESERVE_USDC_E6.toString(),
    planChanges,
  };
}
