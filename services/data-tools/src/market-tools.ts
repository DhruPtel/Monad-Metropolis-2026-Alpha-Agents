import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Cached, type MarketData, MarketError, type MarketTool } from "@alpha-agents/market";
import { type AgentIdentity, ToolError, errorFrom, okResult } from "@alpha-agents/tool-server";
import { z } from "zod";
import type { Meter } from "./server.ts";

/**
 * The market data tools (P3-U2): CoinMarketCap prices, DefiLlama TVL and
 * yields, realized volatility, and the whole market snapshot in one call.
 * Every figure carries its source, its time and any warning; a value outside
 * its plausible range comes back as null with the reason. Each call is
 * metered before it runs (D-215) at its price (A-52), and a call the shared
 * cache can answer without an upstream request is free and recorded with
 * `cacheHit` (D-322).
 */
export const MARKET_DATA_TOOLS = [
  "coinmarketcap_prices",
  "defillama_tvl",
  "defillama_yields",
  "volatility",
  "market_snapshot",
] as const;
export type MarketDataTool = (typeof MARKET_DATA_TOOLS)[number];

/** A-52, in micro-USDC per call: 0.001 USDC, volatility free. A cached answer is free (D-322). */
export const MARKET_TOOL_PRICES_USDC_E6: Readonly<Record<MarketDataTool, bigint>> = {
  coinmarketcap_prices: 1_000n,
  defillama_tvl: 1_000n,
  defillama_yields: 1_000n,
  volatility: 0n,
  market_snapshot: 1_000n,
};

const PROVIDER: Readonly<Record<MarketDataTool, string>> = {
  coinmarketcap_prices: "coinmarketcap",
  defillama_tvl: "defillama",
  defillama_yields: "defillama",
  volatility: "defillama",
  market_snapshot: "market",
};

// ---- schemas ----

const Warning = z.strictObject({
  code: z.enum(["REFUSED_OUT_OF_RANGE", "MISSING", "STALE", "SOURCES_DISAGREE", "THIN_HISTORY"]),
  message: z.string().max(300),
});
const Figure = z.strictObject({
  value: z.number().nullable(),
  source: z.enum(["coinmarketcap", "defillama", "chainlink", "uniswap_v4", "computed"]),
  asOf: z.string(),
  warnings: z.array(Warning).max(5),
});
const Name = z.string().max(48);
const meta = { cacheHit: z.boolean() };

const Quote = z.strictObject({
  asset: z.enum(["MON", "USDC"]),
  priceUsd: Figure,
  change24hPct: Figure,
  volume24hUsd: Figure,
  marketCapUsd: Figure,
});
const ChainTvl = z.strictObject({
  tvlUsd: Figure,
  change7dPct: Figure,
  history: z.array(z.strictObject({ date: z.string(), tvlUsd: z.number() })).max(30),
});
const Protocol = z.strictObject({ name: Name, category: Name.nullable(), tvlUsd: Figure });
const Yield = z.strictObject({
  pool: z.string().max(64),
  project: Name,
  symbol: Name,
  stablecoin: z.boolean(),
  tvlUsd: Figure,
  apyPct: Figure,
  apyBasePct: Figure,
  apyRewardPct: Figure,
});
const VolFigure = Figure.extend({ returns: z.int().min(0) });
const Volatility = z.strictObject({
  method: z.string().max(400),
  windows: z.strictObject({ "24h": VolFigure, "7d": VolFigure, "30d": VolFigure }),
});
const OracleVsPool = z.strictObject({
  chainlinkMonUsd: Figure,
  poolMonUsdc: Figure,
  deviationBps: Figure,
  block: z.string(),
});
export const PoolDepthSchema = z.strictObject({
  block: z.string(),
  asOf: z.string(),
  midPriceUsd: Figure,
  activeLiquidity: Figure,
  feeBps: z.number(),
  rows: z
    .array(
      z.strictObject({
        sizeUsd: z.number(),
        side: z.enum(["buy_mon", "sell_mon"]),
        impactBps: Figure,
        impactExFeeBps: Figure,
      }),
    )
    .max(10),
});
const DexVolumes = z.strictObject({
  total24hUsd: Figure,
  change1dPct: Figure,
  top: z.array(z.strictObject({ name: Name, volume24hUsd: Figure })).max(5),
});
const part = <T extends z.ZodType>(data: T) =>
  z.union([
    z.strictObject({ ok: z.literal(true), data, cacheHit: z.boolean() }),
    z.strictObject({
      ok: z.literal(false),
      error: z.strictObject({
        code: z.string(),
        message: z.string().max(300),
        retryable: z.boolean(),
      }),
    }),
  ]);

