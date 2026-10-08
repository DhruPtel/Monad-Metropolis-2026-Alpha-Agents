import { type Figure, type FigureWarning, type MarketSource, iso, warn } from "./figures.ts";

/**
 * Plausibility guards (P3-U2, BUILD_PLAN 8 lesson 1). Each numeric field has
 * the range a real value must fall in. Out of range, the figure is refused:
 * null, with REFUSED_OUT_OF_RANGE, logged, never served. Within range but old,
 * it is served with STALE. Two sources for one quantity that disagree beyond
 * the tolerance are both served, each with SOURCES_DISAGREE. The ranges are
 * deliberately wide: they stop broken data (a zero, a decimals slip, a unit
 * mix-up), not market moves (A-56).
 */
export const PLAUSIBLE = {
  monPriceUsd: [0.0001, 100],
  usdcPriceUsd: [0.9, 1.1],
  change24hPct: [-95, 1_000],
  volume24hUsd: [0, 100_000_000_000],
  marketCapUsd: [100_000, 1_000_000_000_000],
  chainTvlUsd: [1_000, 1_000_000_000_000],
  protocolTvlUsd: [0, 1_000_000_000_000],
  dexVolume24hUsd: [0, 100_000_000_000],
  apyPct: [0, 1_000],
  volatilityAnnualPct: [0, 2_000],
  priceImpactBps: [0, 10_000],
  poolLiquidity: [0, 1e40],
} as const satisfies Record<string, readonly [number, number]>;
export type PlausibleField = keyof typeof PLAUSIBLE;

/** A refusal for the log; the caller decides where it goes. */
export interface Refusal {
  readonly field: PlausibleField;
  readonly source: MarketSource;
  readonly value: unknown;
  readonly range: readonly [number, number];
}

export interface GuardContext {
  /** Unix seconds now. */
  readonly now: number;
  /** Where refusals are logged. */
  readonly onRefuse?: (r: Refusal) => void;
}

/**
 * One guarded figure. `maxAgeSeconds` is the source's freshness rule: older
 * than that and the figure carries STALE.
 */
export function guard(
  field: PlausibleField,
  raw: unknown,
  source: MarketSource,
  asOfUnix: number,
  maxAgeSeconds: number,
  ctx: GuardContext,
): Figure {
  const base: Figure = { value: null, source, asOf: iso(asOfUnix), warnings: [] };
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === ""))
    return warn(base, { code: "MISSING", message: `${source} did not give this value.` });
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  const range = PLAUSIBLE[field];
  if (!Number.isFinite(value) || value < range[0] || value > range[1]) {
    ctx.onRefuse?.({ field, source, value: raw, range });
    return warn(base, {
      code: "REFUSED_OUT_OF_RANGE",
      message: `${source} gave a value outside the plausible range ${range[0]} to ${range[1]}, so it is not used.`,
    });
  }
  const age = ctx.now - asOfUnix;
  const fig: Figure = { ...base, value };
  return age > maxAgeSeconds
    ? warn(fig, {
        code: "STALE",
        message: `${Math.round(age / 60)} minutes old, past this source's ${Math.round(maxAgeSeconds / 60)}-minute freshness rule.`,
      })
    : fig;
}

/**
 * Two sources for one quantity: both stay as they are, and each carries
 * SOURCES_DISAGREE when they differ by more than `toleranceBps` of the second.
 */
export function crossCheck(a: Figure, b: Figure, toleranceBps: number): readonly [Figure, Figure] {
  if (a.value === null || b.value === null || b.value === 0) return [a, b];
  const diffBps = (Math.abs(a.value - b.value) / Math.abs(b.value)) * 10_000;
  if (diffBps <= toleranceBps) return [a, b];
  const w = (other: Figure): FigureWarning => ({
    code: "SOURCES_DISAGREE",
    message: `${(diffBps / 100).toFixed(2)}% away from ${other.source}'s figure, past the ${(toleranceBps / 100).toFixed(2)}% tolerance; both are shown.`,
  });
  return [warn(a, w(b)), warn(b, w(a))];
}
