import { type Figure, iso } from "./figures.ts";
import { type GuardContext, guard } from "./guards.ts";
import { cleanText } from "./text.ts";
import type { PricePoint } from "./volatility.ts";

/**
 * DefiLlama (no key): Monad's chain TVL and its history, the protocols on
 * Monad by TVL, Monad's yield pools, Monad's DEX volumes, and the recorded MON
 * price history volatility is computed from. The `coingecko:monad` in the
 * chart URL is DefiLlama's own coin identifier; no CoinGecko API is called.
 */
export const LLAMA_URLS = {
  chainTvl: "https://api.llama.fi/v2/historicalChainTvl/Monad",
  protocols: "https://api.llama.fi/protocols",
  yields: "https://yields.llama.fi/pools",
  dexVolumes:
    "https://api.llama.fi/overview/dexs/Monad?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true",
  chartHourly: "https://coins.llama.fi/chart/coingecko:monad?span=169&period=1h",
  chart4h: "https://coins.llama.fi/chart/coingecko:monad?span=181&period=4h",
} as const;

/** Freshness rules: TVL history is daily, so two days; the hourly price chart two hours. */
export const LLAMA_MAX_AGE_SECONDS = {
  chainTvl: 2 * 86_400,
  chartHourly: 2 * 3_600,
  chart4h: 8 * 3_600,
} as const;

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN);

export interface ChainTvl {
  readonly tvlUsd: Figure;
  readonly change7dPct: Figure;
  /** Daily points for the last 30 days, oldest first. */
  readonly history: readonly { readonly date: string; readonly tvlUsd: number }[];
}

export function chainTvl(body: unknown, ctx: GuardContext): ChainTvl {
  const rows = (Array.isArray(body) ? body : [])
    .map((r) => ({ t: num((r as { date?: unknown }).date), v: num((r as { tvl?: unknown }).tvl) }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.v))
    .sort((a, b) => a.t - b.t);
  const last = rows.at(-1);
  const weekAgo = last ? [...rows].reverse().find((r) => r.t <= last.t - 7 * 86_400) : undefined;
  const tvl = guard(
    "chainTvlUsd",
    last?.v,
    "defillama",
    last?.t ?? ctx.now,
    LLAMA_MAX_AGE_SECONDS.chainTvl,
    ctx,
  );
  const change =
    last && weekAgo && weekAgo.v > 0 ? ((last.v - weekAgo.v) / weekAgo.v) * 100 : undefined;
  return {
    tvlUsd: tvl,
    change7dPct: guard(
      "change24hPct",
      change,
      "defillama",
      last?.t ?? ctx.now,
      LLAMA_MAX_AGE_SECONDS.chainTvl,
      ctx,
    ),
    history:
      tvl.value === null ? [] : rows.slice(-30).map((r) => ({ date: iso(r.t), tvlUsd: r.v })),
  };
}

export interface MonadProtocol {
  readonly name: string;
  readonly category: string | null;
  readonly tvlUsd: Figure;
}

/** The top protocols by their TVL on Monad. Names are capped and stripped (cleanText). */
export function monadProtocols(
  body: unknown,
  fetchedAtUnix: number,
  limit: number,
  ctx: GuardContext,
): MonadProtocol[] {
  const all = Array.isArray(body) ? body : [];
  return all
    .map((p) => p as { name?: unknown; category?: unknown; chainTvls?: Record<string, unknown> })
    .filter((p) => p.chainTvls && num(p.chainTvls.Monad) > 0)
    .sort((a, b) => num(b.chainTvls?.Monad) - num(a.chainTvls?.Monad))
    .slice(0, limit)
    .flatMap((p) => {
      const name = cleanText(p.name);
      if (!name) return [];
      return [
        {
          name,
          category: cleanText(p.category, 32),
          // The listing is current at the moment it is fetched; it carries no time of its own.
          tvlUsd: guard(
            "protocolTvlUsd",
            p.chainTvls?.Monad,
            "defillama",
            fetchedAtUnix,
            3_600,
            ctx,
          ),
        },
      ];
    });
}

