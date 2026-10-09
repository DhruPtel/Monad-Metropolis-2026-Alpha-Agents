import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { DailyBudget, MarketData } from "@alpha-agents/market";
import { fixture } from "@alpha-agents/market/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgUsageStore } from "./usage-store.ts";

const dbUp = await databaseAvailable();

describe.skipIf(!dbUp)(
  "daily usage in Postgres (P3-U9, needs Postgres)",
  { timeout: 60_000 },
  () => {
    let t: TestDatabase;

    beforeAll(async () => {
      t = await createTestDatabase("orch_usage");
    }, 60_000);
    afterAll(async () => {
      await t?.drop();
    }, 60_000);

    it("reserves within the limit only, atomically under concurrent callers", async () => {
      const store = new PgUsageStore(t.db);
      const results = await Promise.all(
        Array.from({ length: 12 }, () => store.reserve("x", "2026-10-08", 10, 50)),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(5);
      expect(await store.used("x", "2026-10-08")).toBe(50);
      expect(await store.reserve("x", "2026-10-08", 1, 50)).toBeNull();
      // A correction never goes below zero, and another day is its own count.
      await store.add("x", "2026-10-08", -100);
      expect(await store.used("x", "2026-10-08")).toBe(0);
      expect(await store.used("x", "2026-10-09")).toBe(0);
    });

    it("keeps CoinMarketCap's credits across a restart of the market service", async () => {
      const now = () => Date.parse("2026-10-08T12:00:00Z");
      const fetch = async () =>
        new Response(JSON.stringify(fixture("cmc-quotes.json")), {
          headers: { "content-type": "application/json" },
        });
      const first = new MarketData({
        cmcApiKey: "k",
        mainnet: null,
        fetch,
        now,
        usage: new PgUsageStore(t.db),
      });
      await first.prices();
      // A new service, as after a restart, reads the same day's count.
      const second = new MarketData({
        cmcApiKey: "k",
        mainnet: null,
        fetch,
        now,
        usage: new PgUsageStore(t.db),
      });
      expect(await second.cmcBudget.usedToday()).toBe(1);
      const budget = new DailyBudget({
        provider: "coinmarketcap",
        limit: 1,
        unit: "credits",
        store: new PgUsageStore(t.db),
        now,
      });
      await expect(budget.reserve(1)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    });
  },
);
