import {
  type AgentState,
  OWNER_LIMIT_FACTS,
  type OwnerLimitField,
  RESEARCH_INTENSITY_FACTS,
  type ResearchIntensity,
  RISK_PRESET_FACTS,
  type RiskPreset,
  type StrategyTemplate,
  TEMPLATE_FACTS,
  formatAmount,
} from "@alpha-agents/domain";
import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { StatusPill } from "../status-pill";
import { Field, Input } from "../ui/input";
import { SectionLabel } from "../ui/section-label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

/**
 * The goal's design system pieces (P3-U1): the stricter-limit field with its
 * hard limit, the limits that apply once the owner's are in, the cost preview
 * with what a month costs at each intensity (D-299), the goal summary for the
 * card and the portfolio, and the save result. Values come in as plain numbers
 * (basis points, trades, USDC base units); the page does the reading.
 */

const usdc = (e6: bigint) => formatAmount(e6, 6, { minFractionDigits: 2, maxFractionDigits: 2 });

/** Basis points as a percentage: 1000 is "10%", 250 is "2.5%". */
export function bpsText(bps: number): string {
  const whole = bps / 100;
  return `${Number.isInteger(whole) ? whole.toString() : whole.toFixed(2).replace(/0$/, "")}%`;
}

/** A limit's value in its unit: a percentage, or a number of trades. */
export function limitText(field: OwnerLimitField, value: number): string {
  return OWNER_LIMIT_FACTS[field].unit === "bps"
    ? bpsText(value)
    : `${value} trade${value === 1 ? "" : "s"}`;
}

