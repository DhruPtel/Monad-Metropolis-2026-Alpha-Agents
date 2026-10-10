import {
  CLASS_F_FEEDS,
  type ClassFFeed,
  type ListedToken,
  MONAD_BASE_TOKENS,
  NATIVE_MON,
  type PriceClass,
  REVIEWED_TOKENS,
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
import { fetchGtSearch, fetchGtTokenPools, probeBasePools } from "./token-pools.ts";
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
  /** Onchain reads at once: low, so a first pass's few hundred reads never crowd the free RPC plan. */
  concurrency: 2,
} as const;

/** Every token on the reviewed list or the class F feed map: discovery reads each one's own pools. */
export const REVIEWED_AND_CLASS_F: readonly string[] = [
  ...new Set([...CLASS_F_FEEDS, ...REVIEWED_TOKENS].map((t) => t.address)),
];

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
  /** Tokens whose own pools each pass reads; the reviewed and class F tokens by default. */
  readonly byTokenAddresses?: readonly string[];
}

/** One token found on demand: its record and its pools, whether or not discovery ever saw it. */
export interface TokenLookup {
  readonly token: DiscoveredToken | null;
  readonly pools: readonly DiscoveredPool[];
  readonly block: string;
  readonly sources: Readonly<Record<string, SourceStatus>>;
}

