"use client";

import { formatAmount } from "@alpha-agents/domain";
import { LineChart, Table2 } from "lucide-react";
import {
  type PointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/utils";
import { AmountDisplay } from "../amount-display";
import { Button } from "../ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { Tag } from "../ui/tag";
import { TILE_CLASS } from "./tiles";

/**
 * The portfolio window (F-U11, D-368): what the agent holds and how it is
 * performing, in numbers the owner can trust. Every figure here is a string
 * from the control API's window read; the components format, never compute.
 * Performance is on the account's value per unit, so a deposit or a
 * withdrawal never reads as a gain or a loss, and every score says "not
 * enough data yet" while the history is too short.
 */
export interface AssetRow {
  readonly symbol: string;
  readonly decimals: number;
  readonly amountRaw: string;
  readonly isCash: boolean;
  /** Null while the token has no usable price. */
  readonly valueUsdcE6: string | null;
  /** Of the priced total, basis points; null while unpriced. */
  readonly shareBps: number | null;
  readonly costBasisUsdcE6: string | null;
  readonly gainUsdcE6: string | null;
  readonly gainBps: number | null;
}

export interface SeriesPoint {
  readonly at: string;
  readonly perUnitE18: string;
  readonly valueUsdcE6: string | null;
  readonly reason: "interval" | "trade";
}

export interface TradeMarkView {
  readonly at: string;
  readonly intentId: string;
  readonly side: "buy" | "sell";
  readonly symbol: string;
  readonly amountRaw: string;
  readonly decimals: number;
  readonly usdcE6: string;
  readonly txHash: string | null;
}

export type ScoreView<T> =
  ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string };

export interface WindowScores {
  readonly returnSinceStart: ScoreView<{
    readonly bps: number;
    readonly since: string;
    readonly asOf: string;
  }>;
  readonly maxDrawdown: ScoreView<{
    readonly bps: number;
    readonly peakAt: string;
    readonly troughAt: string;
  }>;
  readonly winShare: ScoreView<{
    readonly bps: number;
    readonly closed: number;
    readonly won: number;
  }>;
}

