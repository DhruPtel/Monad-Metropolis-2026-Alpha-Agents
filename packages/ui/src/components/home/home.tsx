import { ArrowRight } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { type ArtTier, SpeciesArt } from "../agent/species-art";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tag } from "../ui/tag";

/**
 * UI-FAST: the home page's parts around its centerpiece: the hero with live
 * stats, the connected owner's agents (or one mint call to action), and the
 * top vaults or agents as cards with every one as a dense list (RankedCards,
 * RankedList: a vault, or an agent and its trading account). Presentational: the app
 * gives every figure, already written.
 */

type LinkComponent = ComponentType<{ href: string; className?: string; children?: ReactNode }>;

const TIER_NAME: Readonly<Record<ArtTier, string>> = { base: "Base", medium: "Medium", pro: "Pro" };
const TIER_TONE = { base: "neutral", medium: "rare", pro: "legendary" } as const;

export interface HomeStatView {
  readonly label: string;
  readonly value: string;
  /** What the figure counts, for the tooltip and screen readers. */
  readonly meaning: string;
}

/** A small green dot for an agent with activity in the last hour. */
function LiveDot({
  live,
  hideLabel = false,
  className,
}: {
  live: boolean;
  /** Keep the word for screen readers only, as in a dense row. */
  hideLabel?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 text-2xs text-foreground-muted", className)}
      data-testid="live-dot"
      data-live={live ? "" : undefined}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          live ? "bg-positive motion-safe:animate-status-pulse" : "bg-border-strong",
        )}
      />
      <span className={hideLabel ? "sr-only" : undefined}>{live ? "Live" : "Idle"}</span>
    </span>
  );
}

/**
 * The hero, small and quiet: a modest title, a few lines at body size, one
 * row of tiny inline stats, and below them whatever the page puts there (the
 * flow pills). On wide screens the right half is held for a visual to come.
 */
