import {
  type ClassFFeed,
  type ListedToken,
  MONAD_BASE_TOKENS,
  NATIVE_MON,
  type PriceClass,
  classFFeed,
  foldName,
} from "@alpha-agents/domain";
import type { PublicClient } from "viem";
import { cacheKey } from "./cache.ts";
import {
  DEXES,
  type Dex,
  type GtPool,
  type GtSort,
  type GtToken,
  fetchGtNewPools,
  fetchGtPools,
  parseGtPools,
} from "./geckoterminal.ts";
import {
  type ClassFCheck,
  type TokenMeta,
  type VerifiedPool,
  checkClassFFeed,
  readTokenMeta,
  verifyPool,
} from "./pool-verify.ts";
import type { MarketData } from "./service.ts";
import {
  type CmcCoin,
  type CoinGeckoMonadCoin,
  LISTINGS_TTL_MS,
  fetchCmcMap,
  fetchCmcTop,
  fetchCoinGeckoMonad,
  guardedListings,
} from "./token-lists.ts";
import { MarketError, TokenBucket } from "./upstream.ts";

/**
 * Token discovery on Monad (F-U1): which tokens have pools with real
 * liquidity on Uniswap v3, Uniswap v4 and PancakeSwap v3, and how each is
 * priced. GeckoTerminal names the pools; the chain confirms each one and
 * each token's own symbol, name and decimals; CoinGecko's Monad list and
 * CoinMarketCap's listings cross-check the tokens; the reviewed feed map,
 * verified onchain, decides class F. Everything goes through the market
 * service's shared cache, clock and budgets, so the loop, the tools and the
 * console share one set of upstream requests.
 */
export const DISCOVERY_DEFAULTS = {
  /** Pages of 20 pools per venue, by 24-hour volume; one more page by transaction count. */
  volumePages: 2,
  txPages: 1,
  /** Pools below this are not kept (new pools are kept whatever their size). */
  minPoolUsd: 10_000,
  /** A discovery is shared for this long. */
  ttlMs: 10 * 60_000,
  /** Onchain reads at once. */
  concurrency: 4,
} as const;

export interface DiscoveredPool extends VerifiedPool {
  readonly name: string;
  readonly liquidityUsd: number;
  readonly volume24hUsd: number;
  readonly createdAt: string | null;
  /** True when GeckoTerminal listed it among the network's newest pools. */
  readonly listedAsNew: boolean;
}

export interface TokenListings {
  readonly coingecko: { readonly id: string } | null;
  readonly coinmarketcap: {
    readonly id: number;
    readonly rank: number | null;
    readonly match: "address" | "symbol_and_name";
  } | null;
  /** GeckoTerminal's own CoinGecko ID for the token, when it gives one. */
  readonly geckoterminalCoingeckoId: string | null;
}

export interface DiscoveredToken extends TokenMeta {
  readonly address: string;
  readonly priceClass: PriceClass;
  /** The reviewed feed and what the chain said of it; null when the token has none. */
  readonly feed: (ClassFCheck & { readonly symbol: string; readonly note: string }) | null;
  readonly listings: TokenListings;
  readonly pools: readonly string[];
  /** The deepest routable pool's liquidity, and that pool. */
  readonly liquidityUsd: number;
  readonly deepestPool: string | null;
  readonly volume24hUsd: number;
  readonly oldestPoolAt: string | null;
  readonly priceUsd: number | null;
}

export type SourceStatus =
  | { readonly ok: true; readonly detail: string }
  | {
      readonly ok: false;
      readonly detail: string;
    };

export interface Discovery {
  readonly at: string;
  readonly block: string | null;
  readonly pools: readonly DiscoveredPool[];
  readonly tokens: readonly DiscoveredToken[];
  /** The listings a look-alike is checked against, for the screen. */
  readonly listings: readonly ListedToken[];
  readonly sources: Readonly<Record<string, SourceStatus>>;
  /** Pools GeckoTerminal named that the chain did not confirm. */
  readonly rejectedPools: readonly { readonly poolId: string; readonly dex: Dex }[];
}

