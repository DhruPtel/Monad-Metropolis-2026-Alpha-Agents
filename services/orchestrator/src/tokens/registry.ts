import { randomUUID } from "node:crypto";
import {
  CLASS_F_FEEDS,
  type ListedToken,
  REVIEWED_TOKENS,
  SCREEN_RULES,
} from "@alpha-agents/domain";
import {
  type GoPlusReport,
  MarketError,
  type MarketData,
  TokenBucket,
  type TokenCandidate,
  type TokenDiscovery,
  cacheKey,
  fetchGoPlus,
  getJson,
  guardedListings,
} from "@alpha-agents/market";
import { type ScreenOutcome, type TokenListEntry, runScreen } from "./screen.ts";
import type { ScreenFork } from "./screen-fork.ts";
import type { PoolRow, ScreenRecord, TokenFilter, TokenRow, TokenStore } from "./store.ts";

/**
 * The platform's token registry (F-U1): discovery passes write tokens and
 * pools; screens run on the screen fork and are kept as history; agents,
 * the console and the loop read through here. One discovery and one screen
 * per token run at a time; a second caller waits for the first's answer.
 */
export class RegistryError extends Error {
  readonly code: "NOT_FOUND" | "UPSTREAM_UNAVAILABLE" | "NOT_CONFIGURED";
  constructor(code: RegistryError["code"], message: string) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
  }
}

export interface TokenRegistryOptions {
  readonly chainId: number;
  readonly store: TokenStore;
  readonly market: MarketData;
  /** Null where no mainnet RPC is configured. */
  readonly discovery: TokenDiscovery | null;
  /** Null where screens cannot run (no fork upstream). */
  readonly fork: ScreenFork | null;
  /** Replaces GoPlus in tests; null skips the second opinion. */
  readonly goplus?: ((address: string) => Promise<GoPlusReport | null>) | null;
  readonly now?: () => number;
}

/**
 * The research RPCs in the order token discovery and the screen fork use them
 * (F-U2 Step 0): the secondary first, which allows wider log ranges and keeps
 * these reads off the key the forks and research share, and the primary as the
 * fallback. With one URL, that one.
 */
export function secondaryFirst(urls: readonly string[]): string[] {
  return urls.length > 1 ? [urls[1] as string, urls[0] as string, ...urls.slice(2)] : [...urls];
}

/** The screen runs on tokens at least this deep; shallower ones would fail on liquidity anyway. */
export const SCREEN_LOOP_MIN_LIQUIDITY_USD = 10_000;

export class TokenRegistry {
  private readonly o: TokenRegistryOptions;
  private readonly now: () => number;
  private discovering: Promise<DiscoverySummary> | null = null;
  private readonly screening = new Map<string, Promise<ScreenRecord>>();
  private readonly looking = new Map<string, Promise<TokenLookupResult>>();
  private readonly goplusBucket: TokenBucket;

  constructor(o: TokenRegistryOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    // GoPlus's free API allows about 30 calls a minute; the platform asks far less.
    this.goplusBucket = new TokenBucket({ capacity: 3, perMinute: 20, now: this.now });
  }

  get chainId() {
    return this.o.chainId;
  }

  get store() {
    return this.o.store;
  }

  get configured() {
    return { discovery: this.o.discovery !== null, screen: this.o.fork !== null };
  }

  /** One discovery pass, written to the registry; concurrent callers share it. */
  discover(): Promise<DiscoverySummary> {
    if (this.discovering) return this.discovering;
    const run = this.runDiscovery().finally(() => {
      this.discovering = null;
    });
    this.discovering = run;
    return run;
  }

