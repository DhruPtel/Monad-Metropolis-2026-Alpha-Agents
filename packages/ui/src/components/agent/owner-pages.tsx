"use client";

import { type AccountMode, formatAmount } from "@alpha-agents/domain";
import {
  CircleCheck,
  CircleDot,
  Clock,
  Compass,
  LayoutGrid,
  type LucideIcon,
  Table2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../../lib/utils";
import { AmountDisplay } from "../amount-display";
import { StatusPill } from "../status-pill";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { AllocationBar } from "./portfolio";
import {
  AllocationDonut,
  type AssetRow,
  AssetMakeupTable,
  PerformanceChart,
  type SeriesPoint,
} from "./window";

/**
 * The owner's main pages, redesigned (UI-U1, the owner's UI direction):
 * visuals over forms, squarer tiles about three across, every empty state
 * and error saying what it means and what to do next with the action beside
 * it. These are the pieces My Agents and the portfolio are built from:
 * the trading account as a centerpiece, the credits tile, positions as tiles,
 * the portfolio hero, the guided setup flow, a standard loading block and the
 * "coming after the beta" page.
 */
const usdc2 = (e6: bigint | string) =>
  formatAmount(BigInt(e6), 6, { maxFractionDigits: 2, minFractionDigits: 2 });
const pct = (bps: number, signed = false) =>
  `${signed && bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;

/** The trading account as the card's centerpiece: value, allocation, a small performance line, the state, one primary action. */
export interface TradingTileView {
  readonly hasAccount: boolean;
  /** The account's value; null while it cannot be priced. */
  readonly valueUsdcE6: bigint | null;
  readonly mode: AccountMode | null;
  /** Every held token valued, for the allocation; absent while unread. */
  readonly makeup?: readonly AssetRow[] | null;
  /** The value per unit over time, for the performance line; absent while unread. */
  readonly series?: readonly SeriesPoint[] | null;
  /** USDC's share, for the bar when the makeup is not known. */
  readonly usdcShareBps?: number | null;
  readonly restLabel?: string;
  /** The agent's trading state in plain words, such as "Armed: trades on its own within its limits". */
  readonly state?: { readonly label: string; readonly tone: "positive" | "neutral" | "warning" };
}

function TradingTile({
  agentName,
  trading,
  primary,
  secondary,
  className,
}: {
  agentName: string;
  /** Null while unread, or where trading is not deployed. */
  trading: TradingTileView | null;
  /** "Set up trading" when there is no account, "Open portfolio" when there is. */
  primary: ReactNode;
  secondary?: ReactNode;
  className?: string;
}) {
  const t = trading;
  const makeup = t?.makeup ?? null;
  const series = t?.series ?? null;
  return (
    <section
      aria-label={`Trading account of ${agentName}`}
      className={cn(
        "flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 lg:col-span-2",
        className,
      )}
      data-testid="trading-summary"
      data-state={t === null ? "reading" : t.hasAccount ? "open" : "none"}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="text-xs tracking-wide text-foreground-muted uppercase">
          Trading account
        </span>
        {t?.state ? (
          <Badge tone={t.state.tone === "positive" ? "positive" : t.state.tone}>
            {t.state.label}
          </Badge>
        ) : null}
      </div>
      {t === null || !t.hasAccount ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-foreground-muted">
            {t === null
              ? "Trading capital lives in an account only you can withdraw from, separate from credits; the agent trades it within its hard limits."
              : "No trading account yet. Trading capital lives in an account only you can withdraw from, separate from credits; the agent trades it within its hard limits."}
          </p>
          <div className="flex flex-wrap gap-2">
            {primary}
            {secondary}
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
          <div className="flex min-w-0 flex-col gap-3">
            {t.valueUsdcE6 === null ? (
              <p className="text-sm text-foreground-muted">
                Value unknown while a held token has no usable price. Withdrawals still work.
              </p>
            ) : (
              <AmountDisplay
                value={t.valueUsdcE6}
                decimals={6}
                minFractionDigits={2}
                maxFractionDigits={2}
                symbol="USDC"
                className="text-2xl font-semibold"
              />
            )}
            <div className="flex flex-wrap items-center gap-2">
              {t.mode ? <StatusPill kind="account_mode" value={t.mode} /> : null}
            </div>
            {makeup === null ? (
              t.usdcShareBps !== undefined && t.usdcShareBps !== null ? (
                <AllocationBar
                  usdcShareBps={t.usdcShareBps}
                  {...(t.restLabel ? { restLabel: t.restLabel } : {})}
                />
              ) : null
            ) : null}
            {series && series.length >= 2 ? (
              <PerformanceChart series={series} marks={[]} className="min-w-0" />
            ) : (
              <p className="text-xs text-foreground-muted" data-testid="trading-no-series">
                The performance line draws once the account has two readings; the platform records
                one every 15 minutes and after every trade.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {primary}
              {secondary}
            </div>
          </div>
          {makeup !== null ? <AllocationDonut rows={makeup} className="md:w-48" /> : null}
        </div>
      )}
    </section>
  );
}

/** Credits near the top: the balance against the cap, "Add credits" in a small dialog, and the research action with one line. */
function CreditsTile({
  agentName,
  creditsUsdcE6,
  capUsdcE6,
  heldUsdcE6 = 0n,
  addCredits,
  research,
  researchLine,
  researchStatus,
  restrictedNote,
  className,
}: {
  agentName: string;
  creditsUsdcE6: bigint;
  capUsdcE6: bigint;
  heldUsdcE6?: bigint;
  /** The button that opens the add-credits dialog. */
  addCredits: ReactNode;
  /** The research action: one button, and its status under it. */
  research: ReactNode;
  /** What research does and what it costs, in one line. */
  researchLine: string;
  /** Why research is not available now, the latest run, and the last action's outcome. */
  researchStatus?: ReactNode;
  /** When research is paused for lack of credits: what that means and what to do. */
  restrictedNote?: string | null;
  className?: string;
}) {
  const fill = capUsdcE6 > 0n ? Number((creditsUsdcE6 * 10_000n) / capUsdcE6) : 0;
  return (
    <section
      aria-label={`Credits of ${agentName}`}
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border bg-surface p-4",
        className,
      )}
      data-testid="credits-tile"
    >
      <span className="text-xs tracking-wide text-foreground-muted uppercase">Credits</span>
      <div className="flex flex-wrap items-baseline gap-2">
        <AmountDisplay
          value={creditsUsdcE6}
          decimals={6}
          maxFractionDigits={4}
          symbol="USDC"
          className="text-2xl font-semibold"
        />
        <span className="text-xs text-foreground-muted">of {usdc2(capUsdcE6)} during the beta</span>
      </div>
      <div
        role="meter"
        aria-label="Credits against the beta cap"
        aria-valuemin={0}
        aria-valuemax={10_000}
        aria-valuenow={Math.min(10_000, fill)}
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-raised"
      >
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${Math.min(100, fill / 100)}%` }}
        />
      </div>
      {heldUsdcE6 > 0n ? (
        <p className="text-xs text-foreground-muted" data-testid="credits-held-note">
          <Badge tone="warning" className="mr-1">
            {usdc2(heldUsdcE6)} USDC held
          </Badge>
          Above the cap: held, never spent, returned with your next refund.
        </p>
      ) : null}
      {restrictedNote ? (
        <p className="text-sm text-warning" data-testid="restricted-note">
          {restrictedNote}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">{addCredits}</div>
      <div className="flex flex-col gap-1 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Compass aria-hidden className="size-4 text-foreground-muted" />
          {research}
        </div>
        <p className="text-xs text-foreground-muted">{researchLine}</p>
        {researchStatus}
      </div>
    </section>
  );
}

