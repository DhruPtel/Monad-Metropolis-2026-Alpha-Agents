import type { Address } from "viem";
import type { Cached } from "./cache.ts";
import {
  DUNE_QUERY_NAMES,
  DUNE_DAILY_EXECUTION_BUDGET,
  DUNE_DAILY_READ_BUDGET,
  type DuneDays,
  type DuneQueryName,
  type DuneResult,
  duneCacheKey,
  duneQuery,
  duneQueryIds,
  duneWindow,
} from "./dune.ts";
import {
  type BalanceResult,
  type CodeResult,
  type MainnetLookup,
  type ReadFunction,
  type ReadResult,
  cachedLookup,
  lookupKey,
} from "./lookup.ts";
import type { MarketData } from "./service.ts";
import { MarketError, TokenBucket } from "./upstream.ts";
import { DailyBudget } from "./usage.ts";
import {
  X_DAILY_POST_BUDGET,
  X_TOPIC_IDS,
  X_WINDOWS,
  type XSearchResult,
  type XTopic,
  type XWindow,
  xCacheKey,
  xSearch,
} from "./x.ts";

/**
 * The research sources beyond market data (P3-U9): X search, saved Dune
 * queries and mainnet contract lookups, on the market service's shared cache,
 * clock and persisted daily budgets, so every agent and the console see one
 * cache and one count. Each source is optional: without its key or RPC it
 * answers UPSTREAM_UNAVAILABLE, "not configured".
 */
export interface ResearchSourcesOptions {
  readonly market: MarketData;
  readonly xBearerToken: string | null;
  readonly duneApiKey: string | null;
  readonly lookup: MainnetLookup | null;
  /** Tests give the saved queries' IDs; the service reads dune/queries.json. */
  readonly duneIds?: Record<DuneQueryName, number | null>;
  readonly duneExecutionWaitMs?: number;
}

const notConfigured = (provider: string, what: string) =>
  new MarketError("UPSTREAM_UNAVAILABLE", provider, `${what} is not configured on this platform.`, {
    retryable: false,
  });

export class ResearchSources {
  readonly xPosts: DailyBudget;
  readonly duneReads: DailyBudget;
  readonly duneExecutions: DailyBudget;
  private readonly o: ResearchSourcesOptions;
  private readonly buckets: { x: TokenBucket; dune: TokenBucket };

  constructor(o: ResearchSourcesOptions) {
    this.o = o;
    const { usage, now } = o.market;
    const budget = (provider: string, limit: number, unit: string) =>
      new DailyBudget({ provider, limit, unit, store: usage, now });
    this.xPosts = budget("x", X_DAILY_POST_BUDGET, "posts read");
    this.duneReads = budget("dune", DUNE_DAILY_READ_BUDGET, "result reads");
    this.duneExecutions = budget("dune_exec", DUNE_DAILY_EXECUTION_BUDGET, "query runs");
    const sleep = o.market.upstreamOptions().sleep;
    // X allows 450 recent searches per 15 minutes per app; Dune's free plan is low. The platform stays far under both.
    this.buckets = {
      x: new TokenBucket({ capacity: 3, perMinute: 10, now, ...(sleep ? { sleep } : {}) }),
      dune: new TokenBucket({ capacity: 5, perMinute: 15, now, ...(sleep ? { sleep } : {}) }),
    };
  }

  get configured() {
    return {
      x: this.o.xBearerToken !== null,
      dune: this.o.duneApiKey !== null,
      lookup: this.o.lookup !== null,
    };
  }

