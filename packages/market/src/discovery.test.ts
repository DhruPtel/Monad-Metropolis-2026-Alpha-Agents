import { NATIVE_MON, lookAlike } from "@alpha-agents/domain";
import { describe, expect, it } from "vitest";
import {
  MarketData,
  TokenDiscovery,
  guardedListings,
  parseCmcCoins,
  parseCoinGeckoMonad,
  parseGoPlus,
  parseGtPools,
  recoverHooklessKey,
  v4PoolId,
} from "./index.ts";
import {
  TOKENS_FIXTURE_NOW_MS,
  fakeTokenChain,
  tokenFixture,
  tokenFixtureFetch,
} from "./testing.ts";

const NOW = TOKENS_FIXTURE_NOW_MS;
const ctx = { now: Math.floor(NOW / 1000) };
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const SOL_ON_MONAD = "0xea17e5a9efebf1477db45082d67010e2245217f1";

function discovery(
  o: {
    down?: string[];
    spoof?: string[];
    staleFeeds?: string[];
    cmc?: boolean;
    byToken?: string[];
  } = {},
) {
  const f = tokenFixtureFetch({ down: o.down ?? [] });
  // GeckoTerminal's rate bucket waits; the clock moves when the code sleeps.
  let t = NOW;
  const market = new MarketData({
    cmcApiKey: null,
    mainnet: null,
    fetch: f.fetch,
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  });
  const chain = fakeTokenChain({ spoof: o.spoof ?? [], staleFeeds: o.staleFeeds ?? [] });
  const d = new TokenDiscovery({
    market,
    cmcApiKey: o.cmc === false ? null : "test-key-not-real",
    client: chain,
    txPages: 0,
    byTokenAddresses: o.byToken ?? [],
  });
  return { d, f, chain, market };
}

describe("GeckoTerminal pools (F-U1)", () => {
  it("reads pools, venues, liquidity, age and tokens from a recorded page", () => {
    const page = parseGtPools(tokenFixture("gt-uniswap-v4-monad-volume-1.json"), ctx, "uniswap_v4");
    expect(page.pools).toHaveLength(20);
    const monUsdc = page.pools.find((p) => p.name.startsWith("MON / USDC"));
    expect(monUsdc?.base).toBe(NATIVE_MON);
    expect(monUsdc?.quote).toBe(USDC);
    expect(monUsdc?.liquidityUsd).toBeGreaterThan(50_000);
    expect(monUsdc?.createdAt).toMatch(/^2025-11-24T/);
    expect(page.tokens.find((t) => t.address === USDC)?.decimals).toBe(6);
  });

  it("refuses an implausible reserve instead of serving it", () => {
    const body = tokenFixture("gt-uniswap-v3-monad-volume-1.json") as {
      data: { attributes: Record<string, unknown> }[];
    };
    const broken = structuredClone(body);
    const first = broken.data[0];
    if (first) first.attributes.reserve_in_usd = "9e99";
    const refused: unknown[] = [];
    const page = parseGtPools(broken, { ...ctx, onRefuse: (r) => refused.push(r) }, "uniswap_v3");
    expect(page.pools[0]?.liquidityUsd).toBeNull();
    expect(refused).toHaveLength(1);
  });
});

describe("Uniswap v4 pool keys (F-U1)", () => {
  it("recovers the hookless key of every liquid recorded v4 pool but the hooked one", () => {
    const pools = [1, 2].flatMap(
      (n) => parseGtPools(tokenFixture(`gt-uniswap-v4-monad-volume-${n}.json`), ctx).pools,
    );
    const liquid = pools.filter((p) => (p.liquidityUsd ?? 0) >= 50_000);
    const found = liquid.map((p) => ({
      name: p.name,
      key: recoverHooklessKey(p.poolId, p.base, p.quote),
    }));
    const missing = found.filter((f) => !f.key).map((f) => f.name.split(" ")[0]);
    expect(found.length).toBeGreaterThanOrEqual(12);
    // mUSD/USDC has a hook: it is recorded, never routed.
    expect(missing).toEqual(["musd"]);
    const monUsdc = found.find((f) => f.name.startsWith("MON / USDC"));
    expect(monUsdc?.key).toMatchObject({ fee: 500, tickSpacing: 10, currency0: NATIVE_MON });
    if (!monUsdc?.key) throw new Error("no key");
    expect(v4PoolId(monUsdc.key)).toBe(liquid.find((p) => p.name.startsWith("MON / USDC"))?.poolId);
  });
});