/** Parses a percentage with at most two decimals into basis points; null otherwise. */
export function percentToBps(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const [whole = "0", frac = ""] = t.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/**
 * One stricter limit: empty keeps the hard limit; a value may only tighten it.
 * The hint names the hard limit and which way is tighter.
 */
function LimitField({
  field,
  hard,
  valueText,
  onChange,
  error,
  disabled = false,
  className,
}: {
  field: OwnerLimitField;
  /** The hard limit, in the field's unit (basis points or trades). */
  hard: number;
  valueText: string;
  onChange: (text: string) => void;
  error?: string;
  disabled?: boolean;
  className?: string;
}) {
  const f = OWNER_LIMIT_FACTS[field];
  const way = f.direction === "max" ? "lower" : "higher";
  const hint = `${f.explanation} Hard limit ${limitText(field, hard)}; yours can only be ${way}. Empty keeps the hard limit.`;
  return (
    <Field
      label={`${f.label} (${f.unit === "bps" ? "%" : "trades"})`}
      hint={hint}
      {...(className ? { className } : {})}
      {...(error ? { error } : {})}
    >
      {(control) => (
        <Input
          {...control}
          inputMode={f.unit === "bps" ? "decimal" : "numeric"}
          placeholder={f.unit === "bps" ? (hard / 100).toString() : hard.toString()}
          value={valueText}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          data-testid={`limit-${field}`}
        />
      )}
    </Field>
  );
}

export type GoalLimits = Readonly<Record<OwnerLimitField, number>>;

/** The hard limits, the owner's, and what applies: the tighter of each pair. */
function EffectiveLimits({
  hard,
  owner,
  effective,
  className,
}: {
  hard: GoalLimits;
  /** Null for a field the owner left at the hard limit. */
  owner: Readonly<Record<OwnerLimitField, number | null>>;
  effective: GoalLimits;
  className?: string;
}) {
  const fields = Object.keys(OWNER_LIMIT_FACTS) as OwnerLimitField[];
  return (
    <section className={cn("flex flex-col gap-2", className)} data-testid="effective-limits">
      <SectionLabel as="h4">Limits that apply</SectionLabel>
      <Table label="Limits that apply" stack>
        <TableHeader>
          <TableRow>
            <TableHead>Limit</TableHead>
            <TableHead>Hard limit</TableHead>
            <TableHead>Yours</TableHead>
            <TableHead>Applies</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {fields.map((f) => {
            const own = owner[f];
            return (
              <TableRow key={f} data-field={f}>
                <TableCell className="font-medium">{OWNER_LIMIT_FACTS[f].label}</TableCell>
                <TableCell label="Hard limit" className="numeric">
                  {limitText(f, hard[f])}
                </TableCell>
                <TableCell label="Yours" className="numeric text-foreground-muted">
                  {own === null ? "Same as hard limit" : limitText(f, own)}
                </TableCell>
                <TableCell label="Applies" className="numeric font-semibold">
                  {limitText(f, effective[f])}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

export interface CostRow {
  readonly intensity: ResearchIntensity;
  /** The daily budget the month is costed at: the owner's for the chosen one, else the default. */
  readonly dailyBudgetUsdcE6: bigint;
}

/**
 * What research can cost (D-299): each intensity's cadence and its most a
 * month can cost at its daily budget, which is a hard cap, plus the one-off
 * activation sweep's most.
 */
function CostPreview({
  rows,
  selected,
  days,
  sweepMaxUsdcE6,
  className,
}: {
  rows: readonly CostRow[];
  selected: ResearchIntensity;
  days: number;
  /** The activation sweep's most, for the chosen reasoning model. */
  sweepMaxUsdcE6: bigint;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-2", className)} data-testid="cost-preview">
      <SectionLabel as="h4">What research costs</SectionLabel>
      <Table label="What research costs" stack>
        <TableHeader>
          <TableRow>
            <TableHead>Intensity</TableHead>
            <TableHead>Research</TableHead>
            <TableHead>Most a day</TableHead>
            <TableHead>Most a month</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const f = RESEARCH_INTENSITY_FACTS[r.intensity];
            const chosen = r.intensity === selected;
            return (
              <TableRow
                key={r.intensity}
                data-intensity={r.intensity}
                {...(chosen ? { "aria-current": "true" as const } : {})}
                className={cn(chosen && "bg-surface-overlay")}
              >
                <TableCell className="font-medium">
                  {f.label}
                  {chosen ? <span className="text-foreground-muted"> (chosen)</span> : null}
                </TableCell>
                <TableCell label="Research" className="text-foreground-muted">
                  A Scan every {f.scanEveryHours} hours, up to {f.divesPerDay} Dive
                  {f.divesPerDay === 1 ? "" : "s"} a day
                </TableCell>
                <TableCell label="Most a day" className="numeric">
                  {usdc(r.dailyBudgetUsdcE6)} USDC
                </TableCell>
                <TableCell label="Most a month" className="numeric font-semibold">
                  {usdc(r.dailyBudgetUsdcE6 * BigInt(days))} USDC
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="text-xs text-foreground-muted">
        A month is {days} days at the daily budget, which research never goes past. Turning on
        automatic trading later runs one activation sweep of at most{" "}
        <span className="numeric text-foreground">{usdc(sweepMaxUsdcE6)}</span> USDC. Credits pay
        for both.
      </p>
    </section>
  );
}

/** The goal in one line, with the agent's state: for the agent's card and its portfolio. */
function GoalSummary({
  state,
  template,
  riskPreset,
  action,
  className,
}: {
  state: AgentState;
  /** Null when the owner has not set a goal. */
  template: StrategyTemplate | null;
  riskPreset: RiskPreset | null;
  /** A link to the Goal page. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}
      data-testid="goal-summary"
      data-state={state}
    >
      <StatusPill kind="agent_state" value={state} />
      <span className="text-sm text-foreground-muted">
        {template && riskPreset ? (
          <>
            Goal: <span className="text-foreground">{TEMPLATE_FACTS[template].label}</span>,{" "}
            <span className="text-foreground">{RISK_PRESET_FACTS[riskPreset].label}</span>
          </>
        ) : (
          "No goal yet: set one to get the agent ready."
        )}
      </span>
      {action}
    </div>
  );
}

export type GoalSaveState = "saving" | "saved" | "refused" | "failed";

const SAVE_TONE: Readonly<Record<GoalSaveState, string>> = {
  saving: "text-foreground-muted",
  saved: "text-positive",
  refused: "text-negative",
  failed: "text-negative",
};

/** The save's result in one place: saving, saved (with the state it moved to), refused with each reason, or failed. */
function GoalSaveStatus({
  state,
  text,
  reasons = [],
  className,
}: {
  state: GoalSaveState;
  text: string;
  /** Each refused field's reason. */
  reasons?: readonly string[];
  className?: string;
}) {
  const Icon = state === "saving" ? LoaderCircle : state === "saved" ? CircleCheck : CircleAlert;
  return (
    <div
      role="status"
      data-testid="goal-save-status"
      data-state={state}
      className={cn("flex items-start gap-2 text-sm", SAVE_TONE[state], className)}
    >
      <Icon
        aria-hidden
        className={cn("mt-0.5 size-4 shrink-0", state === "saving" && "animate-spin")}
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span>{text}</span>
        {reasons.length > 0 ? (
          <ul className="list-disc pl-4 text-xs">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
      </span>
    </div>
  );
}

export { CostPreview, EffectiveLimits, GoalSaveStatus, GoalSummary, LimitField };
