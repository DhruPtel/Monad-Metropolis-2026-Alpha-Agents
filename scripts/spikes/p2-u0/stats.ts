/** Pure helpers for the P2-U0 report: feed update statistics, deviation sampling, pool prices. */

export interface Point {
  /** Unix seconds. */
  readonly t: number;
  readonly price: number;
}

/** Nearest-rank percentile of an unsorted list; `p` in [0, 100]. NaN for an empty list. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] as number;
}

export interface StaleShare {
  readonly thresholdSeconds: number;
  /** Share of the window during which the latest answer was at least this old. */
  readonly shareOfTime: number;
  /** Number of gaps longer than the threshold. */
  readonly episodes: number;
}

export interface FeedStats {
  readonly updates: number;
  readonly windowSeconds: number;
  readonly gapSeconds: { min: number; p50: number; p90: number; p99: number; max: number };
  /** Absolute change per update in basis points. */
  readonly changeBps: { p5: number; p50: number; p95: number; max: number };
  /** Updates that came at least 95% of the published heartbeat after the previous one. */
  readonly heartbeatUpdates: number;
  /** Smallest change among updates that came well before the heartbeat (deviation-triggered). */
  readonly minDeviationTriggeredChangeBps: number | null;
  /** p5 of the same set: a robust estimate of the deviation threshold. */
  readonly p5DeviationTriggeredChangeBps: number | null;
  readonly gapsLongerThanHeartbeat: number;
  readonly stale: readonly StaleShare[];
}

/**
 * Statistics of one feed's updates inside [start, end]. `updates` are sorted by time; the gap
 * before the first update is measured from `start` only if `ageAtStart` is given (the age of the
 * answer that was current at the window start), and the last gap runs to `end`.
 */
export function feedStats(
  updates: readonly Point[],
  start: number,
  end: number,
  heartbeatSeconds: number,
  thresholds: readonly number[],
): FeedStats {
  const gaps: number[] = [];
  const changes: number[] = [];
  const deviationTriggered: number[] = [];
  let heartbeatUpdates = 0;
  for (let i = 1; i < updates.length; i += 1) {
    const prev = updates[i - 1] as Point;
    const cur = updates[i] as Point;
    const gap = cur.t - prev.t;
    const change = (Math.abs(cur.price - prev.price) / prev.price) * 10_000;
    gaps.push(gap);
    changes.push(change);
    if (gap >= 0.95 * heartbeatSeconds) heartbeatUpdates += 1;
    else deviationTriggered.push(change);
  }
  // Time intervals over which age grows: window start to first update, between updates, last to end.
  const intervals: number[] = [];
  if (updates.length > 0) {
    intervals.push(Math.max(0, (updates[0] as Point).t - start));
    intervals.push(...gaps);
    intervals.push(Math.max(0, end - (updates[updates.length - 1] as Point).t));
  } else intervals.push(end - start);
  const window = end - start;
  const stale = thresholds.map((T) => ({
    thresholdSeconds: T,
    shareOfTime: intervals.reduce((s, g) => s + Math.max(0, g - T), 0) / window,
    episodes: intervals.filter((g) => g > T).length,
  }));
  return {
    updates: updates.length,
    windowSeconds: window,
    gapSeconds: {
      min: percentile(gaps, 0),
      p50: percentile(gaps, 50),
      p90: percentile(gaps, 90),
      p99: percentile(gaps, 99),
      max: gaps.length ? Math.max(...gaps) : Number.NaN,
    },
    changeBps: {
      p5: percentile(changes, 5),
      p50: percentile(changes, 50),
      p95: percentile(changes, 95),
      max: changes.length ? Math.max(...changes) : Number.NaN,
    },
    heartbeatUpdates,
    minDeviationTriggeredChangeBps: deviationTriggered.length
      ? Math.min(...deviationTriggered)
      : null,
    p5DeviationTriggeredChangeBps: deviationTriggered.length
      ? percentile(deviationTriggered, 5)
      : null,
    gapsLongerThanHeartbeat: gaps.filter((g) => g > heartbeatSeconds * 1.05).length,
    stale,
  };
}

/** The value of a step series at time t: the last point at or before t, or undefined. */
function stepAt(series: readonly Point[], t: number, from: number): { idx: number; p?: Point } {
  let idx = from;
  while (idx + 1 < series.length && (series[idx + 1] as Point).t <= t) idx += 1;
  const p = series[idx];
  return p && p.t <= t ? { idx, p } : { idx };
}

export interface DeviationSample {
  readonly t: number;
  /** (pool - oracle) / oracle in basis points, signed. */
  readonly bps: number;
  /** Seconds since the pool's last trade. */
  readonly poolAge: number;
}

/** Samples the pool against the oracle every `step` seconds over [start, end]. */
export function sampleDeviation(
  oracle: readonly Point[],
  pool: readonly Point[],
  start: number,
  end: number,
  step: number,
): DeviationSample[] {
  const out: DeviationSample[] = [];
  let oi = 0;
  let pi = 0;
  for (let t = start; t <= end; t += step) {
    const o = stepAt(oracle, t, oi);
    const p = stepAt(pool, t, pi);
    oi = o.idx;
    pi = p.idx;
    if (!o.p || !p.p) continue;
    out.push({ t, bps: ((p.p.price - o.p.price) / o.p.price) * 10_000, poolAge: t - p.p.t });
  }
  return out;
}

export interface DeviationSummary {
  readonly samples: number;
  readonly stepSeconds: number;
  readonly shareAbove: Record<string, number>;
  readonly absBps: { p50: number; p90: number; p99: number; max: number };
  readonly signedBps: { min: number; max: number; mean: number };
  /** Longest unbroken run of samples above 2%, in seconds. */
  readonly longestRunAbove200Seconds: number;
  readonly poolAgeSeconds: { p50: number; p90: number };
}

export function summarizeDeviation(
  samples: readonly DeviationSample[],
  stepSeconds: number,
): DeviationSummary {
  const abs = samples.map((s) => Math.abs(s.bps));
  const shareAbove: Record<string, number> = {};
  for (const b of [50, 100, 200, 500])
    shareAbove[`${b}bps`] = samples.length ? abs.filter((a) => a > b).length / samples.length : 0;
  let run = 0;
  let longest = 0;
  for (const a of abs) {
    run = a > 200 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const signed = samples.map((s) => s.bps);
  return {
    samples: samples.length,
    stepSeconds,
    shareAbove,
    absBps: {
      p50: percentile(abs, 50),
      p90: percentile(abs, 90),
      p99: percentile(abs, 99),
      max: abs.length ? Math.max(...abs) : Number.NaN,
    },
    signedBps: {
      min: signed.length ? Math.min(...signed) : Number.NaN,
      max: signed.length ? Math.max(...signed) : Number.NaN,
      mean: signed.length ? signed.reduce((s, x) => s + x, 0) / signed.length : Number.NaN,
    },
    longestRunAbove200Seconds: longest * stepSeconds,
    poolAgeSeconds: {
      p50: percentile(
        samples.map((s) => s.poolAge),
        50,
      ),
      p90: percentile(
        samples.map((s) => s.poolAge),
        90,
      ),
    },
  };
}

/**
 * Price of token0 in units of token1 from a Uniswap sqrtPriceX96, adjusted for decimals.
 * Float precision is enough for a report; never use this for amounts that get signed.
 */
export function priceFromSqrtX96(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return ratio * ratio * 10 ** (decimals0 - decimals1);
}

/** Signed slippage in basis points of an actual output against an expected output. */
export function shortfallBps(actual: number, expected: number): number {
  return (1 - actual / expected) * 10_000;
}
