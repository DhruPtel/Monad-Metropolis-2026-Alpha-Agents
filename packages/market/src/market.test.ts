import { readFileSync } from "node:fs";
import { createPublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketCache, cacheKey } from "./cache.ts";
import { CMC_QUOTES_URL, cmcQuotes, fetchCmcQuotes } from "./coinmarketcap.ts";
import {
  LLAMA_URLS,
  chainTvl,
  chartPoints,
  dexVolumes,
  monadProtocols,
  monadYields,
} from "./defillama.ts";
import type { Figure } from "./figures.ts";
import { type Refusal, crossCheck, guard } from "./guards.ts";
import { type MainnetMarketReader, impactBps, midPriceFromSqrt } from "./mainnet.ts";
import { readOnlyTransport } from "./readonly.ts";
import { MarketData } from "./service.ts";
import { cleanText } from "./text.ts";
import { MarketError, TokenBucket, getJson, retryAfterSeconds } from "./upstream.ts";
import { DailyBudget, MemoryUsageStore } from "./usage.ts";
import { type PricePoint, realizedVolatility } from "./volatility.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as unknown;
/** Five minutes after the recorded CoinMarketCap quote. */
const NOW_MS = Date.parse("2026-10-08T22:50:00Z");
const NOW = Math.floor(NOW_MS / 1000);
const ctx = (refusals: Refusal[] = []) => ({
  now: NOW,
  onRefuse: (r: Refusal) => refusals.push(r),
});

/** No waiting in tests: the retry rules are checked by what they would wait. */
const noSleep = () => Promise.resolve();
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("plausibility guards (P3-U2, lesson 1)", () => {
  it("serves a value inside its range with its source and time", () => {
    expect(guard("monPriceUsd", 0.0241, "coinmarketcap", NOW - 60, 900, ctx())).toEqual({
      value: 0.0241,
      source: "coinmarketcap",
      asOf: new Date((NOW - 60) * 1000).toISOString(),
      warnings: [],
    });
  });

  it("refuses and logs a value outside its range, and never serves it", () => {
    const refusals: Refusal[] = [];
    for (const bad of [5_000, 0, -1, Number.NaN, "abc"]) {
      const f = guard("monPriceUsd", bad, "coinmarketcap", NOW, 900, ctx(refusals));
      expect(f.value).toBeNull();
      expect(f.warnings.map((w) => w.code)).toEqual(["REFUSED_OUT_OF_RANGE"]);
    }
    expect(refusals).toHaveLength(5);
    expect(refusals[0]).toMatchObject({
      field: "monPriceUsd",
      source: "coinmarketcap",
      value: 5_000,
    });
  });

  it("flags a missing value and an old one, without hiding the old value", () => {
    expect(guard("volume24hUsd", null, "coinmarketcap", NOW, 900, ctx()).warnings[0]?.code).toBe(
      "MISSING",
    );
    const old = guard("chainTvlUsd", 1e9, "defillama", NOW - 3 * 86_400, 2 * 86_400, ctx());
    expect(old.value).toBe(1e9);
    expect(old.warnings[0]).toMatchObject({ code: "STALE" });
  });

  it("keeps two sources apart and flags both when they disagree past the tolerance (lesson 2)", () => {
    const a: Figure = { value: 0.025, source: "coinmarketcap", asOf: "", warnings: [] };
    const b: Figure = { value: 0.024, source: "chainlink", asOf: "", warnings: [] };
    const [x, y] = crossCheck(a, b, 300);
    expect([x.value, y.value]).toEqual([0.025, 0.024]);
    expect(x.warnings[0]?.message).toContain("4.17% away from chainlink's figure");
    expect(y.warnings[0]?.code).toBe("SOURCES_DISAGREE");
    expect(crossCheck(a, { ...b, value: 0.0249 }, 300)[0].warnings).toEqual([]);
  });
});

