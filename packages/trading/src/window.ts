import type { AccountMode } from "@alpha-agents/domain";
import type { Hex } from "viem";
import type { HoldingSnapshot, SnapshotRow } from "./snapshots.ts";
import type { IntentView } from "./store.ts";

/**
 * The portfolio window's rules (F-U11, D-368): what the agent holds and how
 * it is performing, in numbers the owner can trust. Performance is read on
 * the account's value per unit (the custody core's own measure: a deposit
 * mints units and a withdrawal burns them at the going value per unit, so
 * neither counts as a gain or a loss), never on the account's value. Every
 * score says "not enough data yet" while the history is too short, rather
 * than reading a number into a few minutes of life.
 */

/** A score needs at least this much history (first to last reading). */
export const MIN_HISTORY_MS = 60 * 60_000;
/** The chart carries at most this many points; longer histories are thinned evenly. */
export const MAX_CHART_POINTS = 300;
const E18 = 10n ** 18n;
const BPS = 10_000n;

export interface PerUnitPoint {
  readonly at: string;
  readonly perUnitE18: string;
  /** The account's value then, when it was readable. */
  readonly valueUsdcE6: string | null;
  readonly reason: "interval" | "trade";
}

/** What the series reads of a snapshot (or of a live reading standing in for one). */
export type PerUnitReading = Pick<SnapshotRow, "perUnit" | "createdAt" | "valueUsdc" | "reason">;

/** The per-unit readings, oldest first, from the snapshots that have one, thinned to the chart's size. */
export function perUnitSeries(rows: readonly PerUnitReading[]): PerUnitPoint[] {
  const points = [...rows]
    .filter((r) => r.perUnit !== null && r.perUnit > 0n)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((r) => ({
      at: r.createdAt.toISOString(),
      perUnitE18: (r.perUnit as bigint).toString(),
      valueUsdcE6: r.valueUsdc === null ? null : r.valueUsdc.toString(),
      reason: r.reason,
    }));
  if (points.length <= MAX_CHART_POINTS) return points;
  // Keep the first and the last, and every trade's reading; thin the rest evenly.
  const keep = new Set<number>([0, points.length - 1]);
  points.forEach((p, i) => {
    if (p.reason === "trade") keep.add(i);
  });
  const room = Math.max(0, MAX_CHART_POINTS - keep.size);
  const step = (points.length - 1) / Math.max(room, 1);
  for (let k = 0; k < room; k += 1) keep.add(Math.round(k * step));
  return points.filter((_, i) => keep.has(i));
}

export type Score<T> =
  ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string };

const spanMs = (series: readonly PerUnitPoint[]) =>
  series.length < 2
    ? 0
    : Date.parse(series[series.length - 1]?.at ?? "") - Date.parse(series[0]?.at ?? "");

function enough(
  series: readonly PerUnitPoint[],
): { readonly ok: false; readonly reason: string } | null {
  if (series.length < 2)
    return { ok: false, reason: "Not enough data yet: the account needs at least two readings." };
  if (spanMs(series) < MIN_HISTORY_MS)
    return {
      ok: false,
      reason: "Not enough data yet: the account needs at least an hour of history.",
    };
  return null;
}

/** Basis points of change from the first reading to the last. */
export function returnSinceStart(
  series: readonly PerUnitPoint[],
): Score<{ readonly bps: number; readonly since: string; readonly asOf: string }> {
  const short = enough(series);
  if (short) return short;
  const first = BigInt(series[0]?.perUnitE18 ?? "0");
  const last = BigInt(series[series.length - 1]?.perUnitE18 ?? "0");
  if (first === 0n) return { ok: false, reason: "Not enough data yet: no starting value." };
  return {
    ok: true,
    bps: Number(((last - first) * BPS) / first),
    since: series[0]?.at ?? "",
    asOf: series[series.length - 1]?.at ?? "",
  };
}

