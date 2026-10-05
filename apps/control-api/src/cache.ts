/**
 * A small time-based cache for index queries: many pages asking within a
 * moment share one database read. Keys are whole query strings.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = load();
    this.entries.set(key, { at: this.now(), value });
    // A failed load is never served from the cache.
    value.catch(() => this.entries.delete(key));
    if (this.entries.size > 1_000) this.entries.delete(this.entries.keys().next().value as string);
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