export type HundredView = ScoreView<{
  readonly now: string;
  readonly usdc: string;
  readonly since: string;
}>;

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const day = (iso: string) => iso.slice(5, 10);
const clock = (iso: string) => iso.slice(11, 16);
const pct = (bps: number, signed = false) =>
  `${signed && bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;
const usdc = (e6: string) =>
  formatAmount(BigInt(e6), 6, { maxFractionDigits: 2, minFractionDigits: 2 });
/** 100 times a reading's growth from the first, in whole cents: "$100 at the start is worth" this. */
function indexCents(perUnitE18: string, firstE18: string): number {
  const first = BigInt(firstE18);
  if (first === 0n) return 10_000;
  return Number((BigInt(perUnitE18) * 10_000n) / first);
}
const dollars = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

/* ---------------------------------------------------------------------- */
/* Asset makeup                                                            */
/* ---------------------------------------------------------------------- */

/**
 * Every held token: amount, value where priced, share of the priced total,
 * cost basis and gain or loss. Stacked on a phone. A token without a usable
 * price stays listed, with its value, share and gain unknown.
 */
function AssetMakeupTable({
  rows,
  totalValueUsdcE6,
  asOf,
  className,
}: {
  rows: readonly AssetRow[];
  /** The account's own value, null while unusable. */
  totalValueUsdcE6: string | null;
  /** When the holdings were read, and whether live from the chain. */
  asOf: { readonly at: string; readonly live: boolean } | null;
  className?: string;
}) {
  if (rows.length === 0)
    return (
      <p
        className={cn("text-sm text-foreground-muted", className)}
        data-testid="asset-makeup-empty"
      >
        Nothing is held yet. The makeup appears after the first deposit.
      </p>
    );
  return (
    <Table label="Asset makeup" stack className={className} data-testid="asset-makeup">
      <TableCaption>
        {totalValueUsdcE6 !== null ? (
          <>
            Total value{" "}
            <span className="numeric text-foreground">{usdc(totalValueUsdcE6)} USDC</span>
          </>
        ) : (
          "Total value unknown while a held token has no usable price."
        )}
        {asOf ? ` As of ${when(asOf.at)}${asOf.live ? "" : " (the latest snapshot)"}.` : null}
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Asset</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead className="text-right">Share</TableHead>
          <TableHead className="text-right">Cost basis</TableHead>
          <TableHead className="text-right">Gain or loss</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.symbol} data-testid="asset-row" data-symbol={r.symbol}>
            <TableCell label="Asset" className="font-medium">
              {r.symbol}
              {r.isCash ? (
                <Tag size="sm" className="ml-2">
                  cash
                </Tag>
              ) : null}
            </TableCell>
            <TableCell label="Amount" className="text-right">
              <AmountDisplay
                value={BigInt(r.amountRaw)}
                decimals={r.decimals}
                maxFractionDigits={6}
              />
            </TableCell>
            <TableCell label="Value" className="text-right">
              {r.valueUsdcE6 !== null ? (
                <AmountDisplay
                  value={BigInt(r.valueUsdcE6)}
                  decimals={6}
                  symbol="USDC"
                  minFractionDigits={2}
                />
              ) : (
                <span className="text-xs text-warning">no usable price</span>
              )}
            </TableCell>
            <TableCell label="Share" className="text-right">
              {r.shareBps !== null ? (
                <span className="numeric">{pct(r.shareBps)}</span>
              ) : (
                <span className="text-foreground-muted">unknown</span>
              )}
            </TableCell>
            <TableCell label="Cost basis" className="text-right">
              {r.costBasisUsdcE6 !== null ? (
                <AmountDisplay
                  value={BigInt(r.costBasisUsdcE6)}
                  decimals={6}
                  symbol="USDC"
                  minFractionDigits={2}
                />
              ) : (
                <span className="text-foreground-muted">not kept</span>
              )}
            </TableCell>
            <TableCell label="Gain or loss" className="text-right">
              {r.isCash ? (
                <span className="text-foreground-muted">cash</span>
              ) : r.gainUsdcE6 !== null && r.gainBps !== null ? (
                <span className="flex flex-col items-end sm:flex-row sm:items-baseline sm:justify-end sm:gap-2">
                  <AmountDisplay
                    value={BigInt(r.gainUsdcE6)}
                    decimals={6}
                    symbol="USDC"
                    minFractionDigits={2}
                    signed
                    colorBySign
                  />
                  <span className="numeric text-xs text-foreground-muted">
                    {pct(r.gainBps, true)}
                  </span>
                </span>
              ) : (
                <span className="text-foreground-muted">unknown</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/* ---------------------------------------------------------------------- */
/* Allocation donut                                                        */
/* ---------------------------------------------------------------------- */

/** The six series colours in their fixed order; USDC keeps steel, as the allocation chart draws it. */
const SERIES_STROKE = [
  "stroke-chart-1",
  "stroke-chart-2",
  "stroke-chart-3",
  "stroke-chart-4",
  "stroke-chart-5",
  "stroke-chart-6",
] as const;
const SERIES_FILL = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
  "bg-chart-6",
] as const;
const CASH_STROKE = "stroke-rare";
const CASH_FILL = "bg-rare";
const OTHER_STROKE = "stroke-border-strong";
const OTHER_FILL = "bg-border-strong";
/** How many tokens get a colour of their own before the rest fold into Other. */
const DONUT_SLICES = 6;

interface Slice {
  readonly label: string;
  readonly shareBps: number;
  readonly stroke: string;
  readonly fill: string;
}

/** The slices: cash in steel, up to five more tokens by their fixed colour, the rest as Other. */
export function allocationSlices(rows: readonly AssetRow[]): Slice[] {
  const priced = rows.filter((r) => r.shareBps !== null && r.shareBps > 0);
  const cash = priced.filter((r) => r.isCash);
  const tokens = priced.filter((r) => !r.isCash);
  const own = tokens.slice(0, DONUT_SLICES - cash.length);
  const rest = tokens.slice(own.length);
  // Colour follows the token, never its rank: the alphabet gives each its hue.
  const order = [...own].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const slices: Slice[] = [
    ...cash.map((r) => ({
      label: r.symbol,
      shareBps: r.shareBps as number,
      stroke: CASH_STROKE,
      fill: CASH_FILL,
    })),
    ...own.map((r) => {
      const i = order.indexOf(r);
      return {
        label: r.symbol,
        shareBps: r.shareBps as number,
        stroke: SERIES_STROKE[i] ?? OTHER_STROKE,
        fill: SERIES_FILL[i] ?? OTHER_FILL,
      };
    }),
  ];
  if (rest.length > 0)
    slices.push({
      label: `Other (${rest.length})`,
      shareBps: rest.reduce((t, r) => t + (r.shareBps as number), 0),
      stroke: OTHER_STROKE,
      fill: OTHER_FILL,
    });
  return slices;
}

/**
 * The allocation across every priced position as a donut: at most six
 * slices and Other, each named with its share beside it, a 2px gap between
 * slices. Unpriced tokens are named under it, since they have no share.
 */
function AllocationDonut({ rows, className }: { rows: readonly AssetRow[]; className?: string }) {
  const slices = allocationSlices(rows);
  const unpriced = rows.filter((r) => r.shareBps === null && BigInt(r.amountRaw) > 0n);
  const r = 42;
  const c = 2 * Math.PI * r;
  const gap = 2;
  const label =
    slices.length === 0
      ? "Allocation: nothing priced is held"
      : `Allocation by value: ${slices.map((s) => `${s.label} ${pct(s.shareBps)}`).join(", ")}`;
  let offset = 0;
  return (
    <figure
      className={cn("flex flex-col items-center gap-3 sm:flex-row sm:items-center", className)}
      data-testid="allocation-donut"
    >
      <svg viewBox="0 0 100 100" role="img" aria-label={label} className="size-36 shrink-0">
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="12" className="stroke-border" />
        {slices.map((s) => {
          const length = (c * s.shareBps) / 10_000;
          const start = offset;
          offset += length;
          return (
            <circle
              key={s.label}
              cx="50"
              cy="50"
              r={r}
              fill="none"
              strokeWidth="12"
              className={s.stroke}
              transform="rotate(-90 50 50)"
              strokeDasharray={`${Math.max(0, length - (slices.length > 1 ? gap : 0))} ${c}`}
              strokeDashoffset={-start}
              data-testid="allocation-slice"
            />
          );
        })}
      </svg>
      <figcaption className="flex flex-col gap-2 text-sm">
        {slices.length === 0 ? (
          <span className="text-foreground-muted">{label}</span>
        ) : (
          slices.map((s) => (
            <span key={s.label} className="flex items-center gap-2">
              <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", s.fill)} />
              <span className="min-w-12">{s.label}</span>
              <span className="numeric">{pct(s.shareBps)}</span>
            </span>
          ))
        )}
        {unpriced.length > 0 ? (
          <span className="text-xs text-warning" data-testid="allocation-unpriced">
            No usable price, so no share: {unpriced.map((u) => u.symbol).join(", ")}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

/* ---------------------------------------------------------------------- */
/* Performance chart                                                       */
/* ---------------------------------------------------------------------- */

const CHART_HEIGHT = 240;
const PAD = { top: 16, right: 16, bottom: 28, left: 52 };

function useWidth(fallback = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** The chart's geometry: one x per reading, y from the $100 index. */
function layout(series: readonly SeriesPoint[], width: number) {
  const first = series[0]?.perUnitE18 ?? "1";
  const times = series.map((p) => Date.parse(p.at));
  const cents = series.map((p) => indexCents(p.perUnitE18, first));
  const t0 = times[0] ?? 0;
  const t1 = times[times.length - 1] ?? t0;
  let lo = Math.min(...cents);
  let hi = Math.max(...cents);
  if (hi - lo < 100) {
    lo -= 50;
    hi += 50;
  }
  const span = hi - lo;
  lo -= span * 0.08;
  hi += span * 0.08;
  const innerW = Math.max(1, width - PAD.left - PAD.right);
  const innerH = CHART_HEIGHT - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + (t1 === t0 ? innerW / 2 : ((t - t0) / (t1 - t0)) * innerW);
  const y = (v: number) => PAD.top + ((hi - v) / (hi - lo)) * innerH;
  const ticks = [0, 1, 2, 3].map((i) => lo + ((hi - lo) * (3 - i)) / 3);
  return { times, cents, t0, t1, x, y, ticks, innerH, innerW };
}

/** The value of $100 at a trade's moment, read off the line between its neighbouring readings. */
function indexAt(times: readonly number[], cents: readonly number[], t: number): number {
  if (times.length === 0) return 10_000;
  if (t <= (times[0] as number)) return cents[0] as number;
  for (let i = 1; i < times.length; i += 1) {
    const a = times[i - 1] as number;
    const b = times[i] as number;
    if (t <= b) {
      const f = b === a ? 0 : (t - a) / (b - a);
      return (cents[i - 1] as number) + f * ((cents[i] as number) - (cents[i - 1] as number));
    }
  }
  return cents[cents.length - 1] as number;
}

/**
 * Performance over time on the account's value per unit, drawn as what
 * $100 put in at the start would be worth: one 2px line with a faint wash
 * under it, hairline gridlines, the trades as markers (a buy points up, a
 * sale down) ringed in the surface so they read over the line, a crosshair
 * with a tooltip on hover, and the same readings as a table on request.
 */
function PerformanceChart({
  series,
  marks,
  emptyAction,
  className,
}: {
  series: readonly SeriesPoint[];
  marks: readonly TradeMarkView[];
  /** UI-U2: the next action while there is nothing to draw, such as a link to deposit. */
  emptyAction?: ReactNode;
  className?: string;
}) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const id = useId();
  const geo = useMemo(() => layout(series, width), [series, width]);
  const first = series[0]?.perUnitE18 ?? "1";
  if (series.length < 2)
    return (
      <div
        className={cn(
          "flex flex-col items-center gap-3 rounded-lg border border-dashed p-6 text-center",
          className,
        )}
        data-testid="performance-empty"
      >
        <LineChart aria-hidden className="size-8 text-foreground-subtle" />
        <p className="text-sm font-medium">Not enough data yet</p>
        <p className="max-w-md text-sm text-foreground-muted">
          The line draws once the account has two readings. The platform records one every 15
          minutes and after every trade, so the first comes within 15 minutes of the first deposit.
        </p>
        {emptyAction}
      </div>
    );
  const path = series
    .map(
      (_, i) =>
        `${i === 0 ? "M" : "L"}${geo.x(geo.times[i] as number).toFixed(1)},${geo.y(geo.cents[i] as number).toFixed(1)}`,
    )
    .join(" ");
  const base = geo.y(geo.ticks[geo.ticks.length - 1] as number);
  const area = `${path} L${geo.x(geo.t1).toFixed(1)},${base.toFixed(1)} L${geo.x(geo.t0).toFixed(1)},${base.toFixed(1)} Z`;
  const startCents = geo.cents[0] as number;
  const endCents = geo.cents[geo.cents.length - 1] as number;
  const summary = `Value of $100 put in at the start: ${dollars(startCents)} on ${when(series[0]?.at ?? "")}, ${dollars(endCents)} on ${when(series[series.length - 1]?.at ?? "")}, with ${marks.length} trade${marks.length === 1 ? "" : "s"} marked.`;
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    geo.times.forEach((t, i) => {
      const d = Math.abs(geo.x(t) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  };
  const hovered = hover === null ? null : (series[hover] ?? null);
  const hoveredMarks =
    hovered === null
      ? []
      : marks.filter((m) => Math.abs(Date.parse(m.at) - Date.parse(hovered.at)) <= 60_000);
  const tipX = hovered === null ? 0 : geo.x(geo.times[hover as number] as number);
  const xLabels = [0, Math.floor((series.length - 1) / 2), series.length - 1].filter(
    (v, i, a) => a.indexOf(v) === i,
  );
  return (
    <div className={cn("flex flex-col gap-3", className)} data-testid="performance-chart">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-foreground-muted">
          What $100 put in at the start would be worth, on the account&apos;s value per unit, so
          your deposits and withdrawals never count. <span aria-hidden>▲</span> a buy,{" "}
          <span aria-hidden>▼</span> a sale.
        </span>
        <Button
          size="sm"
          variant={table ? "secondary-accent" : "secondary"}
          aria-pressed={table}
          onClick={() => setTable((t) => !t)}
          data-testid="performance-table-toggle"
        >
          <Table2 aria-hidden /> Table
        </Button>
      </div>
      <div ref={ref} className="relative w-full">
        <svg
          role="img"
          aria-label={summary}
          aria-describedby={`${id}-desc`}
          width="100%"
          height={CHART_HEIGHT}
          viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          className="block touch-none select-none"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <desc id={`${id}-desc`}>{summary}</desc>
          {geo.ticks.map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={geo.y(v)}
                y2={geo.y(v)}
                className="stroke-border"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={PAD.left - 8}
                y={geo.y(v) + 3}
                textAnchor="end"
                className="numeric fill-foreground-muted text-2xs"
              >
                {dollars(Math.round(v))}
              </text>
            </g>
          ))}
          {xLabels.map((i) => (
            <text
              key={i}
              x={geo.x(geo.times[i] as number)}
              y={CHART_HEIGHT - 8}
              textAnchor={i === 0 ? "start" : i === series.length - 1 ? "end" : "middle"}
              className="numeric fill-foreground-muted text-2xs"
            >
              {day(series[i]?.at ?? "")} {clock(series[i]?.at ?? "")}
            </text>
          ))}
          <path d={area} className="fill-primary/10" />
          <path
            d={path}
            fill="none"
            className="stroke-primary"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {marks.map((m) => {
            const t = Date.parse(m.at);
            const cx = geo.x(Math.min(Math.max(t, geo.t0), geo.t1));
            const cy = geo.y(indexAt(geo.times, geo.cents, t));
            const up = m.side === "buy";
            const points = up
              ? `${cx},${cy - 6} ${cx - 6},${cy + 5} ${cx + 6},${cy + 5}`
              : `${cx},${cy + 6} ${cx - 6},${cy - 5} ${cx + 6},${cy - 5}`;
            return (
              <polygon
                key={m.intentId}
                points={points}
                className="fill-foreground stroke-surface"
                strokeWidth="2"
                paintOrder="stroke"
                vectorEffect="non-scaling-stroke"
                data-testid="trade-mark"
                data-side={m.side}
              >
                <title>
                  {`${up ? "Bought" : "Sold"} ${formatAmount(BigInt(m.amountRaw), m.decimals, { maxFractionDigits: 6 })} ${m.symbol} for ${usdc(m.usdcE6)} USDC, ${when(m.at)}`}
                </title>
              </polygon>
            );
          })}
          {hovered ? (
            <g data-testid="crosshair">
              <line
                x1={tipX}
                x2={tipX}
                y1={PAD.top}
                y2={CHART_HEIGHT - PAD.bottom}
                className="stroke-border-strong"
                strokeWidth="1"
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={tipX}
                cy={geo.y(geo.cents[hover as number] as number)}
                r="5"
                className="fill-primary stroke-surface"
                strokeWidth="2"
              />
            </g>
          ) : null}
        </svg>
        {hovered ? (
          <div
            role="status"
            className="pointer-events-none absolute top-2 z-10 flex max-w-56 flex-col gap-0.5 rounded-md border bg-surface-overlay px-2.5 py-1.5 text-xs shadow-overlay"
            style={{ left: `${Math.min(Math.max(0, (tipX / width) * 100), 72)}%` }}
            data-testid="performance-tooltip"
          >
            <span className="text-foreground-muted">{when(hovered.at)}</span>
            <span>
              $100 is worth{" "}
              <span className="numeric text-foreground">
                {dollars(indexCents(hovered.perUnitE18, first))}
              </span>
            </span>
            {hovered.valueUsdcE6 !== null ? (
              <span className="text-foreground-muted">
                Account value <span className="numeric">{usdc(hovered.valueUsdcE6)} USDC</span>
              </span>
            ) : null}
            {hoveredMarks.map((m) => (
              <span key={m.intentId} className="text-foreground-muted">
                {m.side === "buy" ? "Bought" : "Sold"}{" "}
                <span className="numeric">
                  {formatAmount(BigInt(m.amountRaw), m.decimals, { maxFractionDigits: 6 })}{" "}
                  {m.symbol}
                </span>{" "}
                for <span className="numeric">{usdc(m.usdcE6)} USDC</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {table ? (
        <Table label="Performance readings" stack data-testid="performance-table">
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead className="text-right">$100 is worth</TableHead>
              <TableHead className="text-right">Account value</TableHead>
              <TableHead>Event</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {series.map((p, i) => {
              const at = Date.parse(p.at);
              const traded = marks.filter((m) => Math.abs(Date.parse(m.at) - at) <= 60_000);
              return (
                <TableRow key={p.at}>
                  <TableCell label="Time" className="numeric">
                    {when(p.at)}
                  </TableCell>
                  <TableCell label="$100 is worth" className="numeric text-right">
                    {dollars(geo.cents[i] as number)}
                  </TableCell>
                  <TableCell label="Account value" className="numeric text-right">
                    {p.valueUsdcE6 !== null ? `${usdc(p.valueUsdcE6)} USDC` : "unknown"}
                  </TableCell>
                  <TableCell label="Event" className="text-foreground-muted">
                    {traded.length > 0
                      ? traded
                          .map(
                            (m) =>
                              `${m.side === "buy" ? "Bought" : "Sold"} ${formatAmount(BigInt(m.amountRaw), m.decimals, { maxFractionDigits: 6 })} ${m.symbol}`,
                          )
                          .join("; ")
                      : p.reason === "trade"
                        ? "after a trade"
                        : ""}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Scores and the $100 figure                                              */
/* ---------------------------------------------------------------------- */

function ScoreTile({
  label,
  value,
  tone = "neutral",
  note,
  testId,
}: {
  label: string;
  /** Null while there is not enough data; `note` then says why. */
  value: string | null;
  tone?: "neutral" | "positive" | "negative";
  note: string;
  testId: string;
}) {
  return (
    <div
      className={TILE_CLASS}
      data-testid={testId}
      data-state={value === null ? "waiting" : "ready"}
    >
      <span className="text-xs text-foreground-muted">{label}</span>
      {value !== null ? (
        <span
          className={cn(
            "numeric text-2xl font-semibold",
            tone === "positive" && "text-positive",
            tone === "negative" && "text-negative",
          )}
        >
          {value}
        </span>
      ) : (
        <Tag tone="warning" size="md" className="self-start">
          Not enough data yet
        </Tag>
      )}
      <span className="text-xs text-foreground-muted">{note}</span>
    </div>
  );
}

/**
 * The scores as square tiles (UI-U2): the $100 figure first when given,
 * then the return since the start, the largest fall from a peak, and the
 * share of closed positions that made money, each with its "not enough data
 * yet" state and the plain reason. Two across on a phone, four on a desktop.
 */
function ScoreTiles({
  scores,
  hundred,
  className,
}: {
  scores: WindowScores;
  /** The $100 figure, as the first tile; absent for a row of three. */
  hundred?: HundredView;
  className?: string;
}) {
  const r = scores.returnSinceStart;
  const d = scores.maxDrawdown;
  const w = scores.winShare;
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-3",
        hundred ? "max-w-4xl sm:grid-cols-4" : "max-w-3xl sm:grid-cols-3",
        className,
      )}
      data-testid="score-tiles"
    >
      {hundred ? <HundredDollarTile hundred={hundred} /> : null}
      <ScoreTile
        label="Return since start"
        value={r.ok ? pct(r.bps, true) : null}
        tone={r.ok ? (r.bps > 0 ? "positive" : r.bps < 0 ? "negative" : "neutral") : "neutral"}
        note={r.ok ? `On the value per unit, since ${when(r.since)}.` : r.reason}
        testId="score-return"
      />
      <ScoreTile
        label="Largest fall from a peak"
        value={d.ok ? (d.bps > 0 ? `-${pct(d.bps)}` : pct(0)) : null}
        tone={d.ok && d.bps > 0 ? "negative" : "neutral"}
        note={
          d.ok
            ? d.bps > 0
              ? `From the peak of ${when(d.peakAt)} to ${when(d.troughAt)}.`
              : "No fall from a peak yet."
            : d.reason
        }
        testId="score-drawdown"
      />
      <ScoreTile
        label="Closed positions that made money"
        value={w.ok ? `${(w.bps / 100).toFixed(0)}%` : null}
        tone={w.ok ? (w.bps >= 5_000 ? "positive" : "negative") : "neutral"}
        note={
          w.ok ? `${w.won} of ${w.closed} closed position${w.closed === 1 ? "" : "s"}.` : w.reason
        }
        testId="score-winshare"
      />
    </div>
  );
}

/** "$100 at the start would be worth $X now", with what holding USDC would have given, as a square tile. */
function HundredDollarTile({ hundred, className }: { hundred: HundredView; className?: string }) {
  const up = hundred.ok ? Number(hundred.now) > Number(hundred.usdc) : false;
  const down = hundred.ok ? Number(hundred.now) < Number(hundred.usdc) : false;
  return (
    <div
      className={cn(TILE_CLASS, className)}
      data-testid="hundred-dollars"
      data-state={hundred.ok ? "ready" : "waiting"}
    >
      <span className="text-xs text-foreground-muted">$100 put in at the start</span>
      {hundred.ok ? (
        <span
          className={cn(
            "numeric text-2xl font-semibold",
            up && "text-positive",
            down && "text-negative",
          )}
        >
          ${hundred.now}
        </span>
      ) : (
        <Tag tone="warning" size="md" className="self-start">
          Not enough data yet
        </Tag>
      )}
      <span className="text-xs text-foreground-muted">
        {hundred.ok ? (
          <>
            with this agent since {when(hundred.since)};{" "}
            <span className="numeric">${hundred.usdc}</span> holding USDC instead
          </>
        ) : (
          hundred.reason
        )}
      </span>
    </div>
  );
}

export {
  AllocationDonut,
  AssetMakeupTable,
  HundredDollarTile,
  PerformanceChart,
  ScoreTile,
  ScoreTiles,
};
