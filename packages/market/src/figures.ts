/**
 * Every market number the agent or the platform reads is a Figure: the value,
 * the source it came from, when the source says it was true (`asOf`), and any
 * warning. Two sources for the same quantity stay two figures, each with its
 * source, never merged (BUILD_PLAN 8 lesson 2). A value outside its plausible
 * range is refused at the source (lesson 1): its value is null, the warning
 * says why, and the refusal is logged.
 */

/** Where a figure came from. */
export const MARKET_SOURCES = [
  "coinmarketcap",
  "defillama",
  "chainlink",
  "uniswap_v4",
  "computed",
] as const;
export type MarketSource = (typeof MARKET_SOURCES)[number];

export const WARNING_CODES = [
  /** The value was outside its plausible range and is not served. */
  "REFUSED_OUT_OF_RANGE",
  /** The source answered without this value. */
  "MISSING",
  /** Older than the source's freshness rule. */
  "STALE",
  /** Further from another source's figure for the same quantity than the tolerance. */
  "SOURCES_DISAGREE",
  /** Computed from fewer points than the method asks for. */
  "THIN_HISTORY",
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export interface FigureWarning {
  readonly code: WarningCode;
  /** One plain sentence, written by the platform, never upstream text. */
  readonly message: string;
}

export interface Figure<T = number> {
  readonly value: T | null;
  readonly source: MarketSource;
  /** ISO time the source says the value was true. */
  readonly asOf: string;
  readonly warnings: readonly FigureWarning[];
}

export const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

/** A figure with one more warning. */
export function warn<T>(f: Figure<T>, w: FigureWarning): Figure<T> {
  return { ...f, warnings: [...f.warnings, w] };
}