/** The largest fall from a peak to a later reading, in basis points of the peak. */
export function maxDrawdown(
  series: readonly PerUnitPoint[],
): Score<{ readonly bps: number; readonly peakAt: string; readonly troughAt: string }> {
  const short = enough(series);
  if (short) return short;
  let peak = 0n;
  let peakAt = "";
  let worst = 0n;
  let worstPeakAt = "";
  let troughAt = "";
  for (const p of series) {
    const v = BigInt(p.perUnitE18);
    if (v > peak) {
      peak = v;
      peakAt = p.at;
    }
    const dd = peak > 0n ? ((peak - v) * BPS) / peak : 0n;
    if (dd > worst) {
      worst = dd;
      worstPeakAt = peakAt;
      troughAt = p.at;
    }
  }
  return { ok: true, bps: Number(worst), peakAt: worstPeakAt, troughAt };
}

/** Two decimals, truncated (L-94). */
const dollars = (e18: bigint) => {
  const cents = e18 / 10n ** 16n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
};

/** "If you had put in $100 at the start": 100 times the value per unit's growth, beside holding USDC. */
export function hundredDollars(
  series: readonly PerUnitPoint[],
): Score<{ readonly now: string; readonly usdc: string; readonly since: string }> {
  const short = enough(series);
  if (short) return short;
  const first = BigInt(series[0]?.perUnitE18 ?? "0");
  const last = BigInt(series[series.length - 1]?.perUnitE18 ?? "0");
  if (first === 0n) return { ok: false, reason: "Not enough data yet: no starting value." };
  return {
    ok: true,
    now: dollars((100n * E18 * last) / first),
    usdc: "100.00",
    since: series[0]?.at ?? "",
  };
}

export interface TradeMark {
  readonly at: string;
  readonly intentId: string;
  readonly side: "buy" | "sell";
  /** The token bought or sold; USDC is the other side of every runner trade. */
  readonly symbol: string;
  readonly amountRaw: string;
  readonly decimals: number;
  /** The USDC paid (a buy) or received (a sale). */
  readonly usdcE6: string;
  readonly txHash: string | null;
}

