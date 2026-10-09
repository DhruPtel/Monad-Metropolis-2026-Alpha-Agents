import { readFileSync } from "node:fs";
import { CLASS_F_FEEDS } from "@alpha-agents/domain";
import type { PublicClient } from "viem";
import { CMC_QUOTES_URL } from "./coinmarketcap.ts";
import { LLAMA_URLS } from "./defillama.ts";
import { DUNE_QUERY_NAMES, type DuneQueryName } from "./dune.ts";
import type { Figure } from "./figures.ts";
import type { MainnetMarketReader } from "./mainnet.ts";

/**
 * Recorded upstream answers for tests (captured 2026-10-08 22:45 UTC from
 * CoinMarketCap and DefiLlama, trimmed to the rows the readers use), and a
 * fake mainnet. Tests set their clock to FIXTURE_NOW_MS so ages are fixed.
 */
export const FIXTURE_NOW_MS = Date.parse("2026-10-08T22:50:00Z");

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

const ROUTES: Readonly<Record<string, string>> = {
  [CMC_QUOTES_URL]: "cmc-quotes.json",
  [LLAMA_URLS.chainTvl]: "llama-chain-tvl.json",
  [LLAMA_URLS.protocols]: "llama-protocols.json",
  [LLAMA_URLS.yields]: "llama-yields.json",
  [LLAMA_URLS.dexVolumes]: "llama-dexs.json",
  [LLAMA_URLS.chartHourly]: "llama-chart-1h.json",
  [LLAMA_URLS.chart4h]: "llama-chart-4h.json",
};

/** A fetch that answers every market URL from its fixture, and records each URL asked for. */
export function fixtureFetch(o: { down?: readonly string[] } = {}) {
  const calls: string[] = [];
  const f: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const name = ROUTES[url];
    if (!name || o.down?.some((d) => url.includes(d))) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify(fixture(name)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: f, calls };
}

