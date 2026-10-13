"use client";

import { ArrowUpRight, FileText } from "lucide-react";
import { type ComponentType, type ReactNode, useState } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { TokenMark } from "./agent-page";
import { type AssetRow, allocationSlices } from "./window";

/**
 * UI-FAST: the labelled concentration pie on an agent's Overview, and the
 * Trading tab's live decisions feed and portfolio insights. Presentational:
 * the app gives every figure; a figure that does not exist yet is "–".
 */

type LinkComponent = ComponentType<{ href: string; className?: string; children?: ReactNode }>;

// The slices' colours as fills: literal classes, so the stylesheet carries them.
const FILL_OF: Readonly<Record<string, string>> = {
  "stroke-chart-1": "fill-chart-1",
  "stroke-chart-2": "fill-chart-2",
  "stroke-chart-3": "fill-chart-3",
  "stroke-chart-4": "fill-chart-4",
  "stroke-chart-5": "fill-chart-5",
  "stroke-rare": "fill-rare",
  "stroke-border-strong": "fill-border-strong",
};

const pct = (bps: number) =>
  `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: bps < 1000 ? 1 : 0 })}%`;

/**
 * Where the account's value sits, as a pie with every slice labelled outside
 * it: the token, its share, and its gain beside it when known. A click on a
 * slice or its label calls `onSelect`.
 */