describe("realized volatility (method named)", () => {
  const hourly = (prices: number[], end = NOW): PricePoint[] =>
    prices.map((price, i) => ({ t: end - (prices.length - 1 - i) * 3_600, price }));

  it("is zero for a constant price and for steady growth", () => {
    expect(realizedVolatility(hourly(Array(25).fill(1)), "24h").annualizedPct).toBe(0);
    const steady = Array.from({ length: 25 }, (_, i) => 1.001 ** i);
    expect(realizedVolatility(hourly(steady), "24h").annualizedPct).toBeCloseTo(0, 6);
  });

  it("matches a hand computation: alternating +1% and -1% hourly log returns", () => {
    // Returns alternate +0.01 and -0.01 (24 of them): mean 0, sample variance 24 * 0.0001 / 23.
    const prices = [1];
    for (let i = 0; i < 24; i++)
      prices.push((prices.at(-1) as number) * Math.exp(i % 2 === 0 ? 0.01 : -0.01));
    const r = realizedVolatility(hourly(prices), "24h");
    const expected = Math.sqrt((24 * 0.0001) / 23) * Math.sqrt(8_760) * 100;
    expect(r.returns).toBe(24);
    expect(r.annualizedPct).toBeCloseTo(expected, 9);
  });

  it("uses only the window's points and reports thin history", () => {
    const r = realizedVolatility(hourly(Array(5).fill(2)), "7d");
    expect([r.returns, r.minReturns]).toEqual([4, 150]);
    expect(realizedVolatility([], "24h").annualizedPct).toBeNull();
  });

  it("computes the recorded MON history's windows", () => {
    const h = chartPoints(fixture("llama-chart-1h.json"));
    const f = chartPoints(fixture("llama-chart-4h.json"));
    expect(h.length).toBe(168);
    const d1 = realizedVolatility(h, "24h");
    const d30 = realizedVolatility(f, "30d");
    expect(d1.returns).toBeGreaterThanOrEqual(20);
    expect(d30.returns).toBeGreaterThanOrEqual(160);
    expect(d1.annualizedPct).toBeGreaterThan(5);
    expect(d1.annualizedPct).toBeLessThan(500);
  });
});

describe("upstream hygiene", () => {
  it("waits out a 429's Retry-After, then succeeds", async () => {
    const waits: number[] = [];
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "3" } }))
      .mockResolvedValueOnce(json({ ok: 1 }));
    const body = await getJson(
      { provider: "p", url: "https://x.test/a" },
      { fetch: f, sleep: async (ms) => void waits.push(ms) },
    );
    expect(body).toEqual({ ok: 1 });
    expect(waits).toEqual([3_000]);
  });

  it("does not retry a 400, and returns a 429 it should not wait out", async () => {
    const f400 = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 400 }));
    await expect(
      getJson({ provider: "p", url: "https://x.test" }, { fetch: f400, sleep: noSleep }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      retryable: false,
      status: 400,
    });
    expect(f400).toHaveBeenCalledTimes(1);
    const f429 = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 429, headers: { "retry-after": "120" } }));
    await expect(
      getJson({ provider: "p", url: "https://x.test" }, { fetch: f429, sleep: noSleep }),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 120,
    });
    expect(f429).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx and a dropped connection, and reports a timeout as unavailable without retrying", async () => {
    const flaky = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("socket hang up"))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(json([1]));
    expect(
      await getJson({ provider: "p", url: "https://x.test" }, { fetch: flaky, sleep: noSleep }),
    ).toEqual([1]);
    expect(flaky).toHaveBeenCalledTimes(3);
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const slow = vi.fn<typeof fetch>().mockRejectedValue(timeout);
    await expect(
      getJson({ provider: "p", url: "https://x.test" }, { fetch: slow, sleep: noSleep }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      retryable: true,
    });
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("reads Retry-After as seconds or a date", () => {
    expect(retryAfterSeconds("7")).toBe(7);
    expect(retryAfterSeconds(new Date(NOW_MS + 30_000).toUTCString(), NOW_MS)).toBe(30);
    expect(retryAfterSeconds(null)).toBeNull();
  });

  it("the token bucket waits for a token, and refuses past its longest wait", async () => {
    let t = 0;
    const waits: number[] = [];
    const bucket = new TokenBucket({
      capacity: 1,
      perMinute: 60,
      now: () => t,
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    await bucket.take("p");
    await bucket.take("p");
    expect(waits).toEqual([1_000]);
    const slow = new TokenBucket({ capacity: 1, perMinute: 1, now: () => 0 });
    await slow.take("p");
    await expect(slow.take("p", 1_000)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 60,
    });
  });
});

