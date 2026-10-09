import { MarketError } from "./upstream.ts";

/**
 * Daily usage of a paid upstream (P3-U9): CoinMarketCap credits, X posts read,
 * Dune requests. The count lives in a store the platform persists (Postgres
 * in the orchestrator), so a restart never resets a day's budget; the memory
 * store is for tests and tools that run once. Days are UTC.
 */
export interface UsageStore {
  /**
   * Adds `units` to the provider's count for `day` unless the total would
   * pass `limit`, atomically. Returns the new total, or null when refused.
   */
  reserve(provider: string, day: string, units: number, limit: number): Promise<number | null>;
  /** Adds `units` (negative to release) with no limit: a correction once the provider reports its real charge. */
  add(provider: string, day: string, units: number): Promise<void>;
  used(provider: string, day: string): Promise<number>;
}

export class MemoryUsageStore implements UsageStore {
  private readonly counts = new Map<string, number>();

  async reserve(provider: string, day: string, units: number, limit: number) {
    const k = `${provider}|${day}`;
    const next = (this.counts.get(k) ?? 0) + units;
    if (next > limit) return null;
    this.counts.set(k, next);
    return next;
  }

  async add(provider: string, day: string, units: number) {
    const k = `${provider}|${day}`;
    this.counts.set(k, Math.max(0, (this.counts.get(k) ?? 0) + units));
  }

  async used(provider: string, day: string) {
    return this.counts.get(`${provider}|${day}`) ?? 0;
  }
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A provider's hard daily budget, in its own unit (credits, posts, requests). */
export class DailyBudget {
  readonly provider: string;
  readonly limit: number;
  readonly unit: string;
  private readonly store: UsageStore;
  private readonly now: () => number;

  constructor(o: {
    provider: string;
    limit: number;
    unit: string;
    store: UsageStore;
    now?: () => number;
  }) {
    this.provider = o.provider;
    this.limit = o.limit;
    this.unit = o.unit;
    this.store = o.store;
    this.now = o.now ?? Date.now;
  }

  /** Reserves `units` of today's budget, or refuses with RATE_LIMITED until 00:00 UTC. */
  async reserve(units: number): Promise<void> {
    const t = this.now();
    const total =
      units > this.limit
        ? null
        : await this.store.reserve(this.provider, utcDay(t), units, this.limit);
    if (total !== null) return;
    const d = new Date(t);
    const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    throw new MarketError(
      "RATE_LIMITED",
      this.provider,
      `${this.provider}: the platform's daily budget of ${this.limit} ${this.unit} is used; it resets at 00:00 UTC.`,
      { retryable: true, retryAfterSeconds: Math.ceil((midnight - t) / 1000) },
    );
  }

  /** Corrects today's count by `delta` once the real charge is known (negative releases a reservation). */
  async adjust(delta: number): Promise<void> {
    if (delta !== 0) await this.store.add(this.provider, utcDay(this.now()), delta);
  }

  async usedToday(): Promise<number> {
    return this.store.used(this.provider, utcDay(this.now()));
  }
}