function HomeHero({
  title,
  lede,
  stats,
  below,
  visual,
  className,
}: {
  title: string;
  lede: string;
  stats: readonly HomeStatView[];
  below?: ReactNode;
  /** The right side; HeroVisualSlot reserves it until the visual exists. */
  visual?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn("grid items-center gap-10 py-6 lg:grid-cols-2 lg:py-12", className)}
      data-testid="home-hero"
    >
      <div className="flex flex-col gap-6">
        <div className="flex max-w-md flex-col gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm leading-relaxed text-foreground-muted">{lede}</p>
        </div>
        <ul className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs" aria-label="Network">
          {stats.map((s, i) => (
            <li
              key={s.label}
              className="flex items-baseline gap-1"
              title={s.meaning}
              data-testid="home-stat"
            >
              <span className="numeric font-semibold text-foreground">{s.value}</span>
              <span className="text-foreground-muted">{s.label}</span>
              {i < stats.length - 1 ? (
                <span aria-hidden className="pl-1 text-foreground-subtle">
                  ·
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {below}
      </div>
      {visual}
    </header>
  );
}

/** Holds the hero's right side, square, for a visual to come; a faint ring marks it. */
function HeroVisualSlot({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      data-testid="hero-visual-slot"
      className={cn(
        "relative hidden aspect-square w-full max-w-120 items-center justify-center justify-self-end lg:flex",
        className,
      )}
    >
      <span className="absolute inset-6 rounded-full border border-dashed border-border" />
      <span className="absolute inset-20 rounded-full border border-border/50" />
    </div>
  );
}

export interface FlowPillView {
  readonly label: string;
  readonly value: string;
  /** Whether money or work moved into this step recently; its line in brightens. */
  readonly active: boolean;
}

/** The flow in small: thin pills joined by thin lines, each with its number. */
function FlowPills({ steps, className }: { steps: readonly FlowPillView[]; className?: string }) {
  return (
    <ol
      className={cn("flex flex-wrap items-center gap-1.5 sm:gap-x-0 sm:gap-y-2", className)}
      aria-label="Where the money goes"
      data-testid="flow-pills"
    >
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-center" data-testid="flow-pill">
          {i > 0 ? (
            <span
              aria-hidden
              className={cn(
                "hidden h-px sm:block sm:w-8",
                s.active ? "bg-primary-muted motion-safe:animate-slot-pulse" : "bg-border",
              )}
            />
          ) : null}
          <span className="flex items-baseline gap-1 rounded-full border px-2 py-0.5 text-2xs sm:gap-1.5 sm:px-2.5">
            <span className="text-foreground-muted">{s.label}</span>
            <span className="numeric font-semibold text-foreground">{s.value}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export interface HomeRankedView {
  readonly id: string;
  readonly name: string;
  readonly image: string | null;
  readonly tier: ArtTier | null;
  readonly speciesName: string | null;
  readonly value: string;
  /** "+1.20%", or null while there is not enough history or nothing deposited. */
  readonly returnText: string | null;
  readonly research: string;
  readonly trades: string;
  /** What to say in place of a missing return; "Not enough data" when left out. */
  readonly returnEmpty?: string | undefined;
  /** "Vault" or "Agent", when a row mixes both. */
  readonly kindLabel?: string | undefined;
  /** The agent's goal, for an agent's card ("Balanced"); left out for a vault. */
  readonly goal?: string | undefined;
  readonly live: boolean;
  readonly href: string;
}

function RankedCards({
  items,
  linkAs,
  className,
}: {
  items: readonly HomeRankedView[];
  linkAs?: LinkComponent;
  className?: string;
}) {
  const LinkAs = linkAs ?? "a";
  return (
    <ul
      className={cn("grid gap-3 sm:grid-cols-2 lg:grid-cols-3", className)}
      data-testid="ranked-cards"
    >
      {items.map((v) => (
        <li key={v.id}>
          <LinkAs
            href={v.href}
            className="flex flex-col gap-2 rounded-md border border-border bg-transparent p-3 outline-none transition-colors hover:border-primary-muted is-focus:focus-ring"
          >
            <span className="flex items-center gap-3">
              <SpeciesArt
                compact
                image={v.image}
                speciesName={v.speciesName}
                tier={v.tier}
                className="w-10 shrink-0"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-xs font-medium">{v.name}</span>
                  {v.tier ? (
                    <Tag tone={TIER_TONE[v.tier]} size="sm">
                      {TIER_NAME[v.tier]}
                    </Tag>
                  ) : null}
                  {v.kindLabel ? (
                    <span
                      className="ml-auto text-2xs text-foreground-muted"
                      data-testid="card-kind"
                    >
                      {v.kindLabel}
                    </span>
                  ) : null}
                </span>
                <span className="flex items-center gap-2">
                  <LiveDot live={v.live} />
                  {v.goal ? <span className="text-2xs text-foreground-muted">{v.goal}</span> : null}
                </span>
              </span>
            </span>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
              <dt className="text-foreground-muted">Value</dt>
              <dd className="numeric text-right font-semibold">{v.value}</dd>
              <dt className="text-foreground-muted">Return</dt>
              <dd className="numeric text-right">
                {v.returnText ?? v.returnEmpty ?? "Not enough data"}
              </dd>
              <dt className="text-foreground-muted">Research runs</dt>
              <dd className="numeric text-right">{v.research}</dd>
              <dt className="text-foreground-muted">Trades</dt>
              <dd className="numeric text-right">{v.trades}</dd>
            </dl>
          </LinkAs>
        </li>
      ))}
    </ul>
  );
}

export interface AgentRowView {
  readonly id: string;
  readonly name: string;
  readonly image: string | null;
  readonly tier: ArtTier | null;
  readonly speciesName: string | null;
  readonly value: string;
  /** "+1.20%"; null shows the row's `returnEmpty` ("No deposits", "–"). */
  readonly returnText: string | null;
  readonly returnEmpty: string;
  /** Values over time for a sparkline; the column shows only when some row has one. */
  readonly series?: readonly number[] | undefined;
  readonly research: string;
  readonly trades: string;
  readonly age: string;
  readonly live: boolean;
  readonly href: string;
}

export interface AgentTableFilter {
  readonly id: string;
  readonly label: string;
}

/** A tiny line of a value over time, drawn in the cell's own colour. */
function Sparkline({ points, label }: { points: readonly number[]; label: string }) {
  if (points.length < 2) return <span className="text-foreground-subtle">–</span>;
  const min = Math.min(...points);
  const span = Math.max(...points) - min || 1;
  const d = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${(i / (points.length - 1)) * 64} ${16 - ((p - min) / span) * 14 - 1}`,
    )
    .join(" ");
  return (
    <svg
      viewBox="0 0 64 16"
      className="h-4 w-16 text-foreground-muted"
      role="img"
      aria-label={label}
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.25} />
    </svg>
  );
}

/**
 * Every agent once, in one dense table with filter tabs (Trending, Top,
 * Gainers, New): art, name and tier, value, return, a sparkline when any
 * history exists, research runs, trades, age, and an arrow to the portfolio.
 * The app sorts the rows for the chosen filter.
 */
function AgentTable({
  filters,
  filter,
  onFilter,
  rows,
  linkAs,
  className,
}: {
  filters: readonly AgentTableFilter[];
  filter: string;
  onFilter: (id: string) => void;
  rows: readonly AgentRowView[];
  linkAs?: LinkComponent;
  className?: string;
}) {
  const LinkAs = linkAs ?? "a";
  const sparks = rows.some((r) => (r.series?.length ?? 0) > 1);
  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="agent-table">
      <div role="group" aria-label="Sort agents" className="flex flex-wrap gap-1">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={f.id === filter}
            onClick={() => onFilter(f.id)}
            data-testid="agent-filter"
            className={cn(
              "rounded-md px-2.5 py-1 text-xs outline-none transition-colors is-focus:focus-ring",
              f.id === filter
                ? "bg-surface-raised font-medium text-foreground"
                : "text-foreground-muted hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      <Table label="All agents" className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead className="text-right">Return</TableHead>
            {sparks ? <TableHead className="hidden sm:table-cell">History</TableHead> : null}
            <TableHead className="hidden sm:table-cell text-right">Research</TableHead>
            <TableHead className="hidden sm:table-cell text-right">Trades</TableHead>
            <TableHead className="hidden sm:table-cell text-right">Age</TableHead>
            <TableHead>
              <span className="sr-only">Open</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id} data-testid="agent-row" data-agent={r.id}>
              <TableCell className="py-1.5">
                <span className="flex items-center gap-2.5">
                  <SpeciesArt
                    compact
                    image={r.image}
                    speciesName={r.speciesName}
                    tier={r.tier}
                    className="w-7 shrink-0"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{r.name}</span>
                      <LiveDot live={r.live} hideLabel />
                    </span>
                    <span className="text-2xs text-foreground-muted">
                      {r.tier ? TIER_NAME[r.tier] : "Unrevealed"}
                    </span>
                  </span>
                </span>
              </TableCell>
              <TableCell
                label="Value"
                className="numeric py-1.5 text-right font-semibold whitespace-nowrap"
              >
                {r.value}
              </TableCell>
              <TableCell label="Return" className="numeric py-1.5 text-right whitespace-nowrap">
                {r.returnText ?? <span className="text-foreground-muted">{r.returnEmpty}</span>}
              </TableCell>
              {sparks ? (
                <TableCell label="History" className="hidden sm:table-cell py-1.5">
                  <Sparkline points={r.series ?? []} label={`${r.name} value over time`} />
                </TableCell>
              ) : null}
              <TableCell
                label="Research"
                className="numeric hidden sm:table-cell py-1.5 text-right"
              >
                {r.research}
              </TableCell>
              <TableCell label="Trades" className="numeric hidden sm:table-cell py-1.5 text-right">
                {r.trades}
              </TableCell>
              <TableCell
                label="Age"
                className="numeric hidden sm:table-cell py-1.5 text-right text-foreground-muted"
              >
                {r.age}
              </TableCell>
              <TableCell className="py-1.5 text-right">
                <LinkAs
                  href={r.href}
                  className="inline-flex rounded-sm p-1 text-foreground-muted outline-none hover:text-foreground is-focus:focus-ring"
                >
                  <ArrowRight aria-hidden className="size-4" />
                  <span className="sr-only">Open {r.name}'s portfolio</span>
                </LinkAs>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export { AgentTable, FlowPills, HeroVisualSlot, HomeHero, LiveDot, RankedCards, Sparkline };