describe("the shared cache", () => {
  it("answers concurrent and repeated questions with one upstream request", async () => {
    let t = 0;
    const cache = new MarketCache(() => t);
    const load = vi.fn(async () => ({ price: 1 }));
    const key = cacheKey("coinmarketcap", "quotes");
    const [a, b] = await Promise.all([cache.get(key, 1_000, load), cache.get(key, 1_000, load)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect([a.cacheHit, b.cacheHit]).toEqual([false, true]);
    expect((await cache.get(key, 1_000, load)).cacheHit).toBe(true);
    t = 1_001;
    expect((await cache.get(key, 1_000, load)).cacheHit).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.upstreamCalls.get("coinmarketcap")).toBe(2);
  });

  it("never caches a failure or serves an expired value when the refresh fails", async () => {
    let t = 0;
    const cache = new MarketCache(() => t);
    const key = cacheKey("defillama", "tvl");
    await cache.get(key, 100, async () => 1);
    t = 200;
    const down = new MarketError("UPSTREAM_UNAVAILABLE", "defillama", "down", { retryable: true });
    await expect(cache.get(key, 100, async () => Promise.reject(down))).rejects.toBe(down);
    expect((await cache.get(key, 100, async () => 2)).value).toBe(2);
  });

  it("keys the same input the same whatever its key order", () => {
    expect(cacheKey("p", "m", { a: 1, b: 2 })).toBe(cacheKey("p", "m", { b: 2, a: 1 }));
  });
});

describe("CoinMarketCap (D-321)", () => {
  it("reads MON and USDC by ID from the recorded answer", () => {
    const [mon, usdc] = cmcQuotes(fixture("cmc-quotes.json"), ctx());
    expect(mon).toMatchObject({
      asset: "MON",
      priceUsd: { source: "coinmarketcap", warnings: [] },
    });
    expect(mon?.priceUsd.value).toBeCloseTo(0.0241156, 6);
    expect(mon?.change24hPct.value).toBeCloseTo(-6.52, 2);
    expect(mon?.marketCapUsd.value).toBeGreaterThan(1e8);
    expect(usdc?.priceUsd.value).toBeCloseTo(1, 2);
  });

  it("sends the key in a header, never the URL, and spends from the daily budget", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json(fixture("cmc-quotes.json")));
    const budget = new DailyBudget({
      provider: "coinmarketcap",
      limit: 2,
      unit: "credits",
      store: new MemoryUsageStore(),
      now: () => NOW_MS,
    });
    await fetchCmcQuotes({ apiKey: "test-key-not-real", budget, fetch: f });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CMC_QUOTES_URL);
    expect(url).not.toContain("test-key");
    expect((init.headers as Record<string, string>)["X-CMC_PRO_API_KEY"]).toBe("test-key-not-real");
    expect(await budget.usedToday()).toBe(1);
    await fetchCmcQuotes({ apiKey: "k", budget, fetch: f });
    await expect(fetchCmcQuotes({ apiKey: "k", budget, fetch: f })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("keeps the day's credits in the shared store, so a new service (a restart) continues the count", async () => {
    const store = new MemoryUsageStore();
    const f = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json(fixture("cmc-quotes.json")));
    const budget = () =>
      new DailyBudget({
        provider: "coinmarketcap",
        limit: 2,
        unit: "credits",
        store,
        now: () => NOW_MS,
      });
    await fetchCmcQuotes({ apiKey: "k", budget: budget(), fetch: f });
    await fetchCmcQuotes({ apiKey: "k", budget: budget(), fetch: f });
    await expect(fetchCmcQuotes({ apiKey: "k", budget: budget(), fetch: f })).rejects.toMatchObject(
      {
        code: "RATE_LIMITED",
      },
    );
    // The next UTC day starts again.
    const tomorrow = new DailyBudget({
      provider: "coinmarketcap",
      limit: 2,
      unit: "credits",
      store,
      now: () => NOW_MS + 86_400_000,
    });
    expect(await tomorrow.usedToday()).toBe(0);
  });

  it("releases the reserved credit when the request fails", async () => {
    const store = new MemoryUsageStore();
    const budget = new DailyBudget({
      provider: "coinmarketcap",
      limit: 5,
      unit: "credits",
      store,
      now: () => NOW_MS,
    });
    const f = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("no", { status: 401 }));
    await expect(fetchCmcQuotes({ apiKey: "k", budget, fetch: f })).rejects.toMatchObject({
      retryable: false,
    });
    expect(await budget.usedToday()).toBe(0);
  });
});