  /** Whether a call with this input would be answered from the cache: such a call is free (D-322). */
  isCached(
    q:
      | { tool: "x_search"; topic: XTopic; windowHours: XWindow }
      | { tool: "dune_query"; name: DuneQueryName }
      | { tool: "read_contract"; fn: ReadFunction; target: Address; args: Record<string, string> }
      | { tool: "balance"; target: Address; asset: BalanceResult["asset"] }
      | { tool: "get_code"; target: Address },
  ): boolean {
    const c = this.o.market.cache;
    switch (q.tool) {
      case "x_search":
        return c.isFresh(xCacheKey(q.topic, q.windowHours));
      case "dune_query":
        return c.isFresh(duneCacheKey(q.name));
      case "read_contract":
        return c.isFresh(
          lookupKey("read", { fn: q.fn, target: q.target.toLowerCase(), args: q.args }),
        );
      case "balance":
        return c.isFresh(lookupKey("balance", { target: q.target.toLowerCase(), asset: q.asset }));
      case "get_code":
        return c.isFresh(lookupKey("code", { target: q.target.toLowerCase() }));
    }
  }

  async xSearch(topic: XTopic, windowHours: XWindow): Promise<Cached<XSearchResult>> {
    const token = this.o.xBearerToken;
    if (!token) throw notConfigured("x", "X search");
    const m = this.o.market;
    return xSearch(topic, windowHours, {
      bearerToken: token,
      budget: this.xPosts,
      cache: m.cache,
      now: m.now,
      bucket: this.buckets.x,
      ...m.upstreamOptions(),
    });
  }

  async dune(name: DuneQueryName, days: DuneDays): Promise<Cached<DuneResult>> {
    const key = this.o.duneApiKey;
    if (!key) throw notConfigured("dune", "Dune");
    const m = this.o.market;
    const r = await duneQuery(name, {
      apiKey: key,
      reads: this.duneReads,
      executions: this.duneExecutions,
      cache: m.cache,
      now: m.now,
      bucket: this.buckets.dune,
      ids: this.o.duneIds ?? duneQueryIds(),
      ...(this.o.duneExecutionWaitMs === undefined
        ? {}
        : { executionWaitMs: this.o.duneExecutionWaitMs }),
      ...m.upstreamOptions(),
    });
    return { ...r, value: duneWindow(r.value, days) };
  }

  private lookups() {
    if (!this.o.lookup) throw notConfigured("monad", "Monad mainnet reads");
    return cachedLookup(this.o.lookup, this.o.market.cache);
  }

  readContract(
    fn: ReadFunction,
    target: Address,
    args: Record<string, string>,
  ): Promise<Cached<ReadResult>> {
    return this.lookups().read(fn, target, args);
  }

  balance(target: Address, asset: BalanceResult["asset"]): Promise<Cached<BalanceResult>> {
    return this.lookups().balance(target, asset);
  }

  code(target: Address): Promise<Cached<CodeResult>> {
    return this.lookups().code(target);
  }

  /**
   * What the shared cache holds now, for the console: each live X search with
   * its posts and each Dune result, with when it expires. Nothing is fetched,
   * and an expired entry is gone (X posts are never kept past their time to live).
   */
  cachedView() {
    const c = this.o.market.cache;
    const x = X_TOPIC_IDS.flatMap((topic) =>
      X_WINDOWS.flatMap((w) => {
        const e = c.peek<XSearchResult>(xCacheKey(topic, w));
        return e ? [{ ...e.value, expiresAt: new Date(e.expiresAt).toISOString() }] : [];
      }),
    );
    const dune = DUNE_QUERY_NAMES.flatMap((name) => {
      const e = c.peek<DuneResult>(duneCacheKey(name));
      return e ? [{ ...e.value, expiresAt: new Date(e.expiresAt).toISOString() }] : [];
    });
    return { x, dune };
  }

  /** Today's use of each paid source, for the console. */
  async usageToday() {
    return {
      xPostsRead: await this.xPosts.usedToday(),
      xPostsLimit: this.xPosts.limit,
      duneResultReads: await this.duneReads.usedToday(),
      duneResultReadsLimit: this.duneReads.limit,
      duneQueryRuns: await this.duneExecutions.usedToday(),
      duneQueryRunsLimit: this.duneExecutions.limit,
    };
  }
}