/** What discovery already knows, so it reads the chain only for what is new. */
export interface KnownState {
  readonly pools: ReadonlyMap<string, VerifiedPool>;
  readonly tokens: ReadonlyMap<string, TokenMeta>;
}

export interface TokenDiscoveryOptions {
  readonly market: MarketData;
  readonly cmcApiKey: string | null;
  /** The read-only mainnet client; null where no mainnet RPC is configured. */
  readonly client: PublicClient | null;
  readonly volumePages?: number;
  readonly txPages?: number;
  readonly minPoolUsd?: number;
}

async function limited<T, R>(
  items: readonly T[],
  n: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k] as T);
      }
    }),
  );
  return out;
}

const message = (err: unknown) => (err instanceof MarketError ? err.message : "the source failed");

/** Native MON pools count toward WMON: the platform's accounts hold MON as WMON. */
const asHeld = (a: string) => (a === NATIVE_MON ? MONAD_BASE_TOKENS.WMON : a);

export class TokenDiscovery {
  private readonly o: TokenDiscoveryOptions;
  private readonly gt: TokenBucket;

  constructor(o: TokenDiscoveryOptions) {
    this.o = o;
    const sleep = o.market.upstreamOptions().sleep;
    // GeckoTerminal's public API allows about 10 requests a minute.
    this.gt = new TokenBucket({
      capacity: 3,
      perMinute: 9,
      now: o.market.now,
      ...(sleep ? { sleep } : {}),
    });
  }

  get configured() {
    return { chain: this.o.client !== null, coinmarketcap: this.o.cmcApiKey !== null };
  }

  private deps(bucket?: TokenBucket) {
    return { ...this.o.market.upstreamOptions(), ...(bucket ? { bucket } : {}) };
  }

  private ctx() {
    return { now: Math.floor(this.o.market.now() / 1000) };
  }

  /** CoinGecko's Monad coins, CoinMarketCap's map and top 200: each optional, each cached a day. */
  async listings(): Promise<{
    coingecko: CoinGeckoMonadCoin[];
    cmcMap: CmcCoin[];
    cmcTop: CmcCoin[];
    sources: Record<string, SourceStatus>;
  }> {
    const c = this.o.market.cache;
    const sources: Record<string, SourceStatus> = {};
    const get = async <T>(name: string, method: string, load: () => Promise<T[]>): Promise<T[]> => {
      try {
        const r = await c.get(cacheKey(name.split(":")[0] ?? name, method), LISTINGS_TTL_MS, load);
        sources[name] = {
          ok: true,
          detail: `${r.value.length} entries${r.cacheHit ? " (cached)" : ""}`,
        };
        return r.value;
      } catch (err) {
        sources[name] = { ok: false, detail: message(err) };
        return [];
      }
    };
    const coingecko = await get("coingecko", "monadCoins", () => fetchCoinGeckoMonad(this.deps()));
    const key = this.o.cmcApiKey;
    const cmcDeps = key ? { apiKey: key, budget: this.o.market.cmcBudget, ...this.deps() } : null;
    const cmcMap = cmcDeps
      ? await get("coinmarketcap:map", "map", () => fetchCmcMap(cmcDeps))
      : ((sources["coinmarketcap:map"] = { ok: false, detail: "CoinMarketCap is not configured" }),
        []);
    const cmcTop = cmcDeps
      ? await get("coinmarketcap:top", "top200", () => fetchCmcTop(cmcDeps))
      : ((sources["coinmarketcap:top"] = { ok: false, detail: "CoinMarketCap is not configured" }),
        []);
    return { coingecko, cmcMap, cmcTop, sources };
  }

