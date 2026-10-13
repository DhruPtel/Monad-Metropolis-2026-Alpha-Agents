import {
  AGGRESSIVENESS_ENVELOPES,
  ALLOCATION_DEFAULTS,
  ALLOCATION_STEP_BPS,
  type Aggressiveness,
  type GoalAllocation,
  type GoalInput,
  type ModelTier,
  OWNER_LIMIT_FACTS,
  OWNER_LIMIT_FIELDS,
  type OwnerLimitField,
  type PlanChangeMode,
  type ResearchIntensity,
  formatAmount,
} from "@alpha-agents/domain";
import { parseUsdc, percentToBps } from "@alpha-agents/ui";
import type { GoalErrorJson } from "@/api/client";

/**
 * The Goal page's form (P3-U1, F-U7): what the owner picks, and the goal it
 * sends. Limits are typed as percentages (or a number of trades) and amounts
 * as USDC; an empty limit keeps the hard limit. Only the shape is checked
 * here; every bound is the translator's, through the API's preview and save.
 */
export interface GoalForm {
  readonly aggressiveness: Aggressiveness;
  readonly modelTier: ModelTier;
  readonly screenedOptIn: boolean;
  /** Token addresses, lowercase. */
  readonly excludedTokens: readonly string[];
  readonly limits: Readonly<Record<OwnerLimitField, string>>;
  readonly intensity: ResearchIntensity;
  readonly budgetText: string;
  readonly reserveText: string;
  readonly planChanges: PlanChangeMode;
  /** 2026-10-13: the split by market cap, in 5% steps that add up to 100%. */
  readonly allocation: GoalAllocation;
  /** 2026-10-13: the most positions, at most the style's. */
  readonly maxPositions: number;
}

export type AllocationKey = keyof GoalAllocation;

/**
 * One share moved to `value` (in 5% steps); the other two take the rest in
 * their old proportion, so the three always add up to 100%.
 */
export function rebalanceAllocation(
  a: GoalAllocation,
  key: AllocationKey,
  value: number,
): GoalAllocation {
  const step = ALLOCATION_STEP_BPS;
  const v = Math.min(10_000, Math.max(0, Math.round(value / step) * step));
  const [k1, k2] = (["degenBps", "growthBps", "conservativeBps"] as const).filter(
    (k) => k !== key,
  ) as [AllocationKey, AllocationKey];
  const rest = 10_000 - v;
  const was = a[k1] + a[k2];
  const first =
    was === 0 ? Math.round(rest / 2 / step) * step : Math.round((a[k1] * rest) / was / step) * step;
  return { ...a, [key]: v, [k1]: first, [k2]: rest - first } as GoalAllocation;
}

/** What picking a style sets (2026-10-13): its split, its most positions, and the safety opt-in on for Aggressive. */
export function withStyle(f: GoalForm, style: Aggressiveness): GoalForm {
  return {
    ...f,
    aggressiveness: style,
    allocation: ALLOCATION_DEFAULTS[style],
    maxPositions: AGGRESSIVENESS_ENVELOPES[style].maxPositions,
    screenedOptIn: style === "AGGRESSIVE" ? true : f.screenedOptIn,
  };
}

/** A saved goal as the form reads it: a goal saved before the split had none, which means the style's. */
function filled(goal: GoalInput): GoalInput {
  return {
    ...goal,
    allocation: goal.allocation ?? ALLOCATION_DEFAULTS[goal.aggressiveness],
    maxPositions: goal.maxPositions ?? AGGRESSIVENESS_ENVELOPES[goal.aggressiveness].maxPositions,
  };
}

// Budgets and reserves stay under 1,000 USDC, so the text never carries a grouping comma.
const usdcText = (e6: string) =>
  formatAmount(BigInt(e6), 6, { minFractionDigits: 2, maxFractionDigits: 6 });

/** A limit's value as the owner types it: a percentage for basis points, a count for trades. */
function limitInput(field: OwnerLimitField, value: number | null): string {
  if (value === null) return "";
  return OWNER_LIMIT_FACTS[field].unit === "bps" ? (value / 100).toString() : value.toString();
}