/** Positions as tiles, about three across: symbol, amount, value, share and gain. */
function PositionTiles({
  rows,
  totalValueUsdcE6,
  emptyText,
  emptyAction,
  className,
}: {
  rows: readonly AssetRow[];
  totalValueUsdcE6: string | null;
  /** UI-U2: the empty state's words and next action, where the page knows them. */
  emptyText?: string;
  emptyAction?: ReactNode;
  className?: string;
}) {
  const held = rows.filter((r) => BigInt(r.amountRaw) > 0n);
  if (held.length === 0)
    return (
      <div
        className={cn(
          "flex flex-col items-center gap-3 rounded-lg border border-dashed p-6 text-center",
          className,
        )}
        data-testid="asset-makeup-empty"
      >
        <LayoutGrid aria-hidden className="size-8 text-foreground-subtle" />
        <p className="text-sm font-medium">Nothing held yet</p>
        <p className="max-w-md text-sm text-foreground-muted">
          {emptyText ?? "Deposit USDC to give the agent something to trade."}
        </p>
        {emptyAction}
      </div>
    );
  return (
    <div className={cn("flex flex-col gap-3", className)} data-testid="asset-makeup">
      <p className="text-xs text-foreground-muted">
        {totalValueUsdcE6 === null ? (
          "Total value unknown while a held token has no usable price."
        ) : (
          <>
            Total value{" "}
            <span className="numeric text-foreground">{usdc2(totalValueUsdcE6)} USDC</span>
          </>
        )}
      </p>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Positions">
        {held.map((r) => {
          const amount = formatAmount(BigInt(r.amountRaw), r.decimals, {
            maxFractionDigits: Math.min(r.decimals, 6),
          });
          return (
            <li
              key={r.symbol}
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
              data-testid="asset-row"
              data-symbol={r.symbol}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-semibold">{r.symbol}</span>
                {r.isCash ? <Badge tone="neutral">Cash</Badge> : null}
              </div>
              <span className="numeric text-lg">
                {amount} <span className="text-xs text-foreground-muted">{r.symbol}</span>
              </span>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-2xs text-foreground-muted">
                <dt>Value</dt>
                <dd className="numeric text-foreground">
                  {r.valueUsdcE6 === null ? "no usable price" : `${usdc2(r.valueUsdcE6)} USDC`}
                </dd>
                <dt>Share</dt>
                <dd className="numeric text-foreground">
                  {r.shareBps === null ? "unpriced" : pct(r.shareBps)}
                </dd>
                {!r.isCash ? (
                  <>
                    <dt>Gain</dt>
                    <dd
                      className={cn(
                        "numeric",
                        r.gainUsdcE6 !== null && BigInt(r.gainUsdcE6) > 0n && "text-positive",
                        r.gainUsdcE6 !== null && BigInt(r.gainUsdcE6) < 0n && "text-negative",
                      )}
                    >
                      {r.gainUsdcE6 === null
                        ? "unknown"
                        : `${BigInt(r.gainUsdcE6) > 0n ? "+" : ""}${usdc2(r.gainUsdcE6)}${r.gainBps === null ? "" : ` (${pct(r.gainBps, true)})`}`}
                    </dd>
                  </>
                ) : null}
              </dl>
              {r.shareBps !== null ? (
                <div
                  aria-hidden
                  className="h-1 w-full overflow-hidden rounded-full bg-surface-raised"
                >
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${Math.min(100, r.shareBps / 100)}%` }}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * UI-U2: the holdings as tiles, with the full table a click away. The table
 * carries the cost basis and the exact amounts; the tiles say what matters
 * at a glance. The donut sits beside either.
 */
function MakeupSwitch({
  rows,
  totalValueUsdcE6,
  asOf,
  emptyText,
  emptyAction,
  className,
}: {
  rows: readonly AssetRow[];
  totalValueUsdcE6: string | null;
  asOf: { readonly at: string; readonly live: boolean } | null;
  emptyText?: string;
  emptyAction?: ReactNode;
  className?: string;
}) {
  const [table, setTable] = useState(false);
  const held = rows.filter((r) => BigInt(r.amountRaw) > 0n);
  return (
    <div className={cn("flex flex-col gap-4", className)} data-testid="makeup-switch">
      {held.length > 0 ? (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant={table ? "secondary-accent" : "secondary"}
            aria-pressed={table}
            onClick={() => setTable((t) => !t)}
            data-testid="makeup-table-toggle"
          >
            {table ? <LayoutGrid aria-hidden /> : <Table2 aria-hidden />}{" "}
            {table ? "Tiles" : "Table"}
          </Button>
        </div>
      ) : null}
      <div className="grid gap-6 xl:grid-cols-[1fr_auto]">
        {table && held.length > 0 ? (
          <AssetMakeupTable rows={held} totalValueUsdcE6={totalValueUsdcE6} asOf={asOf} />
        ) : (
          <PositionTiles
            rows={rows}
            totalValueUsdcE6={totalValueUsdcE6}
            {...(emptyText ? { emptyText } : {})}
            {...(emptyAction ? { emptyAction } : {})}
          />
        )}
        {held.length > 0 ? <AllocationDonut rows={held} /> : null}
      </div>
    </div>
  );
}

/** The portfolio at a glance: total value, the allocation, the performance line, and the mode. */
function PortfolioHero({
  totalValueUsdcE6,
  rows,
  series,
  mode,
  state,
  custody,
  note,
  actions,
  className,
}: {
  totalValueUsdcE6: string | null;
  rows: readonly AssetRow[];
  series: readonly SeriesPoint[];
  mode: AccountMode;
  /** The agent's trading state in plain words. */
  state?: { readonly label: string; readonly tone: "positive" | "neutral" | "warning" };
  custody: "v2" | "v3";
  /** The prices' state in one line. */
  note?: ReactNode;
  /** Deposit and withdraw, as compact buttons, and any standing block on deposits. */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label="Portfolio overview"
      className={cn(
        "grid gap-4 rounded-lg border border-border bg-surface p-4 md:grid-cols-3 md:items-start",
        className,
      )}
      data-testid="portfolio-overview"
      data-custody={custody}
    >
      <div className="flex flex-col gap-2">
        <span className="text-xs tracking-wide text-foreground-muted uppercase">Total value</span>
        {totalValueUsdcE6 === null ? (
          <span className="text-sm text-foreground-muted">
            Unknown while a held token has no usable price. Withdrawals still work.
          </span>
        ) : (
          <span className="numeric text-3xl font-semibold">{usdc2(totalValueUsdcE6)} USDC</span>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill kind="account_mode" value={mode} />
          {state ? (
            <Badge tone={state.tone === "positive" ? "positive" : state.tone}>{state.label}</Badge>
          ) : null}
        </div>
        {note ? <p className="text-xs text-foreground-muted">{note}</p> : null}
      </div>
      <div className="flex justify-center md:justify-start">
        <AllocationDonut rows={rows} />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs tracking-wide text-foreground-muted uppercase">Performance</span>
        <PerformanceChart series={series} marks={[]} />
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4 md:col-span-3">
          {actions}
        </div>
      ) : null}
    </section>
  );
}

export type SetupStepState = "done" | "next" | "later" | "blocked";
export interface SetupStepView {
  readonly key: string;
  readonly title: string;
  readonly state: SetupStepState;
  /** What the step means and, when it is next or blocked, what to do. */
  readonly detail: string;
  /** The action that does it, for the next or blocked step. */
  readonly action?: ReactNode;
}

const STEP_ICON: Readonly<Record<SetupStepState, LucideIcon>> = {
  done: CircleCheck,
  next: CircleDot,
  later: Clock,
  blocked: CircleDot,
};

/** Opening an account, depositing, setting a goal and turning on automatic trading as one guided flow. */
function SetupFlow({ steps, className }: { steps: readonly SetupStepView[]; className?: string }) {
  const done = steps.filter((s) => s.state === "done").length;
  return (
    <section
      aria-label="Setup"
      className={cn("flex flex-col gap-3", className)}
      data-testid="setup-flow"
      data-done={done}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Set up automatic trading</h2>
        <span className="text-xs text-foreground-muted">
          {done} of {steps.length} steps done
        </span>
      </div>
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s, i) => {
          const Icon = STEP_ICON[s.state];
          return (
            <li
              key={s.key}
              className={cn(
                "flex flex-col gap-2 rounded-lg border p-4",
                s.state === "done" && "border-border bg-surface",
                s.state === "next" && "border-primary bg-surface-overlay",
                s.state === "blocked" && "border-warning/60 bg-surface",
                s.state === "later" && "border-dashed border-border bg-surface",
              )}
              data-testid="setup-step"
              data-step={s.key}
              data-state={s.state}
            >
              <div className="flex items-center gap-2">
                <Icon
                  aria-hidden
                  className={cn(
                    "size-4 shrink-0",
                    s.state === "done" && "text-positive",
                    s.state === "next" && "text-primary",
                    s.state === "blocked" && "text-warning",
                    s.state === "later" && "text-foreground-subtle",
                  )}
                />
                <span className="text-2xs text-foreground-muted">Step {i + 1}</span>
              </div>
              <span className="text-sm font-semibold">{s.title}</span>
              <p className="text-xs text-foreground-muted">{s.detail}</p>
              {s.action ? (
                <div className="mt-auto flex flex-wrap gap-2 pt-1">{s.action}</div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** A page's loading state: never a blank wait. */
function PageLoading({ label, className }: { label: string; className?: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className={cn("flex flex-col gap-4", className)}
      data-testid="page-loading"
    >
      <Skeleton className="h-8 w-1/3" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
      <p className="text-xs text-foreground-muted">{label}…</p>
    </div>
  );
}

/** A page that comes after the beta: what it will be, and where the live pages are. */
function ComingLater({
  title,
  description,
  links,
  className,
}: {
  title: string;
  description: string;
  /** The pages that work today, each with where it goes. */
  links: readonly { readonly href: string; readonly label: string; readonly note: string }[];
  className?: string;
}) {
  return (
    <section
      className={cn("flex flex-col gap-6", className)}
      data-testid="coming-later"
      aria-labelledby="coming-later-title"
    >
      <div className="flex flex-col gap-2">
        <Badge tone="warning" className="w-fit">
          Coming after the beta
        </Badge>
        <h1 id="coming-later-title" className="text-2xl font-semibold">
          {title}
        </h1>
        <p className="max-w-2xl text-sm text-foreground-muted">{description}</p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="What works today">
        {links.map((l) => (
          <li
            key={l.href}
            className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
          >
            <span className="text-sm font-semibold">{l.label}</span>
            <p className="text-xs text-foreground-muted">{l.note}</p>
            <Button asChild size="sm" variant="secondary" className="mt-auto w-fit">
              <a href={l.href}>Open {l.label}</a>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export {
  ComingLater,
  CreditsTile,
  MakeupSwitch,
  PageLoading,
  PortfolioHero,
  PositionTiles,
  SetupFlow,
  TradingTile,
};