export const MarketInputs = {
  coinmarketcap_prices: z.strictObject({}),
  defillama_tvl: z.strictObject({ limit: z.int().min(1).max(10).default(8) }),
  defillama_yields: z.strictObject({
    asset: z.enum(["USDC", "MON"]).optional(),
    limit: z.int().min(1).max(15).default(8),
  }),
  volatility: z.strictObject({}),
  market_snapshot: z.strictObject({}),
} as const;

export const MarketOutputs = {
  coinmarketcap_prices: z.strictObject({ ...meta, quotes: z.array(Quote).max(2) }),
  defillama_tvl: z.strictObject({ ...meta, chain: ChainTvl, protocols: z.array(Protocol).max(10) }),
  defillama_yields: z.strictObject({ ...meta, pools: z.array(Yield).max(15) }),
  volatility: z.strictObject({ ...meta, ...Volatility.shape }),
  market_snapshot: z.strictObject({
    ...meta,
    asOf: z.string(),
    prices: part(z.array(Quote).max(2)),
    oracleVsPool: part(OracleVsPool),
    volatility: part(Volatility),
    poolDepth: part(PoolDepthSchema),
    chainTvl: part(ChainTvl),
    dexVolumes: part(DexVolumes),
    topProtocols: part(z.array(Protocol).max(10)),
    topYields: part(z.array(Yield).max(15)),
    priceChecks: z
      .array(z.strictObject({ pair: z.string(), warnings: z.array(Warning).max(5) }))
      .max(5),
    notice: z.string(),
  }),
} as const;

const DESCRIPTIONS: Readonly<Record<MarketDataTool, string>> = {
  market_snapshot:
    "Call this first. The whole market in one call: MON and USDC prices (CoinMarketCap), Chainlink's MON/USD against the Uniswap v4 pool on Monad mainnet, MON's realized volatility, the pool's price impact at reference sizes, Monad's TVL, DEX volumes, top protocols and top yields. Every figure has its source, its time and any warning; a part that could not be read says why. Research reads mainnet data; the venue's own price decides trades.",
  coinmarketcap_prices:
    "Latest MON and USDC price, 24-hour change, 24-hour volume and market cap from CoinMarketCap, each with its time and any warning.",
  defillama_tvl:
    "Monad's total value locked from DefiLlama, its 7-day change and 30 days of history, and the top protocols on Monad by TVL.",
  defillama_yields:
    "Monad's yield pools from DefiLlama by TVL, with total, base and reward APY; optionally only pools whose symbol names USDC or MON.",
  volatility:
    "MON's realized volatility over 24 hours, 7 days and 30 days, annualized, with the method named. Free.",
};

const SNAPSHOT_NOTICE =
  "Market data from CoinMarketCap, DefiLlama and Monad mainnet. Figures are checked for plausibility: null means refused or missing, and each warning says why. Two sources for one figure are both shown, never merged.";

export interface MarketToolsDeps {
  readonly meter: Meter;
  readonly market: MarketData | null;
}