export function formFromGoal(saved: GoalInput): GoalForm {
  const goal = filled(saved);
  const limits = {} as Record<OwnerLimitField, string>;
  for (const f of OWNER_LIMIT_FIELDS) limits[f] = limitInput(f, goal.stricterLimits[f]);
  return {
    aggressiveness: goal.aggressiveness,
    modelTier: goal.modelTier,
    screenedOptIn: goal.screenedOptIn,
    excludedTokens: goal.excludedTokens.map((t) => t.toLowerCase()),
    limits,
    intensity: goal.research.intensity,
    budgetText: usdcText(goal.research.dailyBudgetUsdcE6),
    reserveText: usdcText(goal.creditReserveUsdcE6),
    planChanges: goal.planChanges,
    allocation: goal.allocation ?? ALLOCATION_DEFAULTS[goal.aggressiveness],
    maxPositions: goal.maxPositions ?? AGGRESSIVENESS_ENVELOPES[goal.aggressiveness].maxPositions,
  };
}

/** A limit's typed text as its value; undefined when it is not a number in its unit. */
export function limitValue(field: OwnerLimitField, text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  if (OWNER_LIMIT_FACTS[field].unit === "trades")
    return /^\d{1,3}$/.test(t) ? Number(t) : undefined;
  return percentToBps(t) ?? undefined;
}

export type FieldErrors = Readonly<Record<string, string>>;

/** The goal the form describes, or each field that is not even a number. */
export function goalFromForm(
  f: GoalForm,
):
  | { readonly goal: GoalInput; readonly errors: null }
  | { readonly goal: null; readonly errors: FieldErrors } {
  const errors: Record<string, string> = {};
  const stricter = {} as Record<OwnerLimitField, number | null>;
  for (const field of OWNER_LIMIT_FIELDS) {
    const v = limitValue(field, f.limits[field]);
    if (v === undefined)
      errors[`stricterLimits.${field}`] =
        OWNER_LIMIT_FACTS[field].unit === "bps"
          ? "Enter a percentage with at most 2 decimals, or leave it empty."
          : "Enter a whole number of trades, or leave it empty.";
    else stricter[field] = v;
  }
  const budget = parseUsdc(f.budgetText);
  if (budget === null)
    errors["research.dailyBudgetUsdcE6"] = "Enter an amount of USDC with at most 6 decimals.";
  const reserve = parseUsdc(f.reserveText);
  if (reserve === null)
    errors.creditReserveUsdcE6 = "Enter an amount of USDC with at most 6 decimals.";
  if (Object.keys(errors).length > 0 || budget === null || reserve === null)
    return { goal: null, errors };
  return {
    goal: {
      aggressiveness: f.aggressiveness,
      modelTier: f.modelTier,
      screenedOptIn: f.screenedOptIn,
      excludedTokens: [...new Set(f.excludedTokens.map((t) => t.toLowerCase()))],
      stricterLimits: stricter,
      research: { intensity: f.intensity, dailyBudgetUsdcE6: budget.toString() },
      creditReserveUsdcE6: reserve.toString(),
      planChanges: f.planChanges,
      allocation: f.allocation,
      maxPositions: f.maxPositions,
    },
    errors: null,
  };
}

/** The API's refusals by field, for the fields that show them. */
export function errorsByField(errors: readonly GoalErrorJson[]): FieldErrors {
  const out: Record<string, string> = {};
  for (const e of errors) out[e.field] ??= e.message;
  return out;
}

/** JSON with sorted keys: the API stores the goal as jsonb, which keeps its own key order. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/** Whether the form differs from the saved goal. */
export function goalChanged(form: GoalForm, saved: GoalInput | null): boolean {
  if (!saved) return true;
  const parsed = goalFromForm(form);
  return (
    parsed.goal === null ||
    stable(parsed.goal) !==
      stable({
        ...filled(saved),
        excludedTokens: saved.excludedTokens.map((t) => t.toLowerCase()),
      })
  );
}