describe("listings (F-U1)", () => {
  it("finds Monad addresses on CoinGecko and Monad-native coins on CoinMarketCap's map", () => {
    const cg = parseCoinGeckoMonad(tokenFixture("coingecko-list.json"));
    expect(cg.find((c) => c.address === USDC)?.id).toBe("usd-coin");
    expect(cg.every((c) => /^0x[0-9a-f]{40}$/.test(c.address))).toBe(true);
    const map = parseCmcCoins(tokenFixture("cmc-map.json"));
    expect(map.map((c) => c.symbol).sort()).toEqual(["GMON", "LV"]);
    expect(map.every((c) => c.monadAddress !== null)).toBe(true);
    const top = parseCmcCoins(tokenFixture("cmc-top.json"));
    expect(top).toHaveLength(200);
    expect(top[0]?.rank).toBe(1);
  });

  it("flags a Monad token named after a top asset that has no Monad listing", () => {
    const listings = guardedListings(
      parseCoinGeckoMonad(tokenFixture("coingecko-list.json")),
      parseCmcCoins(tokenFixture("cmc-top.json")),
      parseCmcCoins(tokenFixture("cmc-map.json")),
    );
    expect(
      lookAlike({ address: SOL_ON_MONAD, symbol: "SOL", name: "SOL" }, listings)?.listed.source,
    ).toBe("coinmarketcap");
    expect(lookAlike({ address: USDC, symbol: "USDC", name: "USDC" }, listings)).toBeNull();
    expect(
      lookAlike(
        { address: "0x00000000000000000000000000000000000000aa", symbol: "WMON", name: "x" },
        listings,
      )?.listed.monadAddress,
    ).toBe(WMON);
  });
});

describe("GoPlus (F-U1)", () => {
  it("reads flags and taxes, and reports a token it does not know as not found", () => {
    const body = {
      code: 1,
      result: {
        "0xab": {
          is_honeypot: "0",
          is_blacklisted: "1",
          buy_tax: "0.05",
          sell_tax: "0",
          transfer_tax: "",
          holder_count: "120",
          holders: [
            { percent: "0.4", is_locked: 0 },
            { percent: "0.9", is_locked: 1 },
          ],
          is_open_source: "1",
        },
      },
    };
    const r = parseGoPlus(body, "0xAB", 0.01);
    expect(r.flags).toEqual(["is_blacklisted", "tax_over_limit"]);
    expect(r.buyTax).toBe(0.05);
    expect(r.transferTax).toBeNull();
    expect(r.topHolderShare).toBe(0.4);
    expect(parseGoPlus(body, "0xcd", 0.01).found).toBe(false);
  });
});

describe("token discovery (F-U1)", () => {
  it("lists the liquid tokens and confirmed pools, classed by verified feeds", async () => {
    const { d } = discovery();
    const r = await d.discover();
    expect(r.sources.geckoterminal?.ok).toBe(true);
    const sym = (a: string) => r.tokens.find((t) => t.address === a);
    expect(sym(USDC)).toMatchObject({ symbol: "USDC", decimals: 6, priceClass: "F" });
    expect(sym(USDC)?.listings.coingecko?.id).toBe("usd-coin");
    expect(sym(USDC)?.liquidityUsd).toBeGreaterThan(1_000_000);
    // Native MON pools count toward WMON, and WMON has MON/USD.
    expect(sym(WMON)?.priceClass).toBe("F");
    expect(sym(WMON)?.pools.length).toBeGreaterThan(3);
    // A composite feed: gMON's exchange rate times MON/USD.
    const gmon = sym("0x8498312a6b3cbd158bf0c93abdcf29e6e4f55081");
    expect(gmon?.priceClass).toBe("F");
    expect(gmon?.feed?.legs).toHaveLength(2);
    expect(gmon?.listings.coinmarketcap?.match).toBe("address");
    // No feed: class A.
    const chog = r.tokens.find((t) => t.symbol === "CHOG");
    if (chog) expect(chog.priceClass).toBe("A");
    expect(r.tokens.filter((t) => t.priceClass === "F").length).toBeGreaterThanOrEqual(8);
    // Sorted deepest first; native MON is never a token row.
    const depths = r.tokens.map((t) => t.liquidityUsd);
    expect(depths).toEqual([...depths].sort((x, y) => y - x));
    expect(sym(NATIVE_MON)).toBeUndefined();
    // New pools are kept however small, and marked.
    expect(r.pools.some((p) => p.listedAsNew)).toBe(true);
    // The hooked v4 pool is recorded but not routable.
    const musd = r.pools.find((p) => p.name.startsWith("musd / USDC"));
    expect(musd?.routable).toBe(false);
  });

  it("drops a pool its factory does not confirm, and classes a token A when its feed is stale", async () => {
    const pool = "0x659bd0bc4167ba25c62e05656f78043e7ed4a9da";
    const { d } = discovery({
      spoof: [pool],
      staleFeeds: ["0xe20751c7b5867bcbef815ffc1b284c3f412a9e13"],
    });
    const r = await d.discover();
    expect(r.pools.find((p) => p.poolId === pool)).toBeUndefined();
    expect(r.rejectedPools.map((p) => p.poolId)).toContain(pool);
    const ausd = r.tokens.find((t) => t.symbol === "AUSD");
    expect(ausd?.priceClass).toBe("A");
    expect(ausd?.feed?.ok).toBe(false);
    expect(ausd?.feed?.legs[0]?.reason).toMatch(/past its 3600-second heartbeat/);
  });

  it("shares one set of upstream requests through the cache and skips reads for known state", async () => {
    const { d, f, chain } = discovery();
    const first = await d.discover();
    const readsFirst = chain.reads();
    const calls = f.calls.length;
    const known = {
      pools: new Map(first.pools.map((p) => [p.poolId, p])),
      tokens: new Map(first.tokens.map((t) => [t.address, t])),
    };
    const second = await d.discover(known);
    expect(f.calls.length).toBe(calls);
    expect(second.tokens.length).toBe(first.tokens.length);
    // Only the feeds are read again: pools and tokens were known.
    expect(chain.reads() - readsFirst).toBeLessThan(readsFirst / 3);
  });

  it("runs without CoinMarketCap and says so, and stops when GeckoTerminal is down", async () => {
    const r = await discovery({ cmc: false }).d.discover();
    expect(r.sources["coinmarketcap:top"]).toEqual({
      ok: false,
      detail: "CoinMarketCap is not configured",
    });
    expect(r.tokens.length).toBeGreaterThan(10);
    await expect(discovery({ down: ["geckoterminal"] }).d.discover()).rejects.toThrow(
      /GeckoTerminal/,
    );
  });
});

