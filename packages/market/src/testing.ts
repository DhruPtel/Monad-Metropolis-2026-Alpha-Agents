import { readFileSync } from "node:fs";
import { CMC_QUOTES_URL } from "./coinmarketcap.ts";
import { LLAMA_URLS } from "./defillama.ts";
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
