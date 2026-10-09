import { type Cached, MarketCache, cacheKey } from "./cache.ts";
import {
  CMC_DAILY_CREDIT_BUDGET,
  type CmcQuote,
  cmcQuotes,
  fetchCmcQuotes,
} from "./coinmarketcap.ts";
import {
  type ChainTvl,
  type DexVolumes,
  LLAMA_MAX_AGE_SECONDS,
  LLAMA_URLS,
  type MonadProtocol,
  type MonadYield,
  chainTvl,
  chartPoints,
  dexVolumes,
  monadProtocols,
  monadYields,
} from "./defillama.ts";
import { type Figure, type FigureWarning, iso } from "./figures.ts";
import { type GuardContext, type Refusal, crossCheck, guard } from "./guards.ts";
import type { MainnetMarketReader, OracleVsPool, PoolDepth } from "./mainnet.ts";
import { MarketError, type Sleep, TokenBucket, getJson } from "./upstream.ts";
import { DailyBudget, MemoryUsageStore, type UsageStore } from "./usage.ts";
import {
  VOLATILITY_METHOD,
  VOLATILITY_WINDOWS,
  type VolatilityWindow,
  realizedVolatility,
} from "./volatility.ts";

/**
 * The platform's market data (P3-U2): one instance per process, shared by the
 * data tools, the chain tools' depth and the platform's own readers (the
 * template runner and the sweep's deterministic steps). Upstream bodies are
 * cached by source with the times to live below (A-56); figures are guarded on
 * every read, so a figure's age is measured from now, not from the fetch.
 */
export const MARKET_TTL_MS = {
  coinmarketcap: 5 * 60_000,
  chainTvl: 15 * 60_000,
  protocols: 60 * 60_000,
  yields: 60 * 60_000,
  dexVolumes: 30 * 60_000,
  chartHourly: 15 * 60_000,
  chart4h: 60 * 60_000,
  oracleVsPool: 30_000,
  poolDepth: 60_000,
} as const;

/** CoinMarketCap and DefiLlama MON prices against Chainlink: more than 3% apart is flagged (A-56). */
export const PRICE_TOLERANCE_BPS = 300;

export interface MarketDataOptions {
  /** Null where COINMARKETCAP_API_KEY is not set: prices answer UPSTREAM_UNAVAILABLE. */
  readonly cmcApiKey: string | null;
  /** Null where no mainnet RPC is configured: chain figures answer UPSTREAM_UNAVAILABLE. */
  readonly mainnet: MainnetMarketReader | null;
  readonly fetch?: typeof fetch;
  readonly sleep?: Sleep;
  /** Ms since the epoch. */
  readonly now?: () => number;
  readonly onRefuse?: (r: Refusal) => void;
  /** Where daily budgets are counted; the orchestrator's persists (P3-U9). Defaults to memory. */
  readonly usage?: UsageStore;
}

export interface VolatilityFigures {
  readonly method: string;
  readonly windows: Readonly<Record<VolatilityWindow, Figure & { readonly returns: number }>>;
}

/** One part of the snapshot: its data, or why it is missing. */
export type Part<T> =
  | { readonly ok: true; readonly data: T; readonly cacheHit: boolean }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
    };

export interface MarketSnapshot {
  readonly asOf: string;
  readonly prices: Part<readonly CmcQuote[]>;
  readonly oracleVsPool: Part<OracleVsPool>;
  readonly volatility: Part<VolatilityFigures>;
  readonly poolDepth: Part<PoolDepth>;
  readonly chainTvl: Part<ChainTvl>;
  readonly dexVolumes: Part<DexVolumes>;
  readonly topProtocols: Part<readonly MonadProtocol[]>;
  readonly topYields: Part<readonly MonadYield[]>;
  /** Cross-source checks on MON's price, each figure kept with its own source. */
  readonly priceChecks: readonly {
    readonly pair: string;
    readonly warnings: readonly FigureWarning[];
  }[];
}

/** The market reads each data tool makes, so the meter can tell a cached answer before it charges. */
export const MARKET_TOOL_KEYS = {
  coinmarketcap_prices: [cacheKey("coinmarketcap", "quotes")],
  defillama_tvl: [cacheKey("defillama", "chainTvl"), cacheKey("defillama", "protocols")],
  defillama_yields: [cacheKey("defillama", "yields")],
  volatility: [cacheKey("defillama", "chartHourly"), cacheKey("defillama", "chart4h")],
  market_snapshot: [
    cacheKey("coinmarketcap", "quotes"),
    cacheKey("defillama", "chainTvl"),
    cacheKey("defillama", "protocols"),
    cacheKey("defillama", "yields"),
    cacheKey("defillama", "dexVolumes"),
    cacheKey("defillama", "chartHourly"),
    cacheKey("defillama", "chart4h"),
    cacheKey("monad", "oracleVsPool"),
    cacheKey("monad", "poolDepth"),
  ],
  get_pool_depth: [cacheKey("monad", "poolDepth")],
} as const;
export type MarketTool = keyof typeof MARKET_TOOL_KEYS;