export interface MonadYield {
  readonly pool: string;
  readonly project: string;
  readonly symbol: string;
  readonly stablecoin: boolean;
  readonly tvlUsd: Figure;
  readonly apyPct: Figure;
  readonly apyBasePct: Figure;
  readonly apyRewardPct: Figure;
}

const POOL_ID = /^[0-9a-f-]{8,64}$/i;

/** Monad's yield pools by TVL, optionally only those whose symbol names an asset. */
export function monadYields(
  body: unknown,
  fetchedAtUnix: number,
  o: { limit: number; asset: "USDC" | "MON" | null },
  ctx: GuardContext,
): MonadYield[] {
  const data = (body as { data?: unknown[] } | null)?.data ?? [];
  const g = (field: "protocolTvlUsd" | "apyPct", v: unknown) =>
    guard(field, v, "defillama", fetchedAtUnix, 3_600, ctx);
  return data
    .map((p) => p as Record<string, unknown>)
    .filter((p) => p.chain === "Monad" && typeof p.pool === "string" && POOL_ID.test(p.pool))
    .filter((p) => {
      if (!o.asset) return true;
      const sym = String(p.symbol ?? "").toUpperCase();
      return o.asset === "MON" ? /(^|[-_ ])W?MON([-_ ]|$)/.test(sym) : sym.includes("USDC");
    })
    .sort((a, b) => num(b.tvlUsd) - num(a.tvlUsd))
    .slice(0, o.limit)
    .flatMap((p) => {
      const project = cleanText(p.project, 32);
      const symbol = cleanText(p.symbol, 32);
      if (!project || !symbol) return [];
      return [
        {
          pool: String(p.pool),
          project,
          symbol,
          stablecoin: p.stablecoin === true,
          tvlUsd: g("protocolTvlUsd", p.tvlUsd),
          apyPct: g("apyPct", p.apy),
          apyBasePct: g("apyPct", p.apyBase),
          // DefiLlama leaves the reward APY empty when a pool pays no rewards.
          apyRewardPct: g("apyPct", p.apyReward ?? 0),
        },
      ];
    });
}

export interface DexVolumes {
  readonly total24hUsd: Figure;
  readonly change1dPct: Figure;
  readonly top: readonly { readonly name: string; readonly volume24hUsd: Figure }[];
}

export function dexVolumes(body: unknown, fetchedAtUnix: number, ctx: GuardContext): DexVolumes {
  const b = (body ?? {}) as { total24h?: unknown; change_1d?: unknown; protocols?: unknown[] };
  const g = (field: "dexVolume24hUsd" | "change24hPct", v: unknown) =>
    guard(field, v, "defillama", fetchedAtUnix, 3 * 3_600, ctx);
  return {
    total24hUsd: g("dexVolume24hUsd", b.total24h),
    change1dPct: g("change24hPct", b.change_1d),
    top: (b.protocols ?? [])
      .map((p) => p as { name?: unknown; total24h?: unknown })
      .sort((x, y) => num(y.total24h) - num(x.total24h))
      .slice(0, 5)
      .flatMap((p) => {
        const name = cleanText(p.name);
        return name ? [{ name, volume24hUsd: g("dexVolume24hUsd", p.total24h) }] : [];
      }),
  };
}

/** The chart's price points for MON, oldest first. */
export function chartPoints(body: unknown): PricePoint[] {
  const coins = (body as { coins?: Record<string, { prices?: unknown[] }> } | null)?.coins ?? {};
  const series = Object.values(coins)[0]?.prices ?? [];
  return series
    .map((p) => ({
      t: num((p as { timestamp?: unknown }).timestamp),
      price: num((p as { price?: unknown }).price),
    }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.price))
    .sort((a, b) => a.t - b.t);
}