  /** GeckoTerminal's pools for the three venues, and its newest pools. */
  private async gtPools(sources: Record<string, SourceStatus>) {
    const pools = new Map<string, GtPool & { listedAsNew: boolean }>();
    const tokens = new Map<string, GtToken>();
    const add = (
      page: { pools: readonly GtPool[]; tokens: readonly GtToken[] },
      isNew: boolean,
    ) => {
      for (const t of page.tokens) tokens.set(t.address, t);
      for (const p of page.pools) {
        const had = pools.get(p.poolId);
        pools.set(p.poolId, { ...p, listedAsNew: isNew || (had?.listedAsNew ?? false) });
      }
    };
    const reqs: { dex: Dex; page: number; sort: GtSort }[] = [];
    for (const dex of DEXES) {
      for (let page = 1; page <= (this.o.volumePages ?? DISCOVERY_DEFAULTS.volumePages); page++)
        reqs.push({ dex, page, sort: "h24_volume_usd_desc" });
      for (let page = 1; page <= (this.o.txPages ?? DISCOVERY_DEFAULTS.txPages); page++)
        reqs.push({ dex, page, sort: "h24_tx_count_desc" });
    }
    let ok = 0;
    let lastError = "";
    for (const r of reqs) {
      try {
        const body = await this.o.market.cache.get(
          cacheKey("geckoterminal", "pools", r),
          DISCOVERY_DEFAULTS.ttlMs,
          () => fetchGtPools(r.dex, r.page, r.sort, this.deps(this.gt)),
        );
        add(parseGtPools(body.value, this.ctx(), r.dex), false);
        ok++;
      } catch (err) {
        lastError = message(err);
      }
    }
    sources.geckoterminal =
      ok > 0
        ? {
            ok: true,
            detail: `${ok} of ${reqs.length} pages read${lastError ? `; ${lastError}` : ""}`,
          }
        : { ok: false, detail: lastError || "no pages read" };
    try {
      const body = await this.o.market.cache.get(
        cacheKey("geckoterminal", "newPools", { page: 1 }),
        DISCOVERY_DEFAULTS.ttlMs,
        () => fetchGtNewPools(1, this.deps(this.gt)),
      );
      const page = parseGtPools(body.value, this.ctx());
      add({ pools: page.pools.filter((p) => DEXES.includes(p.dex)), tokens: page.tokens }, true);
      sources["geckoterminal:new"] = { ok: true, detail: `${page.pools.length} new pools` };
    } catch (err) {
      sources["geckoterminal:new"] = { ok: false, detail: message(err) };
    }
    return { pools, tokens };
  }

