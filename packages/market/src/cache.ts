/**
 * The shared market data cache (P3-U2): one per platform process, keyed by
 * provider, method and normalized input, with a time to live per source. All
 * agents read through it, and concurrent misses for one key share a single
 * upstream request (single flight). A failure is never cached, and an expired
 * entry is never served when its refresh fails: the caller gets the error, not
 * old data presented as fresh.
 */
export interface Cached<T> {
  readonly value: T;
  /** True when this answer came from the cache or from another caller's request in flight. */
  readonly cacheHit: boolean;
  /** When the upstream answered, ms since the epoch. */
  readonly fetchedAt: number;
}

interface Entry {
  readonly value: unknown;
  readonly fetchedAt: number;
  readonly expiresAt: number;
}

/** A stable key for an input: object keys sorted, so the same question is the same key. */
export function cacheKey(provider: string, method: string, input: unknown = null): string {
  const norm = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(norm)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
          )
        : v;
  return `${provider}|${method}|${JSON.stringify(norm(input))}`;
}

export class MarketCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Entry>>();
  private readonly now: () => number;
  /** Upstream requests made, per provider: for tests and the console. */
  readonly upstreamCalls = new Map<string, number>();

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<Cached<T>> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > this.now())
      return { value: hit.value as T, cacheHit: true, fetchedAt: hit.fetchedAt };
    const running = this.inflight.get(key);
    if (running) {
      const e = await running;
      return { value: e.value as T, cacheHit: true, fetchedAt: e.fetchedAt };
    }
    const provider = key.split("|")[0] ?? "unknown";
    const p = (async () => {
      this.upstreamCalls.set(provider, (this.upstreamCalls.get(provider) ?? 0) + 1);
      const value = await load();
      const fetchedAt = this.now();
      const e: Entry = { value, fetchedAt, expiresAt: fetchedAt + ttlMs };
      this.entries.set(key, e);
      return e;
    })();
    this.inflight.set(key, p);
    try {
      const e = await p;
      return { value: e.value as T, cacheHit: false, fetchedAt: e.fetchedAt };
    } catch (err) {
      // An expired entry is dropped with the failed refresh, never served as fresh.
      this.entries.delete(key);
      throw err;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Whether the key holds an answer that has not expired: a read now would make no request. */
  isFresh(key: string): boolean {
    const e = this.entries.get(key);
    return e !== undefined && e.expiresAt > this.now();
  }

  /** When each cached key was last fetched, for the console's freshness view. */
  freshness(): { key: string; fetchedAt: number; expiresAt: number }[] {
    return [...this.entries].map(([key, e]) => ({
      key,
      fetchedAt: e.fetchedAt,
      expiresAt: e.expiresAt,
    }));
  }
}
