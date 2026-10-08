import type { Figure } from "./figures.ts";
import { type GuardContext, guard } from "./guards.ts";
import { MarketError, type TokenBucket, type UpstreamDeps, getJson } from "./upstream.ts";

/**
 * CoinMarketCap (D-321): the latest price, 24-hour change, volume and market
 * cap of MON and USDC, on the free Basic plan (15,000 credits a month, 50
 * requests a minute, read from /v1/key/info on 2026-10-08). Assets are asked
 * for by CoinMarketCap ID, never by symbol: eleven listings use "MON". One
 * request for both assets costs one credit; with the 5-minute cache that is at
 * most 288 credits a day, and a daily budget refuses anything past 450 so a
 * restart loop cannot spend the month (A-56). The plan has no history; the
 * history for volatility comes from DefiLlama.
 */
export const CMC_IDS = { MON: 30495, USDC: 3408 } as const;
export type CmcAsset = keyof typeof CMC_IDS;
export const CMC_QUOTES_URL = `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?id=${CMC_IDS.MON},${CMC_IDS.USDC}&convert=USD`;
/** CoinMarketCap refreshes its quotes about every minute; older than 15 minutes is stale. */
export const CMC_MAX_AGE_SECONDS = 900;
export const CMC_DAILY_CREDIT_BUDGET = 450;

export interface CmcQuote {
  readonly asset: CmcAsset;
  readonly priceUsd: Figure;
  readonly change24hPct: Figure;
  readonly volume24hUsd: Figure;
  readonly marketCapUsd: Figure;
}

/** Credits spent per UTC day, so the daily budget holds even under a burst of misses. */
export class CreditBudget {
  private day = "";
  private used = 0;
  private readonly limit: number;
  private readonly now: () => number;

  constructor(limit: number, now: () => number = Date.now) {
    this.limit = limit;
    this.now = now;
  }

  private roll() {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.used = 0;
    }
  }

  check(provider: string): void {
    this.roll();
    if (this.used < this.limit) return;
    const t = new Date(this.now());
    const midnight = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1);
    throw new MarketError(
      "RATE_LIMITED",
      provider,
      `${provider}: the platform's daily credit budget for this plan is used; fresh prices return after 00:00 UTC.`,
      { retryable: true, retryAfterSeconds: Math.ceil((midnight - this.now()) / 1000) },
    );
  }

  spend(credits: number) {
    this.roll();
    this.used += credits;
  }

  usedToday(): number {
    this.roll();
    return this.used;
  }
}

export interface CmcDeps extends UpstreamDeps {
  readonly apiKey: string;
  readonly budget: CreditBudget;
  readonly bucket?: TokenBucket;
}

/** The raw quotes answer. The key travels in a header, never in the URL. */
export async function fetchCmcQuotes(deps: CmcDeps): Promise<unknown> {
  deps.budget.check("coinmarketcap");
  const body = await getJson(
    {
      provider: "coinmarketcap",
      url: CMC_QUOTES_URL,
      headers: { "X-CMC_PRO_API_KEY": deps.apiKey },
    },
    deps,
  );
  const credits = Number((body as { status?: { credit_count?: unknown } })?.status?.credit_count);
  deps.budget.spend(Number.isFinite(credits) && credits > 0 ? credits : 1);
  return body;
}

const unix = (s: unknown) => {
  const t = typeof s === "string" ? Date.parse(s) : Number.NaN;
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
};

/** The quotes answer as guarded figures, one set per asset. */
export function cmcQuotes(body: unknown, ctx: GuardContext): CmcQuote[] {
  const data = (body as { data?: Record<string, unknown> } | null)?.data ?? {};
  return (Object.keys(CMC_IDS) as CmcAsset[]).map((asset) => {
    const entry = data[String(CMC_IDS[asset])] as
      { quote?: { USD?: Record<string, unknown> } } | undefined;
    const q = entry?.quote?.USD ?? {};
    const asOf = unix(q.last_updated);
    const f = (field: Parameters<typeof guard>[0], raw: unknown) =>
      guard(field, raw, "coinmarketcap", asOf, CMC_MAX_AGE_SECONDS, ctx);
    return {
      asset,
      priceUsd: f(asset === "MON" ? "monPriceUsd" : "usdcPriceUsd", q.price),
      change24hPct: f("change24hPct", q.percent_change_24h),
      volume24hUsd: f("volume24hUsd", q.volume_24h),
      marketCapUsd: f("marketCapUsd", q.market_cap),
    };
  });
}
