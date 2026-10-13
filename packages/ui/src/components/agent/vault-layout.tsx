"use client";

import { formatAmount } from "@alpha-agents/domain";
import { LineChart } from "lucide-react";
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
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Tag } from "../ui/tag";
import { TILE_CLASS, type TileTone } from "./tiles";
import type { AssetRow, SeriesPoint } from "./window";

/**
 * UX-U1: the portfolio and the vault laid out as a vault page (the row of
 * top tiles, a left panel of tabs, a right chart, the bottom tabs of dense
 * tables), adapted for spot holdings. The pages compose these from the
 * reads they already have: the components format and draw, never compute a
 * figure the platform did not give, except the chart's own arithmetic on
 * the series it is handed.
 */

const usdc2 = (e6: bigint | string | number) =>
  (Number(e6) / 1e6).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const signedUsdc = (e6: bigint | string | number) =>
  `${Number(e6) > 0 ? "+" : Number(e6) < 0 ? "-" : ""}${usdc2(Math.abs(Number(e6)))}`;
const pct = (bps: number, signed = false) =>
  `${signed && bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;
const toneOf = (n: number): TileTone => (n > 0 ? "positive" : n < 0 ? "negative" : "neutral");
const toneClass: Record<TileTone, string> = {
  neutral: "text-foreground",
  positive: "text-positive",
  negative: "text-negative",
  warning: "text-warning",
  accent: "text-primary",
};

// ---------------------------------------------------------------------------
// The top tiles

export interface StatTile {
  readonly label: string;
  /** The figure, formatted by the page; null while unknown, with `note` saying why. */
  readonly value: string | null;
  readonly note?: string;
  readonly tone?: TileTone;
  readonly testId?: string;
}

/** The row of summary tiles at the top of a vault-style page: four read best, two to five fit. */
function StatTileRow({ tiles, className }: { tiles: readonly StatTile[]; className?: string }) {
  return (
    <div
      className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}
      data-testid="stat-tile-row"
    >
      {tiles.map((t) => (
        <div
          key={t.label}
          className={TILE_CLASS}
          data-testid={t.testId ?? "stat-tile"}
          data-state={t.value === null ? "waiting" : "ready"}
        >
          <span className="text-xs tracking-wide text-foreground-muted uppercase">{t.label}</span>
          <span
            className={cn(
              "numeric text-2xl font-semibold",
              t.value === null ? "text-foreground-muted" : toneClass[t.tone ?? "neutral"],
            )}
          >
            {t.value ?? "–"}
          </span>
          {t.note ? <span className="text-xs text-foreground-muted">{t.note}</span> : null}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A card of tabs

export interface PanelTab {
  readonly id: string;
  readonly label: string;
  readonly content: ReactNode;
}

/**
 * A card whose body is one of several tabs: the left panel (About, the
 * agent's performance, yours) and the bottom ledger (balances, positions,
 * history). The triggers wrap at phone width.
 */
function TabbedPanel({
  tabs,
  defaultTab,
  title,
  description,
  testId,
  className,
}: {
  tabs: readonly PanelTab[];
  defaultTab?: string;
  title?: string;
  description?: ReactNode;
  testId?: string;
  className?: string;
}) {
  const first = defaultTab ?? tabs[0]?.id ?? "";
  return (
    <Card className={cn("flex flex-col", className)} data-testid={testId ?? "tabbed-panel"}>
      {title ? (
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
      ) : null}
      <CardContent className={cn("flex flex-1 flex-col gap-4", title ? "" : "pt-6")}>
        <Tabs defaultValue={first}>
          <TabsList className="flex h-auto flex-wrap justify-start gap-1">
            {tabs.map((t) => (
              <TabsTrigger key={t.id} value={t.id} data-testid={`tab-${t.id}`}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((t) => (
            <TabsContent key={t.id} value={t.id} className="pt-4" data-testid={`panel-${t.id}`}>
              {t.content}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The value and PnL chart

export type ChartMode = "value" | "pnl";
export type ChartRange = "7d" | "30d" | "all";
const RANGE_MS: Record<ChartRange, number | null> = {
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  all: null,
};
const CHART_HEIGHT = 240;
const PAD = { left: 56, right: 12, top: 12, bottom: 28 };
const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const day = (iso: string) => iso.slice(5, 10);

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(Math.max(240, Math.floor(el.getBoundingClientRect().width)));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo)) return [lo];
  const span = hi - lo;
  const rough = span / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out.length > 0 ? out : [lo, hi];
}

/**
 * The account's value in USDC over time, or its PnL (the value less what
 * was deposited net of withdrawals, as the page gives it), over the last
 * 7 days, 30 days or everything recorded. Points without a recorded value
 * are skipped. One 2px line with a wash, hairline gridlines, a crosshair on
 * hover; the readings as the SVG's own description for a screen reader.
 */
function AccountValueChart({
  series,
  principalUsdcE6,
  defaultMode = "value",
  defaultRange = "30d",
  emptyAction,
  className,
}: {
  series: readonly SeriesPoint[];
  /** What the PnL is measured against; null hides the PnL mode. */
  principalUsdcE6: string | null;
  defaultMode?: ChartMode;
  defaultRange?: ChartRange;
  emptyAction?: ReactNode;
  className?: string;
}) {
  const [mode, setMode] = useState<ChartMode>(principalUsdcE6 === null ? "value" : defaultMode);
  const [range, setRange] = useState<ChartRange>(defaultRange);
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const principal = principalUsdcE6 === null ? null : Number(principalUsdcE6) / 1e6;
  const points = useMemo(() => {
    const valued = series.filter((p) => p.valueUsdcE6 !== null);
    const last = valued[valued.length - 1];
    const cutoff = RANGE_MS[range];
    const from = cutoff === null || !last ? null : Date.parse(last.at) - cutoff;
    return valued
      .filter((p) => from === null || Date.parse(p.at) >= from)
      .map((p) => {
        const value = Number(p.valueUsdcE6) / 1e6;
        return {
          at: p.at,
          t: Date.parse(p.at),
          y: mode === "pnl" && principal !== null ? value - principal : value,
        };
      });
  }, [series, range, mode, principal]);
  const geo = useMemo(() => {
    const t0 = points[0]?.t ?? 0;
    const t1 = points[points.length - 1]?.t ?? 1;
    const ys = points.map((p) => p.y);
    const lo = Math.min(0, ...ys);
    const hi = Math.max(...ys, lo + 1);
    const ticks = niceTicks(lo, hi);
    const yLo = Math.min(lo, ticks[0] ?? lo);
    const yHi = Math.max(hi, ticks[ticks.length - 1] ?? hi);
    const x = (t: number) =>
      PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * (width - PAD.left - PAD.right);
    const y = (v: number) =>
      PAD.top + (1 - (v - yLo) / Math.max(1e-9, yHi - yLo)) * (CHART_HEIGHT - PAD.top - PAD.bottom);
    return { t0, t1, x, y, ticks, base: y(Math.max(yLo, Math.min(0, yHi))) };
  }, [points, width]);
  const controls = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex gap-1" role="group" aria-label="What the chart shows">
        <Button
          size="sm"
          variant={mode === "value" ? "secondary-accent" : "secondary"}
          aria-pressed={mode === "value"}
          onClick={() => setMode("value")}
          data-testid="chart-mode-value"
        >
          Account value
        </Button>
        <Button
          size="sm"
          variant={mode === "pnl" ? "secondary-accent" : "secondary"}
          aria-pressed={mode === "pnl"}
          disabled={principal === null}
          onClick={() => setMode("pnl")}
          data-testid="chart-mode-pnl"
        >
          PnL
        </Button>
      </div>
      <div className="flex gap-1" role="group" aria-label="Time range">
        {(["7d", "30d", "all"] as const).map((r) => (
          <Button
            key={r}
            size="sm"
            variant={range === r ? "secondary-accent" : "secondary"}
            aria-pressed={range === r}
            onClick={() => setRange(r)}
            data-testid={`chart-range-${r}`}
          >
            {r === "all" ? "All" : r.toUpperCase()}
          </Button>
        ))}
      </div>
    </div>
  );
  if (points.length < 2)
    return (
      <div className={cn("flex flex-col gap-3", className)} data-testid="account-chart">
        {controls}
        <div
          className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-6 text-center"
          data-testid="account-chart-empty"
        >
          <LineChart aria-hidden className="size-8 text-foreground-subtle" />
          <p className="text-sm font-medium">Not enough readings in this range</p>
          <p className="max-w-md text-sm text-foreground-muted">
            The platform records a reading every 15 minutes and after every trade; the line draws
            from the second one. Try a longer range, or wait for the next reading.
          </p>
          {emptyAction}
        </div>
      </div>
    );
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${geo.x(p.t).toFixed(1)},${geo.y(p.y).toFixed(1)}`)
    .join(" ");
  const area = `${path} L${geo.x(geo.t1).toFixed(1)},${geo.base.toFixed(1)} L${geo.x(geo.t0).toFixed(1)},${geo.base.toFixed(1)} Z`;
  const first = points[0] as (typeof points)[number];
  const last = points[points.length - 1] as (typeof points)[number];
  const label = mode === "pnl" ? "PnL" : "Account value";
  const summary = `${label}: ${usdc2(first.y * 1e6)} USDC on ${when(first.at)}, ${usdc2(last.y * 1e6)} USDC on ${when(last.at)}, over ${points.length} readings.`;
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    points.forEach((p, i) => {
      const d = Math.abs(geo.x(p.t) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  };
  const hovered = hover === null ? null : (points[hover] ?? null);
  const xLabels = [0, Math.floor((points.length - 1) / 2), points.length - 1].filter(
    (v, i, a) => a.indexOf(v) === i,
  );
  const lineClass =
    mode === "pnl" ? (last.y < 0 ? "stroke-negative" : "stroke-positive") : "stroke-primary";
  const washClass =
    mode === "pnl" ? (last.y < 0 ? "fill-negative/10" : "fill-positive/10") : "fill-primary/10";
  return (
    <div
      className={cn("flex flex-col gap-3", className)}
      data-testid="account-chart"
      data-mode={mode}
      data-range={range}
    >
      {controls}
      <p className="text-xs text-foreground-muted">
        {mode === "pnl"
          ? "The account's value less what you have put in, net of withdrawals, in USDC."
          : "The account's value in USDC at each reading, your deposits and withdrawals included."}
      </p>
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
                {v.toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </text>
            </g>
          ))}
          {xLabels.map((i) => (
            <text
              key={i}
              x={geo.x((points[i] as (typeof points)[number]).t)}
              y={CHART_HEIGHT - 8}
              textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
              className="numeric fill-foreground-muted text-2xs"
            >
              {day((points[i] as (typeof points)[number]).at)}
            </text>
          ))}
          <path d={area} className={washClass} />
          <path
            d={path}
            fill="none"
            className={lineClass}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {hovered ? (
            <g data-testid="account-chart-crosshair">
              <line
                x1={geo.x(hovered.t)}
                x2={geo.x(hovered.t)}
                y1={PAD.top}
                y2={CHART_HEIGHT - PAD.bottom}
                className="stroke-foreground-muted"
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={geo.x(hovered.t)}
                cy={geo.y(hovered.y)}
                r="4"
                className="fill-surface stroke-foreground"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ) : null}
        </svg>
        {hovered ? (
          <div
            className="pointer-events-none absolute top-2 rounded-md border border-border bg-surface px-2 py-1 text-xs shadow-sm"
            style={{
              left: `${Math.min(92, Math.max(0, (geo.x(hovered.t) / width) * 100))}%`,
              transform: "translateX(-50%)",
            }}
            data-testid="account-chart-tooltip"
          >
            <span className="numeric font-medium">
              {mode === "pnl" ? signedUsdc(hovered.y * 1e6) : usdc2(hovered.y * 1e6)} USDC
            </span>
            <span className="ml-2 text-foreground-muted">{when(hovered.at)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The dense tables

export interface PositionRow extends AssetRow {
  /** The chain the position is on, shown as a tag ("Monad", "Base"). */
  readonly chain?: string;
}

const amountText = (r: AssetRow) =>
  formatAmount(BigInt(r.amountRaw), r.decimals, { maxFractionDigits: 6 });
const unitPrice = (usdcE6: string | null, r: AssetRow): number | null => {
  if (usdcE6 === null) return null;
  const units = Number(BigInt(r.amountRaw)) / 10 ** r.decimals;
  return units > 0 ? Number(usdcE6) / 1e6 / units : null;
};
const price = (v: number | null) =>
  v === null
    ? "–"
    : v.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: v < 1 ? 6 : 2,
      });

/**
 * The positions as a dense table: the token with its chain, the amount, the
 * value, the entry price (the cost basis per unit), the current price (the
 * value per unit), and the PnL in dollars and percent, green or red. Cash
 * rows show the amount and value only.
 */
function PositionsTable({
  rows,
  chain,
  className,
}: {
  rows: readonly PositionRow[];
  /** The chain for every row that names none. */
  chain?: string;
  className?: string;
}) {
  const held = rows.filter((r) => BigInt(r.amountRaw) > 0n);
  if (held.length === 0)
    return (
      <p className="text-sm text-foreground-muted" data-testid="positions-table-empty">
        No positions yet.
      </p>
    );
  return (
    <Table label="Positions" stack className={className} data-testid="positions-table">
      <TableHeader>
        <TableRow>
          <TableHead>Token</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead className="text-right">Entry price</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead className="text-right">PnL</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {held.map((r) => {
          const gain = r.gainUsdcE6 === null ? null : Number(r.gainUsdcE6);
          const tone = gain === null ? "neutral" : toneOf(gain);
          const chainName = r.chain ?? chain;
          return (
            <TableRow key={r.symbol} data-testid="position-row" data-symbol={r.symbol}>
              <TableCell className="font-medium">
                <span className="flex items-center gap-2">
                  {r.symbol}
                  {chainName ? (
                    <Tag tone="neutral" data-testid="position-chain">
                      {chainName}
                    </Tag>
                  ) : null}
                  {r.isCash ? <Tag tone="neutral">Cash</Tag> : null}
                </span>
              </TableCell>
              <TableCell className="numeric text-right">{amountText(r)}</TableCell>
              <TableCell className="numeric text-right">
                {r.valueUsdcE6 === null ? "no usable price" : `${usdc2(r.valueUsdcE6)} USDC`}
              </TableCell>
              <TableCell className="numeric text-right">
                {r.isCash ? "–" : price(unitPrice(r.costBasisUsdcE6, r))}
              </TableCell>
              <TableCell className="numeric text-right">
                {r.isCash ? "–" : price(unitPrice(r.valueUsdcE6, r))}
              </TableCell>
              <TableCell className={cn("numeric text-right", toneClass[tone])} data-tone={tone}>
                {r.isCash || gain === null
                  ? "–"
                  : `${signedUsdc(gain)}${r.gainBps === null ? "" : ` (${pct(r.gainBps, true)})`}`}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** The balances: every token the account holds with its amount, value and share. */
function BalancesTable({
  rows,
  chain,
  className,
}: {
  rows: readonly PositionRow[];
  chain?: string;
  className?: string;
}) {
  const held = rows.filter((r) => BigInt(r.amountRaw) > 0n);
  if (held.length === 0)
    return (
      <p className="text-sm text-foreground-muted" data-testid="balances-table-empty">
        Nothing held yet.
      </p>
    );
  return (
    <Table label="Balances" stack className={className} data-testid="balances-table">
      <TableHeader>
        <TableRow>
          <TableHead>Token</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead className="text-right">Share</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {held.map((r) => (
          <TableRow key={r.symbol} data-testid="balance-row" data-symbol={r.symbol}>
            <TableCell className="font-medium">
              <span className="flex items-center gap-2">
                {r.symbol}
                {(r.chain ?? chain) ? <Tag tone="neutral">{r.chain ?? chain}</Tag> : null}
              </span>
            </TableCell>
            <TableCell className="numeric text-right">{amountText(r)}</TableCell>
            <TableCell className="numeric text-right">
              {r.valueUsdcE6 === null ? "no usable price" : `${usdc2(r.valueUsdcE6)} USDC`}
            </TableCell>
            <TableCell className="numeric text-right">
              {r.shareBps === null ? "–" : pct(r.shareBps)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** A one-line reading of a series for the top tiles: the change over the last 30 days, in bps. */
export function monthReturnBps(series: readonly SeriesPoint[]): number | null {
  const last = series[series.length - 1];
  if (!last) return null;
  const from = Date.parse(last.at) - 30 * 86_400_000;
  const window = series.filter((p) => Date.parse(p.at) >= from);
  const first = window[0];
  if (!first || first === last) return null;
  const a = Number(BigInt(first.perUnitE18)) / 1e18;
  const b = Number(BigInt(last.perUnitE18)) / 1e18;
  return a > 0 ? Math.round(((b - a) / a) * 10_000) : null;
}

export { AccountValueChart, BalancesTable, PositionsTable, StatTileRow, TabbedPanel };