/** A token a search turned up, before anything is read onchain. */
export interface TokenCandidate {
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly sources: readonly ("coingecko" | "geckoterminal")[];
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
    // GeckoTerminal's public API allows about 10 requests a minute, shared with anything else
    // on the host; at 9 a minute it refused a page in the live run, so the platform asks for 7.
    this.gt = new TokenBucket({
      capacity: 2,
      perMinute: 7,
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
    const pools = new Map<string, GtPool & { listedAsNew: boolean; byToken: boolean }>();
    const tokens = new Map<string, GtToken>();
    const add = (
      page: { pools: readonly GtPool[]; tokens: readonly GtToken[] },
      isNew: boolean,
      byToken = false,
    ) => {
      for (const t of page.tokens) tokens.set(t.address, t);
      for (const p of page.pools) {
        const had = pools.get(p.poolId);
        pools.set(p.poolId, {
          ...p,
          listedAsNew: isNew || (had?.listedAsNew ?? false),
          byToken: byToken || (had?.byToken ?? false),
        });
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
    // F-U2 Step 0: every reviewed and class F token's own pools, so deep but quiet pools count too.
    let byToken = 0;
    for (const address of this.o.byTokenAddresses ?? REVIEWED_AND_CLASS_F) {
      try {
        const body = await this.o.market.cache.get(
          cacheKey("geckoterminal", "tokenPools", { address }),
          DISCOVERY_DEFAULTS.ttlMs * 3,
          () => fetchGtTokenPools(address, this.deps(this.gt)),
        );
        const page = parseGtPools(body.value, this.ctx());
        add(
          { pools: page.pools.filter((p) => DEXES.includes(p.dex)), tokens: page.tokens },
          false,
          true,
        );
        byToken++;
      } catch (err) {
        lastError = message(err);
      }
    }
    sources["geckoterminal:byToken"] = {
      ok: byToken > 0 || (this.o.byTokenAddresses ?? REVIEWED_AND_CLASS_F).length === 0,
      detail: `${byToken} tokens' own pools read`,
    };
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
      // New pools and a reviewed or class F token's own pools are kept whatever their size.
      (p) => p.listedAsNew || p.byToken || (p.liquidityUsd ?? 0) >= min,
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
    const { tokens, listings } = await this.aggregate(
      client,
      addrs,
      pools,
      gtPools,
      gtTokens,
      nowSeconds,
      known,
      sources,
    );
    tokens.sort((x, y) => y.liquidityUsd - x.liquidityUsd);
    return {
      at: new Date(nowSeconds * 1000).toISOString(),
      block: block.number.toString(),
      pools,
      tokens,
      listings,
      sources,
      rejectedPools: rejected,
    };
  }

  private requireClient(): PublicClient {
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
    return client;
  }

  /**
   * One token's pools on the supported venues and its record, found from the
   * token itself (F-U2 Step 0, D-360): GeckoTerminal's pools for the token,
   * each confirmed onchain, plus the onchain probes against USDC, WMON and
   * MON, so a token no list has seen is found too. Null `token` when the
   * address does not answer as an ERC-20.
   */
  async poolsForToken(
    address: string,
    known: KnownState = { pools: new Map(), tokens: new Map() },
  ): Promise<TokenLookup> {
    const client = this.requireClient();
    const a = address.toLowerCase();
    const sources: Record<string, SourceStatus> = {};
    const gtPools = new Map<string, GtPool>();
    const gtTokens = new Map<string, GtToken>();
    try {
      const body = await this.o.market.cache.get(
        cacheKey("geckoterminal", "tokenPools", { address: a }),
        DISCOVERY_DEFAULTS.ttlMs,
        () => fetchGtTokenPools(a, this.deps(this.gt)),
      );
      const page = parseGtPools(body.value, this.ctx());
      for (const t of page.tokens) gtTokens.set(t.address, t);
      for (const p of page.pools) if (DEXES.includes(p.dex)) gtPools.set(p.poolId, p);
      sources.geckoterminal = { ok: true, detail: `${gtPools.size} pools on the supported venues` };
    } catch (err) {
      sources.geckoterminal = { ok: false, detail: message(err) };
    }
    const block = await client.getBlock();
    const listed = await limited(
      [...gtPools.values()],
      DISCOVERY_DEFAULTS.concurrency,
      async (p) => {
        const k = known.pools.get(p.poolId);
        try {
          const v = k ?? (await verifyPool(client, p));
          return v
            ? {
                ...v,
                name: p.name,
                liquidityUsd: p.liquidityUsd ?? 0,
                volume24hUsd: p.volume24hUsd ?? 0,
                createdAt: p.createdAt,
                listedAsNew: false,
              }
            : null;
        } catch {
          return null;
        }
      },
    );
    const pools: DiscoveredPool[] = listed.filter((p): p is DiscoveredPool => p !== null);
    const probed = await probeBasePools(client, a, DISCOVERY_DEFAULTS.concurrency);
    for (const p of probed) {
      if (pools.some((x) => x.poolId === p.poolId)) continue;
      pools.push({
        ...p,
        name: "",
        liquidityUsd: p.onchainLiquidityUsd ?? 0,
        volume24hUsd: 0,
        // Not on GeckoTerminal: its creation time is unknown, which the screen's age check refuses.
        createdAt: null,
        listedAsNew: false,
      });
    }
    sources.chain = {
      ok: true,
      detail: `${pools.length} pools confirmed at block ${block.number} (${probed.length} found onchain)`,
    };
    const { tokens } = await this.aggregate(
      client,
      [a],
      pools,
      gtPools,
      gtTokens,
      Number(block.timestamp),
      known,
      sources,
    );
    return { token: tokens[0] ?? null, pools, block: block.number.toString(), sources };
  }

  /**
   * Tokens matching a symbol or name (D-360): CoinGecko's Monad coins and
   * GeckoTerminal's pool search, folded the way look-alikes are. Nothing is
   * read onchain until the agent picks one and looks it up by address.
   */
  async search(query: string, limit = 10): Promise<TokenCandidate[]> {
    const q = foldName(query);
    if (q.length < 2) return [];
    const out = new Map<string, TokenCandidate>();
    const add = (c: Omit<TokenCandidate, "sources">, source: "coingecko" | "geckoterminal") => {
      const had = out.get(c.address);
      // CoinGecko writes symbols in lower case; GeckoTerminal keeps the token's own.
      const keep = had && source === "coingecko" ? had : c;
      out.set(c.address, {
        address: c.address,
        symbol: keep.symbol,
        name: keep.name,
        sources: had ? [...new Set([...had.sources, source])] : [source],
      });
    };
    const { coingecko } = await this.listings();
    for (const c of coingecko)
      if (foldName(c.symbol) === q || foldName(c.name) === q)
        add({ address: c.address, symbol: c.symbol, name: c.name }, "coingecko");
    try {
      const body = await this.o.market.cache.get(
        cacheKey("geckoterminal", "search", { q }),
        DISCOVERY_DEFAULTS.ttlMs,
        () => fetchGtSearch(query, this.deps(this.gt)),
      );
      const page = parseGtPools(body.value, this.ctx());
      for (const t of page.tokens)
        if (t.address !== NATIVE_MON && (foldName(t.symbol) === q || foldName(t.name) === q))
          add({ address: t.address, symbol: t.symbol, name: t.name }, "geckoterminal");
      // The search answers pools without token records: each side's symbol is in the pool's name.
      for (const p of page.pools) {
        const [base, quote] = p.name.split(" / ").map((x) => x.split(" ")[0]?.trim() ?? "");
        for (const [symbol, address] of [
          [base, p.base],
          [quote, p.quote],
        ] as const)
          if (symbol && address !== NATIVE_MON && foldName(symbol) === q && !out.has(address))
            add({ address, symbol, name: symbol }, "geckoterminal");
          else if (symbol && foldName(symbol) === q && out.has(address))
            add({ address, symbol, name: out.get(address)?.name ?? symbol }, "geckoterminal");
      }
    } catch {
      // Search is a convenience: CoinGecko's answer stands alone.
    }
    return [...out.values()].slice(0, limit);
  }

  /** Each token's record from its confirmed pools: its own metadata, class, listings and depth. */
  private async aggregate(
    client: PublicClient,
    addrs: readonly string[],
    pools: readonly DiscoveredPool[],
    gtPools: ReadonlyMap<string, GtPool>,
    gtTokens: ReadonlyMap<string, GtToken>,
    nowSeconds: number,
    known: KnownState,
    sources: Record<string, SourceStatus>,
  ): Promise<{ tokens: DiscoveredToken[]; listings: ListedToken[] }> {
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
    return { tokens, listings: guardedListings(coingecko, cmcTop, cmcMap) };
  }
}