export function fakeMainnet(chainlinkPrice = 0.0242): MainnetMarketReader {
  const fig = (value: number, source: Figure["source"]): Figure => ({
    value,
    source,
    asOf: new Date(FIXTURE_NOW_MS).toISOString(),
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
        asOf: new Date(FIXTURE_NOW_MS).toISOString(),
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

/**
 * A fetch for the research sources (P3-U9): X's recent search and Dune's
 * latest result answer from their recorded fixtures; `down` names URL parts
 * that answer 503. Records every URL asked for.
 */
export function researchFetch(o: { down?: readonly string[] } = {}) {
  const calls: string[] = [];
  const f: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const json = (name: string) =>
      new Response(JSON.stringify(fixture(name)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (o.down?.some((d) => url.includes(d))) return new Response("{}", { status: 503 });
    if (url.startsWith("https://api.x.com/2/tweets/search/recent")) return json("x-recent.json");
    if (/^https:\/\/api\.dune\.com\/api\/v1\/query\/\d+\/results/.test(url))
      return json("dune-results.json");
    return new Response("{}", { status: 404 });
  };
  return { fetch: f, calls };
}

/** Dune IDs for every saved query, for tests. */
export function testDuneIds(): Record<DuneQueryName, number> {
  return Object.fromEntries(DUNE_QUERY_NAMES.map((n, i) => [n, 6_000_001 + i])) as Record<
    DuneQueryName,
    number
  >;
}

/**
 * F-U1: recorded token discovery answers (captured 2026-10-09 20:20 to 20:40
 * UTC from GeckoTerminal, CoinGecko and CoinMarketCap, trimmed to the fields
 * the readers use), served by URL, and a fake Monad chain built from them.
 */
export const TOKENS_FIXTURE_NOW_MS = Date.parse("2026-10-09T20:40:00Z");

const TOKEN_ROUTES: readonly [RegExp, string][] = [
  [/dexes\/uniswap-v3-monad\/pools\?page=1&sort=h24_volume/, "gt-uniswap-v3-monad-volume-1.json"],
  [/dexes\/uniswap-v3-monad\/pools\?page=2&sort=h24_volume/, "gt-uniswap-v3-monad-volume-2.json"],
  [/dexes\/uniswap-v4-monad\/pools\?page=1&sort=h24_volume/, "gt-uniswap-v4-monad-volume-1.json"],
  [/dexes\/uniswap-v4-monad\/pools\?page=2&sort=h24_volume/, "gt-uniswap-v4-monad-volume-2.json"],
  [
    /dexes\/pancakeswap-v3-monad\/pools\?page=1&sort=h24_volume/,
    "gt-pancakeswap-v3-monad-volume-1.json",
  ],
  [
    /dexes\/pancakeswap-v3-monad\/pools\?page=2&sort=h24_volume/,
    "gt-pancakeswap-v3-monad-volume-2.json",
  ],
  [/networks\/monad\/new_pools\?page=1/, "gt-new-1.json"],
  [/api\.coingecko\.com\/api\/v3\/coins\/list/, "coingecko-list.json"],
  [/cryptocurrency\/map/, "cmc-map.json"],
  [/cryptocurrency\/listings\/latest/, "cmc-top.json"],
];

export function tokenFixture(name: string): unknown {
  return fixture(`tokens/${name}`);
}

/** A fetch that answers the discovery URLs from the recorded fixtures; `down` matches URLs to fail. */
export function tokenFixtureFetch(o: { down?: readonly string[] } = {}) {
  const calls: string[] = [];
  const f: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const hit = TOKEN_ROUTES.find(([re]) => re.test(url));
    if (!hit || o.down?.some((d) => url.includes(d))) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify(tokenFixture(hit[1])), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: f, calls };
}

/**
 * A fake Monad chain that agrees with the recorded pools: each v3 pool's
 * factory confirms it, v4 IDs are initialized, tokens answer their recorded
 * symbol, name and decimals, and every reviewed feed answers fresh. `spoof`
 * lists pool addresses the factory does not confirm; `staleFeeds` lists feed
 * proxies whose last round is two days old.
 */
export function fakeTokenChain(
  o: { spoof?: readonly string[]; staleFeeds?: readonly string[]; nowMs?: number } = {},
): PublicClient & { reads: () => number } {
  const nowS = Math.floor((o.nowMs ?? TOKENS_FIXTURE_NOW_MS) / 1000);
  const pools = new Map<string, { t0: string; t1: string; fee: number }>();
  const byKey = new Map<string, string>();
  const tokens = new Map<string, { symbol: string; name: string; decimals: number }>();
  const files = TOKEN_ROUTES.map(([, f]) => f).filter((f) => f.startsWith("gt-"));
  const used = new Set<string>();
  for (const f of files) {
    const b = tokenFixture(f) as {
      data: {
        attributes: { address: string };
        relationships: Record<string, { data: { id: string } }>;
      }[];
      included?: {
        attributes: { address: string; symbol: string; name: string; decimals: number };
      }[];
    };
    for (const t of b.included ?? [])
      tokens.set(t.attributes.address.toLowerCase(), {
        symbol: t.attributes.symbol,
        name: t.attributes.name,
        decimals: t.attributes.decimals,
      });
    for (const p of b.data) {
      const id = p.attributes.address.toLowerCase();
      if (id.length !== 42 || pools.has(id)) continue;
      const a = p.relationships.base_token?.data.id.slice(6) ?? "";
      const q = p.relationships.quote_token?.data.id.slice(6) ?? "";
      const [t0, t1] = a < q ? [a, q] : [q, a];
      // The pool's fee from its name ("USDC / WMON 0.05%"), kept unique per pair.
      const pctMatch = /([\d.]+)%/.exec((p.attributes as { name?: string }).name ?? "");
      let fee = pctMatch ? Math.round(Number(pctMatch[1]) * 10_000) : 3000;
      while (used.has(`${t0}|${t1}|${fee}`)) fee += 1;
      used.add(`${t0}|${t1}|${fee}`);
      pools.set(id, { t0, t1, fee });
      byKey.set(`${t0}|${t1}|${fee}`, id);
    }
  }
  const feeds = new Map(CLASS_F_FEEDS.flatMap((f) => f.legs.map((l) => [l.proxy, l] as const)));
  let reads = 0;
  const readContract = async (args: {
    address: string;
    functionName: string;
    args?: unknown[];
  }) => {
    reads++;
    const a = args.address.toLowerCase();
    const leg = feeds.get(a as `0x${string}`);
    if (leg) {
      if (args.functionName === "description") return leg.description;
      if (args.functionName === "decimals") return leg.decimals;
      const updated = o.staleFeeds?.includes(a) ? nowS - 2 * 86_400 : nowS - 60;
      return [1n, 10n ** BigInt(leg.decimals), BigInt(updated), BigInt(updated), 1n];
    }
    switch (args.functionName) {
      case "getLiquidity":
        return 10n ** 18n;
      case "getSlot0":
        return [2n ** 96n, 0, 0, 0];
      case "getPool": {
        const [x, y, f] = args.args as [string, string, number];
        const id = byKey.get(`${x.toLowerCase()}|${y.toLowerCase()}|${f}`) ?? "";
        return o.spoof?.includes(id) || !id ? "0x0000000000000000000000000000000000000000" : id;
      }
    }
    const pool = pools.get(a);
    if (pool) {
      const v = { token0: pool.t0, token1: pool.t1, fee: pool.fee, tickSpacing: 60, liquidity: 1n };
      return v[args.functionName as keyof typeof v];
    }
    const t = tokens.get(a);
    if (t && args.functionName in t) return t[args.functionName as keyof typeof t];
    throw new Error("execution reverted");
  };
  const client = {
    readContract,
    getBlock: async () => ({ number: 111_990_000n, timestamp: BigInt(nowS) }),
    reads: () => reads,
  };
  return client as unknown as PublicClient & { reads: () => number };
}
