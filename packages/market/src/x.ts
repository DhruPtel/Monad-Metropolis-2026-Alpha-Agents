import { type Cached, type MarketCache, cacheKey } from "./cache.ts";
import { type TokenBucket, type UpstreamDeps, getJson } from "./upstream.ts";
import type { DailyBudget } from "./usage.ts";

/**
 * X search for research (P3-U9): recent public posts about Monad through X's
 * official pay-per-use API (recent search, the last 7 days). Read-only: the
 * platform never posts, replies, likes, follows or messages, and acts for no
 * X user. The agent picks a topic from a curated list and the platform builds
 * the query, so no model-written text reaches X; the only accounts named are
 * the project's own official ones, and results carry no author identity, so
 * nothing here profiles or tracks a person. Posts are cached briefly (A-57)
 * and never stored, so a deleted post leaves the platform within the time to
 * live. Every post is third-party text: untrusted content, never instructions.
 *
 * Pay-per-use charges per post read (0.005 USD each on 2026-10-08), so each
 * request asks for X's minimum page of 10 posts, a daily budget of posts is
 * persisted (A-57), and the data tools cap each run (MK-S6).
 */
export const X_RECENT_SEARCH_URL = "https://api.x.com/2/tweets/search/recent";
/** X's smallest page for recent search; each post read is charged. */
export const X_PAGE_SIZE = 10;
/** A-57: posts read per UTC day across the platform (300 posts = 1.50 USD at X's rate). */
export const X_DAILY_POST_BUDGET = 300;
/** X's pay-per-use rate per post read, in micro-USD (2026-10-08). */
export const X_POST_READ_COST_USD_E6 = 5_000;

/** The project's official accounts, the only accounts the platform ever names (no individuals). */
export const X_OFFICIAL_ACCOUNTS = ["monad", "monad_dev", "monad_eco"] as const;

const NO_ECHO = "-is:retweet -is:reply lang:en";

/** The curated topics. The agent names one; the platform owns the query text. */
export const X_TOPICS = {
  monad_news: {
    label: "News and announcements about Monad and MON",
    query: `(monad OR #monad OR $MON) ${NO_ECHO}`,
  },
  monad_defi: {
    label: "DeFi on Monad: DEXs, liquidity, yields, lending, TVL",
    query: `monad (defi OR dex OR liquidity OR yield OR lending OR tvl) ${NO_ECHO}`,
  },
  mon_market: {
    label: "Market talk about the MON token: price, listings, flows",
    query: `($MON OR "MON token" OR "monad price") ${NO_ECHO}`,
  },
  monad_ecosystem: {
    label: "Launches, integrations, upgrades and partnerships on Monad",
    query: `monad (launch OR launches OR integration OR upgrade OR partnership OR mainnet) ${NO_ECHO}`,
  },
  monad_risk: {
    label: "Reported risks on Monad: exploits, outages, depegs",
    query: `monad (exploit OR hack OR hacked OR outage OR halted OR depeg OR drained) -is:retweet lang:en`,
  },
  official: {
    label: "Posts from Monad's official accounts",
    query: `(${X_OFFICIAL_ACCOUNTS.map((a) => `from:${a}`).join(" OR ")}) -is:retweet`,
  },
} as const;
export type XTopic = keyof typeof X_TOPICS;
export const X_TOPIC_IDS = Object.keys(X_TOPICS) as XTopic[];

/** How far back a search reaches, in hours (recent search covers 7 days). */
export const X_WINDOWS = [6, 24, 72] as const;
export type XWindow = (typeof X_WINDOWS)[number];

export interface XPost {
  readonly id: string;
  readonly createdAt: string;
  /** Raw third-party text; the data tools strip, cap and mark it before the model sees it. */
  readonly text: string;
  readonly likes: number;
  readonly reposts: number;
  readonly replies: number;
  readonly quotes: number;
  readonly impressions: number | null;
}