describe("pools by token and agent lookups (F-U2 Step 0, D-360)", () => {
  const USDT0 = "0xe7cd86e13ac4309349f30b3435a9d337750fc82d";
  const LV = "0x1001ff13bf368aa4fa85f21043648079f00e1001";

  it("reads every reviewed and class F token's own pools, so a quiet token's pools are found", async () => {
    const without = await discovery().d.discover();
    const withByToken = await discovery({ byToken: [USDT0] }).d.discover();
    const count = (r: typeof without) =>
      r.pools.filter((p) => p.token0 === USDT0 || p.token1 === USDT0).length;
    expect(count(withByToken)).toBeGreaterThan(count(without));
    expect(withByToken.sources["geckoterminal:byToken"]).toEqual({
      ok: true,
      detail: "1 tokens' own pools read",
    });
    // Curve, Trader Joe and Uniswap v2 pools are not supported venues and are dropped.
    expect(
      withByToken.pools.every((p) =>
        ["uniswap_v3", "uniswap_v4", "pancakeswap_v3"].includes(p.dex),
      ),
    ).toBe(true);
  });

  it("looks up a token's pools from the token itself, with GeckoTerminal's figures where it has them", async () => {
    const r = await discovery().d.poolsForToken(USDT0);
    expect(r.token).toMatchObject({ symbol: "USDT0", priceClass: "F" });
    expect(r.pools.length).toBeGreaterThan(3);
    expect(r.sources.geckoterminal?.ok).toBe(true);
    expect(r.pools.every((p) => p.token0 === USDT0 || p.token1 === USDT0)).toBe(true);
  });

  it("finds a token's pools onchain when no list has them, with unknown age", async () => {
    // GeckoTerminal has no pools-by-token answer for LV here: the onchain probes alone find its WMON pool.
    const r = await discovery({ down: ["/tokens/"] }).d.poolsForToken(LV);
    expect(r.sources.geckoterminal?.ok).toBe(false);
    expect(r.token?.symbol).toBe("LV");
    const lvWmon = r.pools.find(
      (p) => p.dex === "pancakeswap_v3" && [p.token0, p.token1].includes(WMON),
    );
    expect(lvWmon).toMatchObject({ createdAt: null, routable: true, fee: 2500 });
    // Twice the 25,000 WMON it holds, at the fake feed's 1.00 USD.
    expect(lvWmon?.liquidityUsd).toBeCloseTo(50_000, 6);
    expect(r.token?.liquidityUsd).toBeCloseTo(50_000, 6);
  });

  it("finds tokens by symbol from CoinGecko and GeckoTerminal's search", async () => {
    const found = await discovery().d.search("usdt0");
    expect(found[0]).toMatchObject({ address: USDT0, symbol: "USDT0" });
    expect([...(found[0]?.sources ?? [])].sort()).toEqual(["coingecko", "geckoterminal"]);
    expect(await discovery().d.search("x")).toEqual([]);
  });
});