  private async runDiscovery(): Promise<DiscoverySummary> {
    const d = this.o.discovery;
    if (!d) throw new RegistryError("NOT_CONFIGURED", "Token discovery needs a Monad mainnet RPC.");
    const runId = randomUUID();
    const { store, chainId } = this.o;
    await store.startRun(chainId, runId);
    try {
      const result = await d.discover(await store.knownState(chainId));
      const newPools = await store.saveDiscovery(chainId, result);
      await store.finishRun(runId, {
        status: "completed",
        poolsSeen: result.pools.length,
        tokensSeen: result.tokens.length,
        newPools,
        sources: result.sources,
      });
      return {
        runId,
        pools: result.pools.length,
        tokens: result.tokens.length,
        newPools,
        classF: result.tokens.filter((t) => t.priceClass === "F").length,
        classA: result.tokens.filter((t) => t.priceClass === "A").length,
        sources: result.sources,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "discovery failed";
      await store.finishRun(runId, { status: "failed", error: message });
      throw err;
    }
  }

  /**
   * One token and its pools, whether or not discovery ever saw it (D-360):
   * fresh registry data when the token was seen in the last half hour,
   * otherwise its pools are found from the token itself and saved, so the
   * next agent reuses them. `foundBy` is recorded only the first time.
   */
  lookup(address: string, foundBy: string): Promise<TokenLookupResult> {
    const a = address.toLowerCase();
    const running = this.looking.get(a);
    if (running) return running;
    const job = this.runLookup(a, foundBy).finally(() => this.looking.delete(a));
    this.looking.set(a, job);
    return job;
  }

  private async runLookup(address: string, foundBy: string): Promise<TokenLookupResult> {
    const { store, chainId } = this.o;
    const had = await store.token(chainId, address);
    if (had && this.now() - Date.parse(had.lastSeenAt) < LOOKUP_FRESH_MS)
      return { token: had, pools: await store.poolsOf(chainId, address), cacheHit: true };
    const d = this.o.discovery;
    if (!d) throw new RegistryError("NOT_CONFIGURED", "Token lookups need a Monad mainnet RPC.");
    const found = await d.poolsForToken(address, await store.knownState(chainId));
    if (!found.token)
      throw new RegistryError(
        "NOT_FOUND",
        "This address does not answer as an ERC-20 token on Monad.",
      );
    await store.saveDiscovery(chainId, { pools: found.pools, tokens: [found.token] }, foundBy);
    const token = await store.token(chainId, address);
    if (!token) throw new RegistryError("NOT_FOUND", "The token could not be saved.");
    return { token, pools: await store.poolsOf(chainId, address), cacheHit: false };
  }

  /** Tokens matching a symbol or name: the registry's first, then CoinGecko's and GeckoTerminal's. */
  async search(query: string): Promise<{ registry: TokenRow[]; candidates: TokenCandidate[] }> {
    const registry = await this.o.store.findBySymbol(this.o.chainId, query);
    const known = new Set(registry.map((t) => t.address));
    const candidates = this.o.discovery
      ? (await this.o.discovery.search(query)).filter((c) => !known.has(c.address))
      : [];
    return { registry, candidates };
  }

  /** What a look-alike is checked against: the listings, plus the platform's reviewed tokens. */
  async listings(): Promise<ListedToken[]> {
    const reviewed: ListedToken[] = [...CLASS_F_FEEDS, ...REVIEWED_TOKENS].map((t) => ({
      symbol: t.symbol,
      name: t.symbol,
      monadAddress: t.address,
      source: "reviewed",
    }));
    const d = this.o.discovery;
    if (!d) return reviewed;
    const l = await d.listings();
    return [...reviewed, ...guardedListings(l.coingecko, l.cmcTop, l.cmcMap)];
  }

  private async goplus(address: string): Promise<GoPlusReport | null> {
    if (this.o.goplus !== undefined) return this.o.goplus ? this.o.goplus(address) : null;
    try {
      return await fetchGoPlus(this.o.chainId, address, SCREEN_RULES.maxTaxBps / 10_000, {
        ...this.o.market.upstreamOptions(),
        bucket: this.goplusBucket,
      });
    } catch {
      return null;
    }
  }

  /** An issuer's official token list (D-359), cached for a day; entries without an address are dropped. */
  private async tokenList(url: string): Promise<TokenListEntry[]> {
    const r = await this.o.market.cache.get(
      cacheKey("tokenlist", "list", { url }),
      24 * 3600_000,
      () =>
        getJson({ provider: "tokenlist", url, timeoutMs: 20_000 }, this.o.market.upstreamOptions()),
    );
    const tokens = (r.value as { tokens?: unknown[] } | null)?.tokens ?? [];
    return tokens.flatMap((t) => {
      const e = t as { chainId?: unknown; address?: unknown; symbol?: unknown };
      return typeof e.chainId === "number" &&
        typeof e.address === "string" &&
        typeof e.symbol === "string"
        ? [{ chainId: e.chainId, address: e.address, symbol: e.symbol }]
        : [];
    });
  }

  /** The latest screen while it is fresh, else null. */
  async freshScreen(address: string): Promise<ScreenRecord | null> {
    const t = await this.o.store.token(this.o.chainId, address);
    if (!t?.screen?.fresh) return null;
    return this.o.store.screen(t.screen.screenId);
  }

  /** Runs a new screen now, or joins the one already running for this token. */
  screen(address: string, requestedBy: string): Promise<ScreenRecord> {
    const a = address.toLowerCase();
    const running = this.screening.get(a);
    if (running) return running;
    const job = this.runScreen(a, requestedBy).finally(() => this.screening.delete(a));
    this.screening.set(a, job);
    return job;
  }

  /** A fresh cached screen when there is one, else a new screen. */
  async screenOrCached(
    address: string,
    requestedBy: string,
  ): Promise<{ record: ScreenRecord; cacheHit: boolean }> {
    const cached = await this.freshScreen(address);
    if (cached) return { record: cached, cacheHit: true };
    return { record: await this.screen(address, requestedBy), cacheHit: false };
  }

  private async runScreen(address: string, requestedBy: string): Promise<ScreenRecord> {
    const { store, chainId } = this.o;
    const fork = this.o.fork;
    if (!fork) throw new RegistryError("NOT_CONFIGURED", "Token screens need a fork upstream.");
    // Any token an agent found can be screened (D-360): one the registry never saw is looked up first.
    const token =
      (await store.token(chainId, address)) ?? (await this.lookup(address, requestedBy)).token;
    const pools = await store.poolsOf(chainId, address);
    let outcome: ScreenOutcome;
    try {
      outcome = await runScreen(
        {
          token,
          pools,
          listings: await this.listings(),
        },
        {
          onFork: (fn) => fork.run(fn),
          goplus: (a) => this.goplus(a),
          tokenList: (url) => this.tokenList(url),
          now: this.now,
        },
      );
    } catch (err) {
      throw err instanceof MarketError || err instanceof RegistryError
        ? err
        : new RegistryError("UPSTREAM_UNAVAILABLE", "The screen fork could not run the screen.");
    }
    const createdAt = new Date(this.now());
    const record: ScreenRecord = {
      screenId: randomUUID(),
      chainId,
      address,
      verdict: outcome.verdict,
      checks: outcome.checks,
      route: outcome.route
        ? {
            pool: outcome.route.pool.poolId,
            dex: outcome.route.pool.dex,
            fee: outcome.route.pool.fee,
            tickSpacing: outcome.route.pool.tickSpacing,
            base: outcome.route.baseSymbol,
            simulation: outcome.route.simulation,
          }
        : null,
      forkBlock: outcome.forkBlock,
      requestedBy,
      durationMs: outcome.durationMs,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + SCREEN_RULES.ttlSeconds * 1000).toISOString(),
    };
    await store.saveScreen(record);
    return record;
  }

