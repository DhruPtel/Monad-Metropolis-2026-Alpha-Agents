import {
  type GoalInput,
  OWNER_LIMIT_FACTS,
  OWNER_LIMIT_FIELDS,
  type OwnerLimitField,
  type PlanChangeMode,
  type ReasoningModel,
  type ResearchIntensity,
  type RiskPreset,
  type StrategyTemplate,
  formatAmount,
} from "@alpha-agents/domain";
import { parseUsdc, percentToBps } from "@alpha-agents/ui";
import type { GoalErrorJson } from "@/api/client";

/**
 * The Goal page's form (P3-U1): what the owner types, and the goal it sends.
 * Limits are typed as percentages (or a number of trades) and amounts as
 * USDC; an empty limit keeps the hard limit. Only the shape is checked here;
 * every bound is the translator's, through the API's preview and save.
 */
export interface GoalForm {
  readonly template: StrategyTemplate;
  readonly riskPreset: RiskPreset;
  readonly wmon: boolean;
  readonly limits: Readonly<Record<OwnerLimitField, string>>;
  readonly reasoningModel: ReasoningModel;
  readonly intensity: ResearchIntensity;
  readonly budgetText: string;
  readonly reserveText: string;
  readonly planChanges: PlanChangeMode;
}

// Budgets and reserves stay under 1,000 USDC, so the text never carries a grouping comma.
const usdcText = (e6: string) =>
  formatAmount(BigInt(e6), 6, { minFractionDigits: 2, maxFractionDigits: 6 });

/** A limit's value as the owner types it: a percentage for basis points, a count for trades. */
function limitInput(field: OwnerLimitField, value: number | null): string {
  if (value === null) return "";
  return OWNER_LIMIT_FACTS[field].unit === "bps" ? (value / 100).toString() : value.toString();
}

export function formFromGoal(goal: GoalInput): GoalForm {
  const limits = {} as Record<OwnerLimitField, string>;
  for (const f of OWNER_LIMIT_FIELDS) limits[f] = limitInput(f, goal.stricterLimits[f]);
  return {
    template: goal.template,
    riskPreset: goal.riskPreset,
    wmon: goal.allowedAssets.wmon,
    limits,
    reasoningModel: goal.reasoningModel,
    intensity: goal.research.intensity,
    budgetText: usdcText(goal.research.dailyBudgetUsdcE6),
    reserveText: usdcText(goal.creditReserveUsdcE6),
    planChanges: goal.planChanges,
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
      template: f.template,
      riskPreset: f.riskPreset,
      allowedAssets: { wmon: f.wmon },
      stricterLimits: stricter,
      reasoningModel: f.reasoningModel,
      research: { intensity: f.intensity, dailyBudgetUsdcE6: budget.toString() },
      creditReserveUsdcE6: reserve.toString(),
      planChanges: f.planChanges,
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
  return parsed.goal === null || stable(parsed.goal) !== stable(saved);
}
