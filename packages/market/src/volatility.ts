/**
 * Realized volatility (P3-U2): the sample standard deviation of close-to-close
 * log returns over a window, annualized by the square root of the number of
 * periods in a year. The history is DefiLlama's recorded MON price
 * (`coins.llama.fi/chart`): hourly points for the 24-hour and 7-day windows,
 * 4-hourly points for the 30-day window, because the chart serves at most 500
 * points per request. The method is named in every result.
 */
export interface PricePoint {
  /** Unix seconds. */
  readonly t: number;
  readonly price: number;
}

export const VOLATILITY_WINDOWS = {
  "24h": { seconds: 86_400, periodSeconds: 3_600, minReturns: 20 },
  "7d": { seconds: 604_800, periodSeconds: 3_600, minReturns: 150 },
  "30d": { seconds: 2_592_000, periodSeconds: 14_400, minReturns: 160 },
} as const;
export type VolatilityWindow = keyof typeof VOLATILITY_WINDOWS;

export const VOLATILITY_METHOD =
  "Sample standard deviation of close-to-close log returns, annualized by the square root of periods per year (365 days); hourly points for 24h and 7d, 4-hourly points for 30d, from DefiLlama's recorded MON price.";

const YEAR_SECONDS = 365 * 86_400;

export interface RealizedVolatility {
  /** Annualized volatility in percent; null with fewer than two returns. */
  readonly annualizedPct: number | null;
  /** Log returns used. */
  readonly returns: number;
  readonly minReturns: number;
  /** The newest point's time, unix seconds. */
  readonly asOf: number;
}

/**
 * Volatility over one window from points at that window's period. Points
 * older than the window before the newest point are ignored; non-positive
 * prices are skipped.
 */
export function realizedVolatility(
  points: readonly PricePoint[],
  window: VolatilityWindow,
): RealizedVolatility {
  const w = VOLATILITY_WINDOWS[window];
  const sorted = points
    .filter((p) => Number.isFinite(p.price) && p.price > 0)
    .slice()
    .sort((a, b) => a.t - b.t);
  const last = sorted.at(-1);
  if (!last) return { annualizedPct: null, returns: 0, minReturns: w.minReturns, asOf: 0 };
  const inWindow = sorted.filter((p) => p.t >= last.t - w.seconds);
  const r: number[] = [];
  for (let i = 1; i < inWindow.length; i++) {
    const a = inWindow[i - 1] as PricePoint;
    const b = inWindow[i] as PricePoint;
    r.push(Math.log(b.price / a.price));
  }
  // Fewer than minReturns still gives a number; the caller flags it as THIN_HISTORY.
  if (r.length < 2)
    return { annualizedPct: null, returns: r.length, minReturns: w.minReturns, asOf: last.t };
  const mean = r.reduce((s, x) => s + x, 0) / r.length;
  const variance = r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1);
  const perYear = YEAR_SECONDS / w.periodSeconds;
  return {
    annualizedPct: Math.sqrt(variance) * Math.sqrt(perYear) * 100,
    returns: r.length,
    minReturns: w.minReturns,
    asOf: last.t,
  };
}