/** Settled trades as chart markers, oldest first. */
export function tradeMarks(intents: readonly IntentView[]): TradeMark[] {
  return intents
    .filter((i) => i.status === "reconciled" && i.settledAt !== null)
    .map((i) => {
      const buy = i.sell === "USDC";
      return {
        at: (i.settledAt as Date).toISOString(),
        intentId: i.intentId,
        side: buy ? ("buy" as const) : ("sell" as const),
        symbol: buy ? i.buy : i.sell,
        amountRaw: (buy ? (i.amountOut ?? 0n) : i.amountIn).toString(),
        decimals: buy ? i.buyDecimals : i.sellDecimals,
        usdcE6: (buy ? i.amountIn : (i.amountOut ?? 0n)).toString(),
        txHash: i.txHash,
      };
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export interface ClosedPosition {
  readonly symbol: string;
  readonly spentUsdcE6: string;
  readonly receivedUsdcE6: string;
  readonly profitable: boolean;
}

/**
 * The positions the agent has closed: tokens it bought and has sold back out
 * of (no longer held), with what the buys cost and what the sales brought.
 */
export function closedPositions(
  intents: readonly IntentView[],
  heldSymbols: readonly string[],
): ClosedPosition[] {
  const held = new Set(heldSymbols.map((s) => s.toUpperCase()));
  const byToken = new Map<
    string,
    { bought: bigint; sold: bigint; spent: bigint; received: bigint; sales: number }
  >();
  for (const m of tradeMarks(intents)) {
    const key = m.symbol.toUpperCase();
    const t = byToken.get(key) ?? { bought: 0n, sold: 0n, spent: 0n, received: 0n, sales: 0 };
    if (m.side === "buy") {
      t.bought += BigInt(m.amountRaw);
      t.spent += BigInt(m.usdcE6);
    } else {
      t.sold += BigInt(m.amountRaw);
      t.received += BigInt(m.usdcE6);
      t.sales += 1;
    }
    byToken.set(key, t);
  }
  return [...byToken.entries()]
    .filter(([symbol, t]) => t.sales > 0 && (t.sold >= t.bought || !held.has(symbol)))
    .map(([symbol, t]) => ({
      symbol,
      spentUsdcE6: t.spent.toString(),
      receivedUsdcE6: t.received.toString(),
      profitable: t.received > t.spent,
    }));
}

/** The share of closed positions that made money, in basis points. */
export function winShare(
  closed: readonly ClosedPosition[],
): Score<{ readonly bps: number; readonly closed: number; readonly won: number }> {
  if (closed.length === 0)
    return { ok: false, reason: "Not enough data yet: no position has been closed." };
  const won = closed.filter((c) => c.profitable).length;
  return { ok: true, bps: Math.round((won * 10_000) / closed.length), closed: closed.length, won };
}

export interface HeldToken {
  /** Null when the reading did not carry the address (a v2 snapshot). */
  readonly token: Hex | null;
  readonly symbol: string;
  readonly decimals: number;
  readonly balance: bigint;
  /** What the held amount cost in USDC (the custody core's cost basis); null for USDC and on v2. */
  readonly costBasisUsdcE6: bigint | null;
  /** The value as the account values it, or null while its price is unusable. */
  readonly valueUsdcE6: bigint | null;
}

/** USDC is the cash every trade is priced in; a reading names it by symbol. */
export const isCashLine = (h: { readonly symbol: string }) => h.symbol.toUpperCase() === "USDC";

/** A held token as a snapshot or the live reading carries it. */
export function heldFromSnapshot(h: HoldingSnapshot): HeldToken {
  return {
    token: h.token,
    symbol: h.symbol,
    decimals: h.decimals,
    balance: BigInt(h.amountRaw),
    costBasisUsdcE6: h.costBasisUsdcE6 === null ? null : BigInt(h.costBasisUsdcE6),
    valueUsdcE6: h.valueUsdcE6 === null ? null : BigInt(h.valueUsdcE6),
  };
}

export interface HoldingLine {
  readonly token: Hex | null;
  readonly symbol: string;
  readonly decimals: number;
  readonly amountRaw: string;
  readonly isCash: boolean;
  readonly valueUsdcE6: string | null;
  /** Of the priced total; null while unpriced. */
  readonly shareBps: number | null;
  readonly costBasisUsdcE6: string | null;
  readonly gainUsdcE6: string | null;
  readonly gainBps: number | null;
}

/** Every held token with its value, share, cost basis and gain or loss, largest first. */
export function holdingLines(
  held: readonly HeldToken[],
  isCash: (h: HeldToken) => boolean = isCashLine,
): HoldingLine[] {
  const valued = held
    .filter((h) => h.balance > 0n)
    .map((h) => {
      const cash = isCash(h);
      return { h, isCash: cash, value: cash ? h.balance : h.valueUsdcE6 };
    });
  const total = valued.reduce((t, x) => t + (x.value ?? 0n), 0n);
  return valued
    .sort((a, b) => Number((b.value ?? -1n) - (a.value ?? -1n)))
    .map(({ h, isCash, value }) => {
      const basis = isCash ? h.balance : h.costBasisUsdcE6;
      const gain = value !== null && basis !== null && !isCash ? value - basis : null;
      return {
        token: h.token,
        symbol: h.symbol,
        decimals: h.decimals,
        amountRaw: h.balance.toString(),
        isCash,
        valueUsdcE6: value === null ? null : value.toString(),
        shareBps: value === null || total === 0n ? null : Number((value * BPS) / total),
        costBasisUsdcE6: basis === null ? null : basis.toString(),
        gainUsdcE6: gain === null ? null : gain.toString(),
        gainBps:
          gain === null || basis === null || basis === 0n ? null : Number((gain * BPS) / basis),
      };
    });
}

/**
 * The account as the orchestrator reads it now (its GET /v1/agents/:id/account,
 * F-U11): the same reading a value snapshot records, with every held token.
 */
export interface AccountReadJson {
  readonly agentId: string;
  readonly custody: "v2" | "v3";
  readonly account: Hex;
  readonly block: string;
  /** The block's time, unix seconds. */
  readonly timestamp: number;
  readonly mode: AccountMode;
  /** The account's own value, null while unusable. */
  readonly valueUsdcE6: string | null;
  readonly perUnitE18: string | null;
  readonly holdings: readonly HoldingSnapshot[];
}

/** How many snapshots the window reads, oldest first (about 40 days at the interval, plus trades). */
export const WINDOW_SNAPSHOT_LIMIT = 4_000;
/** How many intents the window reads for its trade markers. */
export const WINDOW_INTENT_LIMIT = 500;

export interface WindowJson {
  readonly agentId: string;
  readonly account: Hex | null;
  readonly custody: "v2" | "v3" | null;
  /** When the holdings were read: live from the chain, or the latest snapshot. */
  readonly asOf: {
    readonly at: string;
    readonly block: string | null;
    readonly live: boolean;
  } | null;
  /** The account's own value, null while unusable or unknown. */
  readonly totalValueUsdcE6: string | null;
  readonly holdings: readonly HoldingLine[];
  readonly series: readonly PerUnitPoint[];
  readonly marks: readonly TradeMark[];
  readonly closed: readonly ClosedPosition[];
  readonly scores: {
    readonly returnSinceStart: ReturnType<typeof returnSinceStart>;
    readonly maxDrawdown: ReturnType<typeof maxDrawdown>;
    readonly winShare: ReturnType<typeof winShare>;
  };
  readonly hundred: ReturnType<typeof hundredDollars>;
  readonly history: {
    readonly points: number;
    readonly from: string | null;
    readonly to: string | null;
    /** True when the snapshot limit cut the oldest history off. */
    readonly capped: boolean;
  };
}

/** The held tokens of a v2 snapshot, which carries balances and a value but no addresses. */
function heldFromV2(row: SnapshotRow): HeldToken[] {
  const wmonValue = row.valueUsdc === null ? null : row.valueUsdc - row.usdc;
  return [
    {
      token: null,
      symbol: "USDC",
      decimals: 6,
      balance: row.usdc,
      costBasisUsdcE6: null,
      valueUsdcE6: row.usdc,
    },
    {
      token: null,
      symbol: "WMON",
      decimals: 18,
      balance: row.wmon,
      costBasisUsdcE6: null,
      valueUsdcE6: wmonValue,
    },
  ];
}

/**
 * The window from what the platform has: the snapshots (oldest first), the
 * intents, and the live reading when the orchestrator answered. Without a
 * live reading the holdings are the latest snapshot's, dated as such.
 */
export function buildWindow(i: {
  readonly agentId: number;
  readonly rows: readonly SnapshotRow[];
  readonly intents: readonly IntentView[];
  readonly live: AccountReadJson | null;
  readonly now: Date;
}): WindowJson {
  const latest = i.rows[i.rows.length - 1] ?? null;
  const live = i.live;
  const held: HeldToken[] = live
    ? live.holdings.map(heldFromSnapshot)
    : latest?.holdings
      ? latest.holdings.map(heldFromSnapshot)
      : latest
        ? heldFromV2(latest)
        : [];
  const holdings = holdingLines(held);
  const readings: PerUnitReading[] = [...i.rows];
  if (
    live?.perUnitE18 &&
    BigInt(live.perUnitE18) > 0n &&
    (!latest || i.now.getTime() > latest.createdAt.getTime())
  )
    readings.push({
      perUnit: BigInt(live.perUnitE18),
      createdAt: i.now,
      valueUsdc: live.valueUsdcE6 === null ? null : BigInt(live.valueUsdcE6),
      reason: "interval",
    });
  const series = perUnitSeries(readings);
  const marks = tradeMarks(i.intents);
  const closed = closedPositions(
    i.intents,
    holdings.filter((h) => !h.isCash).map((h) => h.symbol),
  );
  return {
    agentId: String(i.agentId),
    account: live?.account ?? latest?.account ?? null,
    custody: live?.custody ?? latest?.custody ?? null,
    asOf: live
      ? { at: new Date(live.timestamp * 1000).toISOString(), block: live.block, live: true }
      : latest
        ? { at: latest.createdAt.toISOString(), block: latest.block.toString(), live: false }
        : null,
    totalValueUsdcE6: live ? live.valueUsdcE6 : (latest?.valueUsdc?.toString() ?? null),
    holdings,
    series,
    marks,
    closed,
    scores: {
      returnSinceStart: returnSinceStart(series),
      maxDrawdown: maxDrawdown(series),
      winShare: winShare(closed),
    },
    hundred: hundredDollars(series),
    history: {
      points: series.length,
      from: series[0]?.at ?? null,
      to: series[series.length - 1]?.at ?? null,
      capped: i.rows.length >= WINDOW_SNAPSHOT_LIMIT,
    },
  };
}