export class MarketData {
  readonly cache: MarketCache;
  readonly cmcBudget: DailyBudget;
  readonly usage: UsageStore;
  private readonly o: MarketDataOptions;
  private readonly now: () => number;
  private readonly buckets: Record<"coinmarketcap" | "defillama", TokenBucket>;

  constructor(o: MarketDataOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.cache = new MarketCache(this.now);
    this.usage = o.usage ?? new MemoryUsageStore();
    this.cmcBudget = new DailyBudget({
      provider: "coinmarketcap",
      limit: CMC_DAILY_CREDIT_BUDGET,
      unit: "credits",
      store: this.usage,
      now: this.now,
    });
    const sleep = o.sleep;
    this.buckets = {
      // CoinMarketCap's plan allows 50 a minute; the platform stays well under it.
      coinmarketcap: new TokenBucket({
        capacity: 5,
        perMinute: 20,
        now: this.now,
        ...(sleep ? { sleep } : {}),
      }),
      // DefiLlama publishes no limit for its free API; the platform is polite.
      defillama: new TokenBucket({
        capacity: 10,
        perMinute: 60,
        now: this.now,
        ...(sleep ? { sleep } : {}),
      }),
    };
  }

  /** Whether every read the tool makes is already cached and fresh. */
  fresh(tool: MarketTool): boolean {
    return MARKET_TOOL_KEYS[tool].every((k) => this.cache.isFresh(k));
  }

  private ctx(): GuardContext {
    return {
      now: Math.floor(this.now() / 1000),
      ...(this.o.onRefuse ? { onRefuse: this.o.onRefuse } : {}),
    };
  }

  private deps(provider: "coinmarketcap" | "defillama") {
    return {
      ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
      ...(this.o.sleep ? { sleep: this.o.sleep } : {}),
      bucket: this.buckets[provider],
    };
  }

  private llama(method: keyof typeof LLAMA_URLS, ttl: keyof typeof MARKET_TTL_MS) {
    return this.cache.get(cacheKey("defillama", method), MARKET_TTL_MS[ttl], () =>
      getJson(
        { provider: "defillama", url: LLAMA_URLS[method], timeoutMs: 30_000 },
        this.deps("defillama"),
      ),
    );
  }

  /** MON and USDC from CoinMarketCap: price, 24-hour change, volume, market cap. */
  async prices(): Promise<Cached<CmcQuote[]>> {
    const key = this.o.cmcApiKey;
    if (!key)
      throw new MarketError(
        "UPSTREAM_UNAVAILABLE",
        "coinmarketcap",
        "CoinMarketCap is not configured on this platform.",
        {
          retryable: false,
        },
      );
    const raw = await this.cache.get(
      cacheKey("coinmarketcap", "quotes"),
      MARKET_TTL_MS.coinmarketcap,
      () => fetchCmcQuotes({ apiKey: key, budget: this.cmcBudget, ...this.deps("coinmarketcap") }),
    );
    return { ...raw, value: cmcQuotes(raw.value, this.ctx()) };
  }

  async chainTvl(): Promise<Cached<ChainTvl>> {
    const raw = await this.llama("chainTvl", "chainTvl");
    return { ...raw, value: chainTvl(raw.value, this.ctx()) };
  }

  async protocols(limit = 10): Promise<Cached<MonadProtocol[]>> {
    const raw = await this.llama("protocols", "protocols");
    return {
      ...raw,
      value: monadProtocols(raw.value, Math.floor(raw.fetchedAt / 1000), limit, this.ctx()),
    };
  }

  async yields(o: { limit: number; asset: "USDC" | "MON" | null }): Promise<Cached<MonadYield[]>> {
    const raw = await this.llama("yields", "yields");
    return {
      ...raw,
      value: monadYields(raw.value, Math.floor(raw.fetchedAt / 1000), o, this.ctx()),
    };
  }

  async dexVolumes(): Promise<Cached<DexVolumes>> {
    const raw = await this.llama("dexVolumes", "dexVolumes");
    return { ...raw, value: dexVolumes(raw.value, Math.floor(raw.fetchedAt / 1000), this.ctx()) };
  }

