import { type Db, sql } from "@alpha-agents/db";
import type { UsageStore } from "@alpha-agents/market";

/**
 * The daily usage of paid upstreams in Postgres (P3-U9), so a restart of the
 * orchestrator never resets a day's CoinMarketCap credits, X posts or Dune
 * requests. A reservation is one statement: the row's total only grows when
 * the result stays within the limit, so concurrent callers cannot pass it.
 */
export class PgUsageStore implements UsageStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async reserve(provider: string, day: string, units: number, limit: number) {
    if (units > limit) return null;
    const r = await sql<{ used: number }>`
      insert into platform.provider_usage as u (provider, day, used)
      values (${provider}, ${day}::date, ${units})
      on conflict (provider, day) do update
        set used = u.used + excluded.used, updated_at = now()
        where u.used + excluded.used <= ${limit}
      returning u.used`.execute(this.db);
    return r.rows[0] ? Number(r.rows[0].used) : null;
  }

  async add(provider: string, day: string, units: number) {
    await sql`
      insert into platform.provider_usage as u (provider, day, used)
      values (${provider}, ${day}::date, ${Math.max(0, units)})
      on conflict (provider, day) do update
        set used = greatest(0, u.used + ${units}), updated_at = now()`.execute(this.db);
  }

  async used(provider: string, day: string) {
    const row = await this.db
      .selectFrom("platform.provider_usage")
      .select("used")
      .where("provider", "=", provider)
      .where("day", "=", day)
      .executeTakeFirst();
    return row ? Number(row.used) : 0;
  }
}