  /**
   * One discovery pass. `known` holds what the registry already verified, so
   * a pass reads the chain only for new pools and tokens. Throws only when
   * there is no pool source or no chain to verify against.
   */
  async discover(known: KnownState = { pools: new Map(), tokens: new Map() }): Promise<Discovery> {
    const client = this.o.client;
    if (!client)
      throw new MarketError(
        "UPSTREAM_UNAVAILABLE",
        "monad",
        "Monad mainnet reads are not configured.",
        {
          retryable: false,
        },
      );
    const sources: Record<string, SourceStatus> = {};
    const { pools: gtPools, tokens: gtTokens } = await this.gtPools(sources);
    if (!sources.geckoterminal?.ok)
      throw new MarketError(
        "UPSTREAM_UNAVAILABLE",
        "geckoterminal",
        "GeckoTerminal did not answer.",
        {
          retryable: true,
        },
      );
    const min = this.o.minPoolUsd ?? DISCOVERY_DEFAULTS.minPoolUsd;
    const candidates = [...gtPools.values()].filter(
      (p) => p.listedAsNew || (p.liquidityUsd ?? 0) >= min,
    );

    const block = await client.getBlock();
    const nowSeconds = Number(block.timestamp);
    const rejected: { poolId: string; dex: Dex }[] = [];
    const verified = await limited(candidates, DISCOVERY_DEFAULTS.concurrency, async (p) => {
      const k = known.pools.get(p.poolId);
      if (k) return { p, v: k };
      try {
        const v = await verifyPool(client, p);
        if (!v) rejected.push({ poolId: p.poolId, dex: p.dex });
        return { p, v };
      } catch {
        // A read that failed is not a rejection: the pool is asked again next pass.
        return { p, v: null };
      }
    });
    const pools: DiscoveredPool[] = verified.flatMap(({ p, v }) =>
      v
        ? [
            {
              ...v,
              name: p.name,
              liquidityUsd: p.liquidityUsd ?? 0,
              volume24hUsd: p.volume24hUsd ?? 0,
              createdAt: p.createdAt,
              listedAsNew: p.listedAsNew,
            },
          ]
        : [],
    );
    sources.chain = {
      ok: true,
      detail: `${pools.length} pools confirmed at block ${block.number}, ${rejected.length} not confirmed`,
    };

    const addrs = [
      ...new Set(pools.flatMap((p) => [p.token0, p.token1]).filter((a) => a !== NATIVE_MON)),
    ];
    const metas = await limited(addrs, DISCOVERY_DEFAULTS.concurrency, async (a) => ({
      a,
      m: known.tokens.get(a) ?? (await readTokenMeta(client, a)),
    }));
    const { coingecko, cmcMap, cmcTop, sources: listSources } = await this.listings();
    Object.assign(sources, listSources);
    const cgByAddress = new Map(coingecko.map((c) => [c.address, c]));
    const cmcByAddress = new Map(
      cmcMap.flatMap((c) => (c.monadAddress ? [[c.monadAddress, c] as const] : [])),
    );
    const cmcBySymbolName = new Map(
      [...cmcTop, ...cmcMap].map((c) => [`${foldName(c.symbol)}|${foldName(c.name)}`, c] as const),
    );

    const tokens: DiscoveredToken[] = [];
    for (const { a, m } of metas) {
      if (!m) continue;
      const mine = pools.filter((p) => asHeld(p.token0) === a || asHeld(p.token1) === a);
      const routable = mine.filter((p) => p.routable);
      const deepest = [...routable].sort((x, y) => y.liquidityUsd - x.liquidityUsd)[0] ?? null;
      const ages = mine.flatMap((p) => (p.createdAt ? [p.createdAt] : [])).sort();
      const gt = gtTokens.get(a);
      const cg = cgByAddress.get(a);
      const cmcAddr = cmcByAddress.get(a);
      const cmcName = cmcBySymbolName.get(`${foldName(m.symbol)}|${foldName(m.name)}`);
      const cmc = cmcAddr
        ? { id: cmcAddr.id, rank: cmcAddr.rank, match: "address" as const }
        : cmcName && cg
          ? { id: cmcName.id, rank: cmcName.rank, match: "symbol_and_name" as const }
          : null;
      const feedSpec: ClassFFeed | null = classFFeed(a);
      const feedCheck = feedSpec ? await checkClassFFeed(client, feedSpec, nowSeconds) : null;
      const priceUsd = (() => {
        const p = gtPools.get(deepest?.poolId ?? "");
        if (!p) return null;
        return asHeld(p.base) === a ? p.baseTokenPriceUsd : p.quoteTokenPriceUsd;
      })();
      tokens.push({
        address: a,
        ...m,
        priceClass: feedCheck?.ok ? "F" : "A",
        feed:
          feedSpec && feedCheck
            ? { ...feedCheck, symbol: feedSpec.symbol, note: feedSpec.note }
            : null,
        listings: {
          coingecko: cg ? { id: cg.id } : null,
          coinmarketcap: cmc,
          geckoterminalCoingeckoId: gt?.coingeckoId ?? null,
        },
        pools: mine.map((p) => p.poolId),
        liquidityUsd: deepest?.liquidityUsd ?? 0,
        deepestPool: deepest?.poolId ?? null,
        volume24hUsd: mine.reduce((s, p) => s + p.volume24hUsd, 0),
        oldestPoolAt: ages[0] ?? null,
        priceUsd,
      });
    }
    tokens.sort((x, y) => y.liquidityUsd - x.liquidityUsd);
    return {
      at: new Date(nowSeconds * 1000).toISOString(),
      block: block.number.toString(),
      pools,
      tokens,
      listings: guardedListings(coingecko, cmcTop, cmcMap),
      sources,
      rejectedPools: rejected,
    };
  }
}
