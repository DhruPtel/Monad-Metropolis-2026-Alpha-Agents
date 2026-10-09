import { NATIVE_MON } from "@alpha-agents/domain";
import { type GuardContext, guard } from "./guards.ts";
import { type UpstreamDeps, getJson } from "./upstream.ts";

/**
 * GeckoTerminal (F-U1): Monad's pools on Uniswap v3, Uniswap v4 and
 * PancakeSwap v3, with liquidity, 24-hour volume and creation time, and the
 * network's newest pools. Keyless; about 10 requests a minute, 20 pools a
 * page, at most 10 pages; sorted by 24-hour volume or transaction count (it
 * has no sort by liquidity, so both are read). A Uniswap v4 pool's "address"
 * is its pool ID. Native MON appears as the zero address. Every number goes
 * through the plausibility guards; a refused liquidity counts as none.
 */
export const GT_BASE = "https://api.geckoterminal.com/api/v2/networks/monad";

export const DEXES = ["uniswap_v3", "uniswap_v4", "pancakeswap_v3"] as const;
export type Dex = (typeof DEXES)[number];
export const GT_DEX_IDS: Readonly<Record<Dex, string>> = {
  uniswap_v3: "uniswap-v3-monad",
  uniswap_v4: "uniswap-v4-monad",
  pancakeswap_v3: "pancakeswap-v3-monad",
};
const DEX_BY_GT_ID = Object.fromEntries(
  Object.entries(GT_DEX_IDS).map(([k, v]) => [v, k as Dex]),
) as Record<string, Dex>;

export type GtSort = "h24_volume_usd_desc" | "h24_tx_count_desc";

/** GeckoTerminal answers within minutes of a trade; its figures are older than an hour only when it is behind. */
export const GT_MAX_AGE_SECONDS = 3600;

export interface GtToken {
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number | null;
  readonly coingeckoId: string | null;
}

export interface GtPool {
  readonly dex: Dex;
  /** Lowercase: a pool address, or a Uniswap v4 pool ID. */
  readonly poolId: string;
  readonly name: string;
  readonly base: string;
  readonly quote: string;
  /** Null when GeckoTerminal gave none or the guards refused it. */
  readonly liquidityUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly baseTokenPriceUsd: number | null;
  readonly quoteTokenPriceUsd: number | null;
  readonly createdAt: string | null;
}

export interface GtPage {
  readonly pools: readonly GtPool[];
  readonly tokens: readonly GtToken[];
}

export const gtPoolsUrl = (dex: Dex, page: number, sort: GtSort) =>
  `${GT_BASE}/dexes/${GT_DEX_IDS[dex]}/pools?page=${page}&sort=${sort}&include=base_token,quote_token`;
export const gtNewPoolsUrl = (page: number) =>
  `${GT_BASE}/new_pools?page=${page}&include=base_token,quote_token`;

const str = (v: unknown) => (typeof v === "string" ? v : null);
const lowerAddress = (id: unknown): string | null => {
  const s = str(id);
  // Relationship IDs are "monad_<address>".
  const a = s?.startsWith("monad_") ? s.slice(6) : s;
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null;
};

/** One answer of the pools or new pools endpoint, guarded. Rows that cannot be read are skipped. */
export function parseGtPools(body: unknown, ctx: GuardContext, dex?: Dex): GtPage {
  const b = body as { data?: unknown[]; included?: unknown[] } | null;
  const tokens: GtToken[] = [];
  for (const t of b?.included ?? []) {
    const e = t as { type?: string; attributes?: Record<string, unknown> };
    if (e.type !== "token" || !e.attributes) continue;
    const address = lowerAddress(e.attributes.address);
    if (!address) continue;
    const decimals = Number(e.attributes.decimals);
    tokens.push({
      address,
      symbol: (str(e.attributes.symbol) ?? "").slice(0, 32),
      name: (str(e.attributes.name) ?? "").slice(0, 80),
      decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null,
      coingeckoId: str(e.attributes.coingecko_coin_id),
    });
  }
  const pools: GtPool[] = [];
  for (const p of b?.data ?? []) {
    const e = p as {
      attributes?: Record<string, unknown>;
      relationships?: Record<string, { data?: { id?: unknown } }>;
    };
    const a = e.attributes;
    if (!a) continue;
    const poolDex = DEX_BY_GT_ID[str(e.relationships?.dex?.data?.id) ?? ""] ?? dex;
    const id = str(a.address)?.toLowerCase() ?? null;
    const base = lowerAddress(e.relationships?.base_token?.data?.id);
    const quote = lowerAddress(e.relationships?.quote_token?.data?.id);
    if (!poolDex || !id || !/^0x([0-9a-f]{40}|[0-9a-f]{64})$/.test(id) || !base || !quote) continue;
    const vol = a.volume_usd as Record<string, unknown> | undefined;
    const g = (field: "dexVolume24hUsd" | "poolReserveUsd" | "tokenPriceUsd", raw: unknown) =>
      guard(field, raw, "geckoterminal", ctx.now, GT_MAX_AGE_SECONDS, ctx).value;
    const created = str(a.pool_created_at);
    pools.push({
      dex: poolDex,
      poolId: id,
      name: (str(a.name) ?? "").slice(0, 80),
      base,
      quote,
      liquidityUsd: g("poolReserveUsd", a.reserve_in_usd),
      volume24hUsd: g("dexVolume24hUsd", vol?.h24),
      baseTokenPriceUsd: g("tokenPriceUsd", a.base_token_price_usd),
      quoteTokenPriceUsd: g("tokenPriceUsd", a.quote_token_price_usd),
      createdAt: created && !Number.isNaN(Date.parse(created)) ? created : null,
    });
  }
  return { pools, tokens };
}

export async function fetchGtPools(
  dex: Dex,
  page: number,
  sort: GtSort,
  deps: UpstreamDeps,
): Promise<unknown> {
  return getJson({ provider: "geckoterminal", url: gtPoolsUrl(dex, page, sort) }, deps);
}

export async function fetchGtNewPools(page: number, deps: UpstreamDeps): Promise<unknown> {
  return getJson({ provider: "geckoterminal", url: gtNewPoolsUrl(page) }, deps);
}

/** Native MON in a pool is routed as WMON by the platform's accounts. */
export const isNativeMon = (address: string) => address === NATIVE_MON;