describe("DefiLlama", () => {
  it("reads Monad's chain TVL, its 7-day change and 30 days of history", () => {
    const t = chainTvl(fixture("llama-chain-tvl.json"), ctx());
    expect(t.tvlUsd).toMatchObject({ source: "defillama" });
    expect(t.tvlUsd.value).toBeGreaterThan(1e8);
    expect(t.change7dPct.value).not.toBeNull();
    expect(t.history).toHaveLength(30);
  });

  it("lists only protocols on Monad, by their Monad TVL", () => {
    const p = monadProtocols(fixture("llama-protocols.json"), NOW, 5, ctx());
    expect(p).toHaveLength(5);
    const tvls = p.map((x) => x.tvlUsd.value as number);
    expect([...tvls].sort((a, b) => b - a)).toEqual(tvls);
    expect(p[0]?.name).toBe("Aave V3");
  });

  it("lists Monad's yield pools, and filters by asset", () => {
    const all = monadYields(fixture("llama-yields.json"), NOW, { limit: 20, asset: null }, ctx());
    expect(all.length).toBe(15);
    const usdc = monadYields(
      fixture("llama-yields.json"),
      NOW,
      { limit: 20, asset: "USDC" },
      ctx(),
    );
    expect(usdc.length).toBeGreaterThan(0);
    expect(usdc.every((y) => y.symbol.toUpperCase().includes("USDC"))).toBe(true);
    expect(usdc[0]?.apyRewardPct.value).not.toBeNull();
  });

  it("reads Monad's DEX volumes and their top venues", () => {
    const d = dexVolumes(fixture("llama-dexs.json"), NOW, ctx());
    expect(d.total24hUsd.value).toBeGreaterThan(0);
    expect(d.top[0]?.name).toBe("Uniswap V4");
  });
});

describe("upstream text", () => {
  it("strips control, zero-width and bidi characters, and caps the length", () => {
    const sneaky = `Aave${String.fromCharCode(0x202e)} V3${String.fromCharCode(0x200b)}\n${String.fromCharCode(7)}`;
    expect(cleanText(sneaky)).toBe("Aave V3");
    expect(cleanText("x".repeat(100), 10)).toBe("xxxxxxx...");
    expect(cleanText(42)).toBeNull();
  });
});

describe("pool math", () => {
  it("prices the pool from sqrtPriceX96 and measures impact against the mid", () => {
    // sqrt(0.025e-12) * 2^96: a 0.025 USDC per MON pool.
    const sqrt = BigInt(Math.round(Math.sqrt(0.025e-12) * 2 ** 96));
    expect(midPriceFromSqrt(sqrt)).toBeCloseTo(0.025, 9);
    expect(impactBps(100, 99.5)).toBeCloseTo(50, 9);
    expect(impactBps(100, 101)).toBe(0);
  });
});

/** A market whose upstreams answer from the recorded fixtures. */
function market(
  o: { fetch?: typeof fetch; mainnet?: MainnetMarketReader | null; cmc?: string | null } = {},
) {
  const routes: Record<string, string> = {
    [CMC_QUOTES_URL]: "cmc-quotes.json",
    [LLAMA_URLS.chainTvl]: "llama-chain-tvl.json",
    [LLAMA_URLS.protocols]: "llama-protocols.json",
    [LLAMA_URLS.yields]: "llama-yields.json",
    [LLAMA_URLS.dexVolumes]: "llama-dexs.json",
    [LLAMA_URLS.chartHourly]: "llama-chart-1h.json",
    [LLAMA_URLS.chart4h]: "llama-chart-4h.json",
  };
  const calls: string[] = [];
  const f: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const name = routes[url];
    return name ? json(fixture(name)) : new Response("{}", { status: 404 });
  };
  const refusals: Refusal[] = [];
  const m = new MarketData({
    cmcApiKey: o.cmc === undefined ? "test-key-not-real" : o.cmc,
    mainnet: o.mainnet === undefined ? fakeMainnet() : o.mainnet,
    fetch: o.fetch ?? f,
    sleep: noSleep,
    now: () => NOW_MS,
    onRefuse: (r) => refusals.push(r),
  });
  return { m, calls, refusals };
}

function fakeMainnet(chainlinkPrice = 0.0242): MainnetMarketReader {
  const fig = (value: number, source: Figure["source"]): Figure => ({
    value,
    source,
    asOf: new Date(NOW_MS).toISOString(),
    warnings: [],
  });
  return {
    async oracleVsPool() {
      return {
        chainlinkMonUsd: fig(chainlinkPrice, "chainlink"),
        poolMonUsdc: fig(0.02425, "uniswap_v4"),
        deviationBps: fig(20.6, "computed"),
        block: "111700000",
      };
    },
    async poolDepth() {
      return {
        block: "111700000",
        asOf: new Date(NOW_MS).toISOString(),
        midPriceUsd: fig(0.02425, "uniswap_v4"),
        activeLiquidity: fig(1e18, "uniswap_v4"),
        feeBps: 5,
        rows: [
          {
            sizeUsd: 10,
            side: "buy_mon",
            impactBps: fig(5.1, "uniswap_v4"),
            impactExFeeBps: fig(0.1, "uniswap_v4"),
          },
        ],
      };
    },
  };
}

