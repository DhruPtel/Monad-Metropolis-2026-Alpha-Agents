import type { ListedToken } from "@alpha-agents/domain";
import { type UpstreamDeps, getJson } from "./upstream.ts";
import type { DailyBudget } from "./usage.ts";

/**
 * The listings discovery checks tokens against (F-U1).
 *
 * - CoinGecko's coin list with platforms (keyless): every coin with an
 *   address on Monad, by address. This is the address cross-check.
 * - CoinMarketCap's map (two credits, pages of 5,000): only each coin's
 *   primary platform, so it names Monad addresses only for Monad-native coins.
 *   CoinMarketCap's info by address refuses Monad addresses on the Basic plan
 *   (400, read 2026-10-09), so it is not used.
 * - CoinMarketCap's top 200 by market cap (one credit): the names and
 *   symbols a look-alike would imitate, and a symbol and name cross-check.
 *
 * Cached for a day by the caller; CoinMarketCap's credits come from the
 * shared daily budget.
 */
export const COINGECKO_LIST_URL =
  "https://api.coingecko.com/api/v3/coins/list?include_platform=true";
export const CMC_MAP_URL = (start: number) =>
  `https://pro-api.coinmarketcap.com/v1/cryptocurrency/map?listing_status=active&start=${start}&limit=5000`;
export const CMC_TOP_URL =
  "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=200&convert=USD";
export const LISTINGS_TTL_MS = 24 * 3600_000;

export interface CoinGeckoMonadCoin {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly address: string;
}

export interface CmcCoin {
  readonly id: number;
  readonly symbol: string;
  readonly name: string;
  readonly rank: number | null;
  /** Lowercase, only when the coin's primary platform is Monad. */
  readonly monadAddress: string | null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function parseCoinGeckoMonad(body: unknown): CoinGeckoMonadCoin[] {
  if (!Array.isArray(body)) return [];
  const out: CoinGeckoMonadCoin[] = [];
  for (const c of body) {
    const e = c as { id?: unknown; symbol?: unknown; name?: unknown; platforms?: unknown };
    const a = (e.platforms as Record<string, unknown> | null)?.monad;
    if (typeof a !== "string" || !ADDRESS.test(a)) continue;
    if (typeof e.id !== "string" || typeof e.symbol !== "string" || typeof e.name !== "string")
      continue;
    out.push({ id: e.id, symbol: e.symbol, name: e.name, address: a.toLowerCase() });
  }
  return out;
}

export function parseCmcCoins(body: unknown): CmcCoin[] {
  const data = (body as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: CmcCoin[] = [];
  for (const c of data) {
    const e = c as {
      id?: unknown;
      symbol?: unknown;
      name?: unknown;
      rank?: unknown;
      cmc_rank?: unknown;
      platform?: { name?: unknown; token_address?: unknown } | null;
    };
    if (typeof e.id !== "number" || typeof e.symbol !== "string" || typeof e.name !== "string")
      continue;
    const onMonad =
      typeof e.platform?.name === "string" && e.platform.name.toLowerCase() === "monad";
    const addr =
      onMonad && typeof e.platform?.token_address === "string" ? e.platform.token_address : "";
    const rank = Number(e.cmc_rank ?? e.rank);
    out.push({
      id: e.id,
      symbol: e.symbol,
      name: e.name,
      rank: Number.isInteger(rank) && rank > 0 ? rank : null,
      monadAddress: ADDRESS.test(addr) ? addr.toLowerCase() : null,
    });
  }
  return out;
}

export async function fetchCoinGeckoMonad(deps: UpstreamDeps): Promise<CoinGeckoMonadCoin[]> {
  const body = await getJson(
    { provider: "coingecko", url: COINGECKO_LIST_URL, timeoutMs: 60_000 },
    deps,
  );
  return parseCoinGeckoMonad(body);
}

export interface CmcListDeps extends UpstreamDeps {
  readonly apiKey: string;
  readonly budget: DailyBudget;
}

async function cmc(url: string, deps: CmcListDeps): Promise<unknown> {
  await deps.budget.reserve(1);
  let body: unknown;
  try {
    body = await getJson(
      {
        provider: "coinmarketcap",
        url,
        headers: { "X-CMC_PRO_API_KEY": deps.apiKey },
        timeoutMs: 30_000,
      },
      deps,
    );
  } catch (err) {
    await deps.budget.adjust(-1);
    throw err;
  }
  const credits = Number((body as { status?: { credit_count?: unknown } })?.status?.credit_count);
  await deps.budget.adjust((Number.isFinite(credits) && credits > 0 ? credits : 1) - 1);
  return body;
}

/** Every active coin on the map, in pages of 5,000 (two pages today). */
export async function fetchCmcMap(deps: CmcListDeps, maxPages = 3): Promise<CmcCoin[]> {
  const out: CmcCoin[] = [];
  for (let page = 0; page < maxPages; page++) {
    const coins = parseCmcCoins(await cmc(CMC_MAP_URL(1 + page * 5000), deps));
    out.push(...coins);
    if (coins.length < 5000) break;
  }
  return out;
}

export async function fetchCmcTop(deps: CmcListDeps): Promise<CmcCoin[]> {
  return parseCmcCoins(await cmc(CMC_TOP_URL, deps));
}

/**
 * The listings a look-alike is checked against: every CoinGecko coin with a
 * Monad address (so another Monad token may not take its name), and
 * CoinMarketCap's top 200 (top assets, at their Monad address when CoinGecko
 * or the map knows one, else at none).
 */
export function guardedListings(
  coingecko: readonly CoinGeckoMonadCoin[],
  cmcTop: readonly CmcCoin[],
  cmcMap: readonly CmcCoin[],
): ListedToken[] {
  const out: ListedToken[] = coingecko.map((c) => ({
    symbol: c.symbol,
    name: c.name,
    monadAddress: c.address,
    source: "coingecko",
  }));
  const monadBySymbol = new Map<string, string>();
  for (const c of coingecko) monadBySymbol.set(c.symbol.toLowerCase(), c.address);
  for (const c of cmcMap)
    if (c.monadAddress) monadBySymbol.set(c.symbol.toLowerCase(), c.monadAddress);
  for (const c of cmcTop)
    out.push({
      symbol: c.symbol,
      name: c.name,
      monadAddress: c.monadAddress ?? monadBySymbol.get(c.symbol.toLowerCase()) ?? null,
      source: "coinmarketcap",
    });
  return out;
}