function marketError(err: unknown): ToolError {
  if (err instanceof MarketError)
    return new ToolError(
      err.code,
      err.message,
      err.retryable,
      err.retryAfterSeconds === null ? undefined : { retryAfterSeconds: err.retryAfterSeconds },
    );
  if (err instanceof z.ZodError)
    return new ToolError("INTERNAL", "market data built an invalid answer", false);
  return err instanceof ToolError
    ? err
    : new ToolError("UPSTREAM_UNAVAILABLE", "market data failed", true);
}

/** The JSON a tool returns: figures as plain objects, no prototypes. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function registerMarketTools(
  mcp: McpServer,
  identity: AgentIdentity,
  deps: MarketToolsDeps,
): void {
  const run = async <T extends MarketDataTool>(
    tool: T,
    input: Record<string, unknown>,
    read: (m: MarketData) => Promise<Record<string, unknown>>,
  ) => {
    const m = deps.market;
    if (!m)
      return errorFrom(
        new ToolError(
          "UPSTREAM_UNAVAILABLE",
          "Market data is not configured on this platform.",
          false,
        ),
      );
    // The price is set before the call: an answer the shared cache already holds is free.
    const cacheHit = m.fresh(tool as MarketTool);
    let callId: string;
    try {
      callId = await deps.meter.begin(identity, {
        tool,
        input,
        priceUsdcE6: cacheHit ? 0n : MARKET_TOOL_PRICES_USDC_E6[tool],
        provider: PROVIDER[tool],
        cacheHit,
      });
    } catch (err) {
      return errorFrom(err);
    }
    try {
      const out = MarketOutputs[tool].parse(plain({ ...(await read(m)), cacheHit }));
      await deps.meter.finish(callId, {
        status: "succeeded",
        summary: { reason: cacheHit ? "cache" : "upstream" },
      });
      return okResult(out as Record<string, unknown>);
    } catch (err) {
      const e = marketError(err);
      await deps.meter.finish(callId, { status: "failed", errorCode: e.code });
      return errorFrom(e);
    }
  };

  const only = <T>(c: Cached<T>) => c.value;

  mcp.registerTool(
    "market_snapshot",
    {
      description: DESCRIPTIONS.market_snapshot,
      inputSchema: MarketInputs.market_snapshot,
      outputSchema: MarketOutputs.market_snapshot,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) =>
      run("market_snapshot", input, async (m) => ({
        ...(await m.snapshot()).value,
        notice: SNAPSHOT_NOTICE,
      })),
  );
  mcp.registerTool(
    "coinmarketcap_prices",
    {
      description: DESCRIPTIONS.coinmarketcap_prices,
      inputSchema: MarketInputs.coinmarketcap_prices,
      outputSchema: MarketOutputs.coinmarketcap_prices,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) =>
      run("coinmarketcap_prices", input, async (m) => ({ quotes: only(await m.prices()) })),
  );
  mcp.registerTool(
    "defillama_tvl",
    {
      description: DESCRIPTIONS.defillama_tvl,
      inputSchema: MarketInputs.defillama_tvl,
      outputSchema: MarketOutputs.defillama_tvl,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) =>
      run("defillama_tvl", input, async (m) => {
        const [chain, protocols] = await Promise.all([m.chainTvl(), m.protocols(input.limit)]);
        return { chain: chain.value, protocols: protocols.value };
      }),
  );
  mcp.registerTool(
    "defillama_yields",
    {
      description: DESCRIPTIONS.defillama_yields,
      inputSchema: MarketInputs.defillama_yields,
      outputSchema: MarketOutputs.defillama_yields,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) =>
      run("defillama_yields", input, async (m) => ({
        pools: only(await m.yields({ limit: input.limit, asset: input.asset ?? null })),
      })),
  );
  mcp.registerTool(
    "volatility",
    {
      description: DESCRIPTIONS.volatility,
      inputSchema: MarketInputs.volatility,
      outputSchema: MarketOutputs.volatility,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => run("volatility", input, async (m) => ({ ...only(await m.volatility()) })),
  );
}