  /** Realized volatility over 24 hours, 7 and 30 days, with the method named. */
  async volatility(): Promise<Cached<VolatilityFigures>> {
    const [h, f] = await Promise.all([
      this.llama("chartHourly", "chartHourly"),
      this.llama("chart4h", "chart4h"),
    ]);
    const ctx = this.ctx();
    const series = { hourly: chartPoints(h.value), fourHourly: chartPoints(f.value) };
    const one = (w: VolatilityWindow) => {
      const points =
        VOLATILITY_WINDOWS[w].periodSeconds === 3_600 ? series.hourly : series.fourHourly;
      const r = realizedVolatility(points, w);
      const maxAge =
        w === "30d" ? LLAMA_MAX_AGE_SECONDS.chart4h : LLAMA_MAX_AGE_SECONDS.chartHourly;
      const fig = guard(
        "volatilityAnnualPct",
        r.annualizedPct,
        "computed",
        r.asOf || ctx.now,
        maxAge,
        ctx,
      );
      const warnings: FigureWarning[] =
        r.returns < r.minReturns
          ? [
              ...fig.warnings,
              {
                code: "THIN_HISTORY",
                message: `Computed from ${r.returns} returns; the method asks for at least ${r.minReturns}.`,
              },
            ]
          : [...fig.warnings];
      return { ...fig, warnings, returns: r.returns };
    };
    return {
      value: {
        method: VOLATILITY_METHOD,
        windows: { "24h": one("24h"), "7d": one("7d"), "30d": one("30d") },
      },
      cacheHit: h.cacheHit && f.cacheHit,
      fetchedAt: Math.min(h.fetchedAt, f.fetchedAt),
    };
  }

  private mainnet(): MainnetMarketReader {
    if (!this.o.mainnet)
      throw new MarketError(
        "UPSTREAM_UNAVAILABLE",
        "monad",
        "Mainnet reads are not configured on this platform.",
        {
          retryable: false,
        },
      );
    return this.o.mainnet;
  }

  async oracleVsPool(): Promise<Cached<OracleVsPool>> {
    const m = this.mainnet();
    return this.cache.get(cacheKey("monad", "oracleVsPool"), MARKET_TTL_MS.oracleVsPool, () =>
      m.oracleVsPool(this.ctx()),
    );
  }

  async poolDepth(): Promise<Cached<PoolDepth>> {
    const m = this.mainnet();
    return this.cache.get(cacheKey("monad", "poolDepth"), MARKET_TTL_MS.poolDepth, () =>
      m.poolDepth(this.ctx()),
    );
  }

  /** Everything at once; a part that fails says why and the rest still answer. */
  async snapshot(): Promise<{ value: MarketSnapshot; cacheHit: boolean }> {
    const part = async <T>(p: Promise<Cached<T>>): Promise<Part<T>> => {
      try {
        const c = await p;
        return { ok: true, data: c.value, cacheHit: c.cacheHit };
      } catch (err) {
        const e =
          err instanceof MarketError
            ? { code: err.code, message: err.message, retryable: err.retryable }
            : {
                code: "UPSTREAM_UNAVAILABLE",
                message: "This part could not be read.",
                retryable: true,
              };
        return { ok: false, error: e };
      }
    };
    const [prices, ovp, vol, depth, tvl, dex, protocols, yields] = await Promise.all([
      part(this.prices()),
      part(this.oracleVsPool()),
      part(this.volatility()),
      part(this.poolDepth()),
      part(this.chainTvl()),
      part(this.dexVolumes()),
      part(this.protocols(8)),
      part(this.yields({ limit: 8, asset: null })),
    ]);
    // MON's price from each source, checked against Chainlink; each keeps its own source.
    const checks: { pair: string; warnings: FigureWarning[] }[] = [];
    let pricesOut = prices;
    let ovpOut = ovp;
    if (ovp.ok) {
      const chainlink = ovp.data.chainlinkMonUsd;
      const [pool, cl1] = crossCheck(ovp.data.poolMonUsdc, chainlink, PRICE_TOLERANCE_BPS);
      checks.push({
        pair: "uniswap_v4 vs chainlink",
        warnings: [...cl1.warnings.filter((w) => w.code === "SOURCES_DISAGREE")],
      });
      ovpOut = { ...ovp, data: { ...ovp.data, poolMonUsdc: pool } };
      if (prices.ok) {
        const mon = prices.data.find((q) => q.asset === "MON");
        if (mon) {
          const [cmc, cl2] = crossCheck(mon.priceUsd, chainlink, PRICE_TOLERANCE_BPS);
          checks.push({
            pair: "coinmarketcap vs chainlink",
            warnings: [...cl2.warnings.filter((w) => w.code === "SOURCES_DISAGREE")],
          });
          pricesOut = {
            ...prices,
            data: prices.data.map((q) => (q.asset === "MON" ? { ...q, priceUsd: cmc } : q)),
          };
        }
      }
    }
    const parts = [pricesOut, ovpOut, vol, depth, tvl, dex, protocols, yields];
    return {
      value: {
        asOf: iso(Math.floor(this.now() / 1000)),
        prices: pricesOut,
        oracleVsPool: ovpOut,
        volatility: vol,
        poolDepth: depth,
        chainTvl: tvl,
        dexVolumes: dex,
        topProtocols: protocols,
        topYields: yields,
        priceChecks: checks,
      },
      cacheHit: parts.every((p) => p.ok && p.cacheHit),
    };
  }
}