export interface XSearchResult {
  readonly topic: XTopic;
  readonly windowHours: XWindow;
  /** The query the platform sent, for the record; built from the topic, never by the model. */
  readonly query: string;
  readonly fromOfficialAccounts: boolean;
  readonly posts: readonly XPost[];
  readonly searchedAt: string;
}

const count = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;

/** The recent search answer as posts; anything malformed is dropped, never guessed. */
export function xPosts(body: unknown): XPost[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: XPost[] = [];
  for (const p of data as Record<string, unknown>[]) {
    if (typeof p?.id !== "string" || !/^\d{1,25}$/.test(p.id) || typeof p.text !== "string")
      continue;
    const created = typeof p.created_at === "string" ? Date.parse(p.created_at) : Number.NaN;
    if (Number.isNaN(created)) continue;
    const m = (p.public_metrics ?? {}) as Record<string, unknown>;
    out.push({
      id: p.id,
      createdAt: new Date(created).toISOString(),
      text: p.text.slice(0, 4_000),
      likes: count(m.like_count),
      reposts: count(m.retweet_count),
      replies: count(m.reply_count),
      quotes: count(m.quote_count),
      impressions: typeof m.impression_count === "number" ? count(m.impression_count) : null,
    });
  }
  return out.slice(0, X_PAGE_SIZE);
}

/** The request URL for a topic and window. The bearer token travels in a header only. */
export function xSearchUrl(topic: XTopic, windowHours: XWindow, nowMs: number): string {
  const u = new URL(X_RECENT_SEARCH_URL);
  u.searchParams.set("query", X_TOPICS[topic].query);
  u.searchParams.set("max_results", String(X_PAGE_SIZE));
  // X wants start_time at least 10 s in the past and within 7 days; whole minutes keep the cache key stable.
  const start = Math.floor((nowMs - windowHours * 3_600_000) / 60_000) * 60_000;
  u.searchParams.set("start_time", new Date(start).toISOString().replace(/\.\d{3}Z$/, "Z"));
  u.searchParams.set("tweet.fields", "created_at,public_metrics,lang");
  return u.toString();
}

/** A-57: X results are cached 15 minutes, then dropped. */
export const X_TTL_MS = 15 * 60_000;

export interface XSearchDeps extends UpstreamDeps {
  readonly bearerToken: string;
  readonly budget: DailyBudget;
  readonly bucket?: TokenBucket;
  readonly cache: MarketCache;
  readonly now: () => number;
}

export const xCacheKey = (topic: XTopic, windowHours: XWindow) =>
  cacheKey("x", "recent", { topic, windowHours });

/**
 * Recent posts for a topic, through the shared cache: many agents asking the
 * same topic within the time to live make one request. A full page of posts is
 * reserved from the daily budget first and corrected to the posts returned.
 */
export async function xSearch(
  topic: XTopic,
  windowHours: XWindow,
  deps: XSearchDeps,
): Promise<Cached<XSearchResult>> {
  return deps.cache.get(xCacheKey(topic, windowHours), X_TTL_MS, async () => {
    await deps.budget.reserve(X_PAGE_SIZE);
    let body: unknown;
    try {
      body = await getJson(
        {
          provider: "x",
          url: xSearchUrl(topic, windowHours, deps.now()),
          headers: { authorization: `Bearer ${deps.bearerToken}` },
          // A post read is charged on every answer, so a failure is retried once at most.
          attempts: 2,
        },
        deps,
      );
    } catch (err) {
      await deps.budget.adjust(-X_PAGE_SIZE);
      throw err;
    }
    const posts = xPosts(body);
    const counted = count((body as { meta?: { result_count?: unknown } })?.meta?.result_count);
    await deps.budget.adjust(Math.min(X_PAGE_SIZE, Math.max(posts.length, counted)) - X_PAGE_SIZE);
    return {
      topic,
      windowHours,
      query: X_TOPICS[topic].query,
      fromOfficialAccounts: topic === "official",
      posts,
      searchedAt: new Date(deps.now()).toISOString(),
    };
  });
}