describe("the market snapshot", () => {
  it("names a source and a time for every figure, and fits the payload limit", async () => {
    const { m } = market();
    const { value: s } = await m.snapshot();
    for (const part of [
      s.prices,
      s.oracleVsPool,
      s.volatility,
      s.poolDepth,
      s.chainTvl,
      s.dexVolumes,
      s.topProtocols,
      s.topYields,
    ])
      expect(part.ok).toBe(true);
    const figures: Figure[] = [];
    const walk = (v: unknown) => {
      if (v && typeof v === "object") {
        if ("source" in v && "asOf" in v && "value" in v) figures.push(v as Figure);
        else for (const x of Object.values(v)) walk(x);
      }
    };
    walk(s);
    expect(figures.length).toBeGreaterThan(40);
    for (const f of figures) {
      expect(f.source).toMatch(/^(coinmarketcap|defillama|chainlink|uniswap_v4|computed)$/);
      expect(Number.isNaN(Date.parse(f.asOf))).toBe(false);
    }
    expect(JSON.stringify(s).length).toBeLessThan(30_000);
    expect(s.volatility.ok && s.volatility.data.method).toContain("log returns");
  });

  it("flags CoinMarketCap's MON price when it is far from Chainlink's, keeping both", async () => {
    const { m } = market({ mainnet: fakeMainnet(0.03) });
    const { value: s } = await m.snapshot();
    const mon = s.prices.ok ? s.prices.data.find((q) => q.asset === "MON") : undefined;
    expect(mon?.priceUsd.value).toBeCloseTo(0.0241, 3);
    expect(mon?.priceUsd.warnings.map((w) => w.code)).toContain("SOURCES_DISAGREE");
    expect(s.oracleVsPool.ok && s.oracleVsPool.data.chainlinkMonUsd.value).toBe(0.03);
    expect(
      s.priceChecks.find((c) => c.pair === "coinmarketcap vs chainlink")?.warnings,
    ).toHaveLength(1);
  });

  it("a deliberately implausible price is refused and logged, not passed through", async () => {
    const bad = structuredClone(fixture("cmc-quotes.json")) as {
      data: Record<string, { quote: { USD: { price: number } } }>;
    };
    (bad.data["30495"] as { quote: { USD: { price: number } } }).quote.USD.price = 2_400;
    const { m, refusals } = market({ fetch: async () => json(bad) });
    const quotes = (await m.prices()).value;
    const mon = quotes.find((q) => q.asset === "MON");
    expect(mon?.priceUsd.value).toBeNull();
    expect(mon?.priceUsd.warnings[0]?.code).toBe("REFUSED_OUT_OF_RANGE");
    expect(refusals).toEqual([expect.objectContaining({ field: "monPriceUsd", value: 2_400 })]);
  });

  it("an outage answers the part with an error, never old data as fresh, and the rest still answer", async () => {
    const { m } = market({ cmc: null, mainnet: null });
    const { value: s } = await m.snapshot();
    expect(s.prices).toMatchObject({
      ok: false,
      error: { code: "UPSTREAM_UNAVAILABLE", retryable: false },
    });
    expect(s.poolDepth).toMatchObject({ ok: false });
    expect(s.chainTvl.ok).toBe(true);
  });

  it("a second snapshot inside the time to live is served from the cache", async () => {
    const { m, calls } = market();
    expect((await m.snapshot()).cacheHit).toBe(false);
    const before = calls.length;
    expect((await m.snapshot()).cacheHit).toBe(true);
    expect(calls.length).toBe(before);
  });
});

describe("the research connection to mainnet is read-only (P3-U9, D-289)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses every sending and signing method before any request leaves", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = createPublicClient({ transport: readOnlyTransport(["https://rpc.test/x"]) });
    for (const method of [
      "eth_sendRawTransaction",
      "eth_sendTransaction",
      "eth_sign",
      "eth_signTypedData_v4",
      "personal_sign",
      "eth_accounts",
      "wallet_sendCalls",
    ])
      await expect(client.request({ method, params: [] } as never)).rejects.toThrow(/read-only/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets reads through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 0, result: "0x8f" }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const client = createPublicClient({ transport: readOnlyTransport(["https://rpc.test/x"]) });
    expect(await client.getChainId()).toBe(143);
  });
});