function ConcentrationPie({
  rows,
  pnl,
  total,
  onSelect,
  className,
}: {
  rows: readonly AssetRow[];
  /** Each token's gain in words ("+0.12 USDC"), by symbol; left out when unknown. */
  pnl?: Readonly<Record<string, { text: string; tone: "positive" | "negative" | "neutral" }>>;
  /** The account's total value, written, shown in the ring's centre. */
  total?: string;
  onSelect?: ((label: string) => void) | undefined;
  className?: string;
}) {
  const slices = allocationSlices(rows);
  const W = 420;
  const H = 300;
  const cx = W / 2;
  const cy = H / 2;
  const r = 100;
  const inner = 62;
  const label =
    slices.length === 0
      ? "Concentration: nothing priced is held"
      : `Concentration: ${slices.map((s) => `${s.label} ${pct(s.shareBps)}`).join(", ")}`;
  let start = -Math.PI / 2;
  const parts = slices.map((s) => {
    const sweep = (s.shareBps / 10_000) * Math.PI * 2;
    const a0 = start;
    const a1 = start + sweep;
    start = a1;
    return { s, a0, a1, mid: (a0 + a1) / 2 };
  });
  const point = (a: number, rad: number) =>
    [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad] as const;
  const arc = (a0: number, a1: number) => {
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const [x0, y0] = point(a0, r);
    const [x1, y1] = point(a1, r);
    const [i1x, i1y] = point(a1, inner);
    const [i0x, i0y] = point(a0, inner);
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${i1x} ${i1y} A ${inner} ${inner} 0 ${large} 0 ${i0x} ${i0y} Z`;
  };
  return (
    <figure className={cn("flex justify-center", className)} data-testid="concentration-pie">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={label}
        className="h-auto w-full max-w-md"
      >
        {slices.length === 0 ? (
          <circle
            cx={cx}
            cy={cy}
            r={(r + inner) / 2}
            className="fill-none stroke-border"
            strokeWidth={r - inner}
          />
        ) : null}
        {parts.map(({ s, a0, a1 }) => {
          const fill = FILL_OF[s.stroke] ?? "fill-border-strong";
          const cls = cn(fill, "stroke-background", onSelect && "cursor-pointer");
          const click = onSelect ? { onClick: () => onSelect(s.label) } : {};
          // A full ring is two half arcs, since one arc cannot close on itself.
          const d =
            a1 - a0 >= Math.PI * 2 - 1e-6
              ? `${arc(a0, a0 + Math.PI)} ${arc(a0 + Math.PI, a1)}`
              : arc(a0, a1);
          return (
            <path
              key={s.label}
              d={d}
              className={cls}
              strokeWidth={1.5}
              data-testid="pie-slice"
              {...click}
            />
          );
        })}
        {total ? (
          <>
            <text
              x={cx}
              y={cy - 4}
              textAnchor="middle"
              className="numeric fill-foreground text-base font-semibold"
            >
              {total}
            </text>
            <text x={cx} y={cy + 14} textAnchor="middle" className="fill-foreground-muted text-2xs">
              Total value
            </text>
          </>
        ) : null}
        {parts.map(({ s, mid }) => {
          const [ex, ey] = point(mid, r + 4);
          const [lx, ly] = point(mid, r + 24);
          const right = Math.cos(mid) >= 0;
          const tx = lx + (right ? 6 : -6);
          const gain = pnl?.[s.label];
          return (
            <g
              key={`l-${s.label}`}
              data-testid="pie-label"
              onClick={onSelect ? () => onSelect(s.label) : undefined}
              className={onSelect ? "cursor-pointer" : undefined}
            >
              <polyline
                points={`${ex},${ey} ${lx},${ly} ${tx - (right ? 3 : -3)},${ly}`}
                className="fill-none stroke-border-strong"
                strokeWidth={1}
              />
              <text
                x={tx}
                y={ly - 2}
                textAnchor={right ? "start" : "end"}
                className="fill-foreground text-sm font-semibold"
              >
                {s.label} {pct(s.shareBps)}
              </text>
              <text
                x={tx}
                y={ly + 13}
                textAnchor={right ? "start" : "end"}
                className={cn(
                  "text-xs",
                  gain?.tone === "positive"
                    ? "fill-positive"
                    : gain?.tone === "negative"
                      ? "fill-negative"
                      : "fill-foreground-muted",
                )}
              >
                {gain?.text ?? "PnL –"}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

export interface DecisionView {
  readonly id: string;
  readonly kind: "Plan" | "Trade" | "Skipped" | "Refused";
  readonly token: string | null;
  /** The target or the amount: "Target 20%", "Buy 0.02 USDC". */
  readonly detail: string | null;
  /** One line in plain words. */
  readonly summary: string;
  /** "2026-10-13 17:48". */
  readonly time: string;
  /** Where it came from: its research report or its transaction; null when neither exists. */
  readonly link: {
    readonly href: string;
    readonly label: string;
    readonly external: boolean;
  } | null;
}

const KIND_TONE = {
  Plan: "detail",
  Trade: "positive",
  Skipped: "neutral",
  Refused: "warning",
} as const;

const LINK_CLASS =
  "inline-flex items-center gap-1 text-primary underline-offset-4 outline-none hover:underline is-focus:focus-ring";

/** The agent's decisions, newest first, one row each, a page at a time. */
function DecisionList({
  items,
  empty,
  pageSize = 20,
  linkAs,
  className,
}: {
  items: readonly DecisionView[];
  empty: string;
  pageSize?: number;
  linkAs?: LinkComponent;
  className?: string;
}) {
  const LinkAs = linkAs ?? "a";
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const shown = items.slice(page * pageSize, (page + 1) * pageSize);
  if (items.length === 0)
    return <p className={cn("text-sm text-foreground-muted", className)}>{empty}</p>;
  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="decision-list">
      <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
        {shown.map((d) => (
          <li
            key={d.id}
            className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 px-3 py-2 text-xs md:grid-cols-[5.5rem_minmax(8rem,auto)_minmax(0,1fr)_8.5rem_6rem]"
            data-testid="decision"
            data-kind={d.kind}
          >
            <Badge tone={KIND_TONE[d.kind]} className="w-fit">
              {d.kind}
            </Badge>
            <span className="flex min-w-0 items-center gap-1.5">
              {d.token ? <TokenMark symbol={d.token} className="size-5" /> : null}
              <span className="font-medium">{d.token ?? "–"}</span>
              {d.detail ? (
                <span className="numeric truncate text-foreground-muted">{d.detail}</span>
              ) : null}
            </span>
            <span className="numeric text-right text-foreground-subtle md:order-4">{d.time}</span>
            <span
              className="col-span-3 truncate text-foreground-muted md:order-3 md:col-span-1"
              title={d.summary}
            >
              {d.summary}
            </span>
            <span className="col-span-3 md:order-5 md:col-span-1 md:text-right">
              {d.link ? (
                d.link.external ? (
                  <a
                    href={d.link.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className={LINK_CLASS}
                  >
                    {d.link.label} <ArrowUpRight aria-hidden className="size-3" />
                  </a>
                ) : (
                  <LinkAs href={d.link.href} className={LINK_CLASS}>
                    <FileText aria-hidden className="size-3" /> {d.link.label}
                  </LinkAs>
                )
              ) : (
                <span className="text-foreground-subtle">–</span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {pages > 1 ? (
        <div className="flex items-center gap-2 text-xs text-foreground-muted">
          <Button
            size="sm"
            variant="secondary"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            Newer
          </Button>
          <span className="numeric">
            Page {page + 1} of {pages}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={page >= pages - 1}
            onClick={() => setPage(page + 1)}
          >
            Older
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export interface InsightView {
  readonly label: string;
  /** The figure in words, "–" when it does not exist yet. */
  readonly value: string;
  readonly tone?: "positive" | "negative" | "neutral";
  /** A muted line under the figure: why it is "–", or what it counts. */
  readonly note?: string;
  /** A thin bar under the figure: the share filled, in basis points. */
  readonly bar?: number;
  /** "meter" (default): filled against empty; "split": two parts, as cash against invested. */
  readonly barKind?: "meter" | "split";
  /** Spans both columns. */
  readonly wide?: boolean;
}

/** A few figures about what the account holds, two to a row. */
function PortfolioInsights({
  items,
  className,
}: {
  items: readonly InsightView[];
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "grid grid-cols-2 gap-x-4 gap-y-3 rounded-md border border-border p-4",
        className,
      )}
      data-testid="portfolio-insights"
    >
      {items.map((i) => (
        <div key={i.label} className={cn("flex flex-col gap-0.5", i.wide && "col-span-2")}>
          <dt className="text-2xs text-foreground-muted">{i.label}</dt>
          <dd
            className={cn(
              "numeric text-sm font-semibold",
              i.tone === "positive"
                ? "text-positive"
                : i.tone === "negative"
                  ? "text-negative"
                  : "",
            )}
          >
            {i.value}
          </dd>
          {i.bar !== undefined ? (
            <div
              className={cn(
                "mt-1 flex h-1.5 overflow-hidden rounded-full",
                i.barKind === "split" ? "bg-chart-1" : "bg-surface-overlay",
              )}
              aria-hidden
            >
              <div
                className={cn("h-full", i.barKind === "split" ? "bg-rare" : "bg-primary")}
                style={{ width: `${Math.max(0, Math.min(100, i.bar / 100))}%` }}
              />
            </div>
          ) : null}
          {i.note ? <dd className="text-2xs text-foreground-subtle">{i.note}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

export interface FactItem {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
}

/** A compact row of labelled facts that wraps on a phone. */
function FactStrip({ items, className }: { items: readonly FactItem[]; className?: string }) {
  return (
    <dl
      className={cn(
        "grid grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-4 xl:grid-cols-8",
        className,
      )}
      data-testid="fact-strip"
    >
      {items.map((f) => (
        <div key={f.label} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-2xs text-foreground-muted">{f.label}</dt>
          <dd className="numeric truncate font-medium" title={f.value}>
            {f.value}
          </dd>
          {f.note ? <dd className="text-2xs text-foreground-subtle">{f.note}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

export interface PlanRowView {
  readonly symbol: string;
  readonly side: "Buy" | "Sell" | "Hold";
  /** Basis points; null when the plan names no share (a token it sells off). */
  readonly targetBps: number | null;
  /** The account's share now, basis points; null when unknown. */
  readonly currentBps: number | null;
}

const SIDE_TONE = { Buy: "positive", Sell: "negative", Hold: "neutral" } as const;
const bpsText = (b: number | null) => (b === null ? "–" : pct(b));

/**
 * The plan as one compact card: when it came in force (or that it waits),
 * the goal, each move as a row with a thin bar of the share now against the
 * target, and the reasoning in two lines with its report.
 */
function PlanSummaryCard({
  heading,
  badge,
  goal,
  rows,
  rationale,
  reportHref,
  actions,
  linkAs,
  className,
}: {
  /** "In force since 2026-10-13", "Waiting for your approval". */
  heading: string;
  badge?: { readonly label: string; readonly tone: "positive" | "neutral" | "warning" | "detail" };
  goal: string;
  rows: readonly PlanRowView[];
  rationale: string;
  reportHref?: string | null;
  /** Approve and decline, while the plan waits. */
  actions?: ReactNode;
  linkAs?: LinkComponent;
  className?: string;
}) {
  const LinkAs = linkAs ?? "a";
  return (
    <section
      aria-label="Plan"
      className={cn("flex flex-col gap-3 rounded-md border border-border p-4", className)}
      data-testid="plan-summary"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{heading}</span>
        {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
        <span className="ml-auto text-xs text-foreground-muted">Goal: {goal}</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-foreground-muted">The plan moves nothing.</p>
      ) : (
        <ul className="flex flex-col gap-2.5" data-testid="plan-rows">
          {rows.map((r) => {
            const fill =
              r.targetBps && r.currentBps !== null
                ? Math.min(100, (r.currentBps / r.targetBps) * 100)
                : 0;
            return (
              <li
                key={r.symbol}
                className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 text-xs"
                data-testid="plan-row"
              >
                <TokenMark symbol={r.symbol} className="size-6" />
                <span className="flex items-center gap-2">
                  <span className="font-medium">{r.symbol}</span>
                  <Badge tone={SIDE_TONE[r.side]}>{r.side}</Badge>
                </span>
                <span className="numeric text-right text-foreground-muted">
                  <span className="text-foreground">{bpsText(r.currentBps)}</span> now ·{" "}
                  <span className="text-foreground">{bpsText(r.targetBps)}</span> target
                </span>
                <div
                  className="col-span-3 h-1 overflow-hidden rounded-full bg-surface-overlay"
                  aria-hidden
                >
                  <div className="h-full rounded-full bg-primary" style={{ width: `${fill}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="line-clamp-2 text-xs text-foreground-muted" title={rationale}>
        {rationale}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {reportHref ? (
          <LinkAs href={reportHref} className={cn(LINK_CLASS, "text-xs")}>
            <FileText aria-hidden className="size-3.5" /> View report
          </LinkAs>
        ) : null}
        {actions ? <span className="ml-auto flex gap-2">{actions}</span> : null}
      </div>
    </section>
  );
}

export { ConcentrationPie, DecisionList, FactStrip, PlanSummaryCard, PortfolioInsights };