  /** Screens up to `limit` tokens whose screen is missing or expired, deepest first. */
  async screenDue(limit: number): Promise<ScreenRecord[]> {
    const due = await this.o.store.dueForScreen(
      this.o.chainId,
      SCREEN_LOOP_MIN_LIQUIDITY_USD,
      limit,
    );
    const out: ScreenRecord[] = [];
    for (const a of due) {
      try {
        out.push(await this.screen(a, "platform"));
      } catch {
        // One token's failure never stops the others; it is due again next tick.
      }
    }
    return out;
  }

  list(f: TokenFilter) {
    return this.o.store.listTokens(this.o.chainId, f);
  }

  newPools(hours: number, limit = 50) {
    return this.o.store.newPools(this.o.chainId, this.now() - hours * 3_600_000, limit);
  }

  async stop(): Promise<void> {
    await this.o.fork?.stop();
  }
}

/** A looked-up token is fresh for this long; older, its pools are found again. */
export const LOOKUP_FRESH_MS = 30 * 60_000;

export interface TokenLookupResult {
  readonly token: TokenRow;
  readonly pools: PoolRow[];
  /** True when the registry answered without reading the chain or GeckoTerminal. */
  readonly cacheHit: boolean;
}

export interface DiscoverySummary {
  readonly runId: string;
  readonly pools: number;
  readonly tokens: number;
  readonly newPools: number;
  readonly classF: number;
  readonly classA: number;
  readonly sources: Record<string, unknown>;
}
