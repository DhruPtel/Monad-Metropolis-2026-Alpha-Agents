import {
  AGGRESSIVENESS_FACTS,
  type AgentState,
  type Aggressiveness,
  OWNER_LIMIT_FACTS,
  type OwnerLimitField,
  RESEARCH_INTENSITY_FACTS,
  type ResearchIntensity,
  formatAmount,
} from "@alpha-agents/domain";
import { CircleAlert, CircleCheck, ImageIcon, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { StatusPill } from "../status-pill";
import { Field, Input } from "../ui/input";
import { Slider } from "../ui/slider";
import { SectionLabel } from "../ui/section-label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { FactTile, TileGrid } from "./tiles";

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
  refused = [],
  testnet = false,
  className,
}: {
  hard: GoalLimits;
  /** Null for a field the owner left at the hard limit. */
  owner: Readonly<Record<OwnerLimitField, number | null>>;
  effective: GoalLimits;
  /** Fields whose typed value was refused: shown as not accepted, never as applying. */
  refused?: readonly OwnerLimitField[];
  /** Monad testnet: also shows the testnet trading profile's rules, marked as testnet limits. */
  testnet?: boolean;
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
                <TableCell
                  label="Yours"
                  className={cn(
                    "numeric",
                    refused.includes(f) ? "text-negative" : "text-foreground-muted",
                  )}
                >
                  {refused.includes(f)
                    ? "Not accepted"
                    : own === null
                      ? "Same as hard limit"
                      : limitText(f, own)}
                </TableCell>
                <TableCell label="Applies" className="numeric font-semibold">
                  {limitText(f, effective[f])}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {testnet ? (
        <div
          className="flex flex-col gap-1 rounded-md border border-warning p-3"
          data-testid="testnet-limits"
        >
          <p className="text-sm font-medium">Testnet limits: these apply on Monad testnet only</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-foreground-muted">Smallest trade</dt>
            <dd>None: gas decides how small a trade can go.</dd>
            <dt className="text-foreground-muted">Most a trade may cost</dt>
            <dd className="numeric">
              0.5% of its value, counting price impact, pool fees and gas at MON&apos;s market
              price.
            </dd>
          </dl>
          <p className="text-xs text-foreground-muted">
            Mainnet keeps a 0.50 USDC smallest trade and the plan&apos;s own cost limit.
          </p>
        </div>
      ) : null}
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

/** The goal in one line, with the agent's state: for the agent's card and its portfolio (F-U7: the aggressiveness). */
function GoalSummary({
  state,
  aggressiveness,
  action,
  className,
}: {
  state: AgentState;
  /** Null when the owner has not set a goal. */
  aggressiveness: Aggressiveness | null;
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
        {aggressiveness ? (
          <>
            Goal:{" "}
            <span className="text-foreground">{AGGRESSIVENESS_FACTS[aggressiveness].label}</span>
            <span className="text-foreground-muted">
              {" "}
              ({AGGRESSIVENESS_FACTS[aggressiveness].summary.replace(/\.$/, "").toLowerCase()})
            </span>
          </>
        ) : (
          "No goal yet: set one to get the agent ready."
        )}
      </span>
      {action}
    </div>
  );
}

/**
 * UI-U2: the goal at a glance, as four square tiles with the next action on
 * each: the aggressiveness, the token lane, the research intensity and its
 * daily budget, and what happens to a plan change. The words are the form's
 * current values, so an unsaved edit shows here at once.
 */
export interface GoalTilesView {
  readonly aggressiveness: Aggressiveness;
  readonly screenedOptIn: boolean;
  readonly excludedTokens: number;
  readonly intensity: ResearchIntensity;
  /** The daily budget as the owner typed it, or null while it is not a number. */
  readonly dailyBudgetUsdcE6: bigint | null;
  readonly modelTierLabel: string;
  readonly planChanges: "ASK_FIRST" | "APPLY_AND_TELL";
}

/** The plain words each tile says, so the page is tested without a browser. */
export function goalTileWords(v: GoalTilesView): {
  readonly aggressiveness: { value: string; note: string };
  readonly tokens: { value: string; note: string };
  readonly research: { value: string; note: string };
  readonly planChanges: { value: string; note: string };
} {
  const a = AGGRESSIVENESS_FACTS[v.aggressiveness];
  const r = RESEARCH_INTENSITY_FACTS[v.intensity];
  const excluded =
    v.excludedTokens === 0
      ? "nothing excluded"
      : `${v.excludedTokens} token${v.excludedTokens === 1 ? "" : "s"} excluded`;
  return {
    aggressiveness: { value: a.label, note: a.summary },
    tokens: {
      value: v.screenedOptIn ? "Core and screened" : "Core lane only",
      note: v.screenedOptIn
        ? `Screened tokens too, under the class A caps; ${excluded}.`
        : `Only tokens the platform reviewed, with a price feed; ${excluded}.`,
    },
    research: {
      value: r.label,
      note: `A Scan every ${r.scanEveryHours} hours, up to ${r.divesPerDay} Dive${r.divesPerDay === 1 ? "" : "s"} a day, ${
        v.dailyBudgetUsdcE6 === null ? "a budget to set" : `${usdc(v.dailyBudgetUsdcE6)} USDC a day`
      }, on the ${v.modelTierLabel} tier.`,
    },
    planChanges: {
      value: v.planChanges === "ASK_FIRST" ? "Ask me first" : "Apply and tell me",
      note:
        v.planChanges === "ASK_FIRST"
          ? "Each plan change waits for your approval."
          : "A change that passes every check applies at once.",
    },
  };
}

function GoalTiles({
  view,
  action,
  className,
}: {
  view: GoalTilesView;
  /** The next action for a tile: a link to its section on the page. */
  action: (section: "strategy" | "tokens" | "research" | "plan-changes") => ReactNode;
  className?: string;
}) {
  const w = goalTileWords(view);
  return (
    <TileGrid label="Goal at a glance" testId="goal-tiles" className={className}>
      <FactTile
        label="Aggressiveness"
        value={w.aggressiveness.value}
        note={w.aggressiveness.note}
        action={action("strategy")}
        numeric={false}
        testId="goal-tile-aggressiveness"
      />
      <FactTile
        label="Tokens"
        value={w.tokens.value}
        note={w.tokens.note}
        action={action("tokens")}
        numeric={false}
        testId="goal-tile-tokens"
      />
      <FactTile
        label="Research"
        value={w.research.value}
        note={w.research.note}
        action={action("research")}
        numeric={false}
        testId="goal-tile-research"
      />
      <FactTile
        label="Plan changes"
        value={w.planChanges.value}
        note={w.planChanges.note}
        action={action("plan-changes")}
        numeric={false}
        testId="goal-tile-plan-changes"
      />
    </TileGrid>
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

/** One square style tile (2026-10-13): a slot for its art, the name and one line. */
export interface StyleTileView {
  readonly value: Aggressiveness;
  readonly title: string;
  readonly line: string;
  /** The tile's art; null shows the empty slot until the art is made. */
  readonly art?: string | null;
}

/**
 * The goal's style as three square tiles (2026-10-13), one chosen: each with a
 * slot for its art, its name and one short line. A radio group: arrow keys move.
 */
function StyleTiles({
  value,
  onValueChange,
  tiles,
  disabled,
  className,
}: {
  value: Aggressiveness;
  onValueChange: (v: Aggressiveness) => void;
  tiles: readonly StyleTileView[];
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Style"
      className={cn("grid grid-cols-3 gap-3", className)}
      data-testid="style-tiles"
    >
      {tiles.map((t, i) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            onClick={() => onValueChange(t.value)}
            onKeyDown={(e) => {
              const step =
                e.key === "ArrowRight" || e.key === "ArrowDown"
                  ? 1
                  : e.key === "ArrowLeft" || e.key === "ArrowUp"
                    ? -1
                    : 0;
              if (!step) return;
              e.preventDefault();
              const next = tiles[(i + step + tiles.length) % tiles.length];
              if (next) onValueChange(next.value);
            }}
            className={cn(
              "flex aspect-square flex-col items-center justify-center gap-2 rounded-md border p-3 text-center outline-none transition-colors is-focus:focus-ring disabled:opacity-50",
              on ? "border-primary bg-surface-raised" : "border-border hover:border-border-strong",
            )}
            data-testid="style-tile"
            data-value={t.value}
          >
            {t.art ? (
              <img src={t.art} alt="" className="size-12 rounded-md object-cover" />
            ) : (
              <span
                aria-hidden
                className="flex size-12 items-center justify-center rounded-md border border-dashed border-border-strong text-foreground-subtle"
              >
                <ImageIcon className="size-5" />
              </span>
            )}
            <span className="text-sm font-medium">{t.title}</span>
            <span className="text-xs text-foreground-muted">{t.line}</span>
          </button>
        );
      })}
    </div>
  );
}

export interface AllocationRowView {
  readonly key: string;
  readonly label: string;
  readonly line: string;
  readonly bps: number;
}

/** Three shares as sliders in 5% steps that always add up to 100% (2026-10-13); the page rebalances them. */
function AllocationSliders({
  rows,
  onChange,
  disabled,
  className,
}: {
  rows: readonly AllocationRowView[];
  onChange: (key: string, bps: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-4", className)} data-testid="allocation">
      {rows.map((r) => (
        <div
          key={r.key}
          className="flex flex-col gap-1.5"
          data-testid="allocation-row"
          data-key={r.key}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">{r.label}</span>
            <span className="numeric text-sm" data-testid="allocation-value">
              {r.bps / 100}%
            </span>
          </div>
          <Slider
            thumbLabel={r.label}
            min={0}
            max={10_000}
            step={500}
            value={[r.bps]}
            disabled={disabled ?? false}
            onValueChange={(v) => onChange(r.key, v[0] ?? 0)}
          />
          <span className="text-xs text-foreground-muted">{r.line}</span>
        </div>
      ))}
    </div>
  );
}

/** The goal as a short summary with its save (2026-10-13): a few labeled rows, then the action and its status. */
function GoalPreviewCard({
  rows,
  note,
  action,
  status,
  className,
}: {
  rows: readonly { readonly label: string; readonly value: string }[];
  /** One plain line on what saving does. */
  note: string;
  action: ReactNode;
  status?: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label="Preview"
      className={cn("flex flex-col gap-4 rounded-md border border-border p-4", className)}
      data-testid="goal-preview"
    >
      <SectionLabel as="h3">Preview</SectionLabel>
      <dl className="flex flex-col gap-2 text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-foreground-muted">{r.label}</dt>
            <dd className="text-right font-medium">{r.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-foreground-muted">{note}</p>
      {action}
      {status}
    </section>
  );
}

export {
  AllocationSliders,
  CostPreview,
  EffectiveLimits,
  GoalPreviewCard,
  GoalSaveStatus,
  GoalSummary,
  GoalTiles,
  LimitField,
  StyleTiles,
};
