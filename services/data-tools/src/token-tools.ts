import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SCREEN_CHECK_CODES } from "@alpha-agents/domain";
import { type AgentIdentity, ToolError, errorFrom, okResult } from "@alpha-agents/tool-server";
import { z } from "zod";
import type { Meter } from "./server.ts";

/**
 * The token tools (F-U1): `list_tokens` and `new_pools` read the platform's
 * token registry, which the discovery loop keeps current; `screen_token`
 * returns a token's safety screen, a fresh cached one when there is one, or
 * runs the screen now on the platform's fork. The agent names only a token's
 * address and filters; its identity comes from the injected token, and the
 * screen records which agent asked. Metered before they run (D-215) at A-63's
 * prices: registry reads are free, a new screen costs a little, a cached
 * screen is free (D-322) and does not count toward the run's cap.
 */
export const TOKEN_DATA_TOOLS = [
  "list_tokens",
  "new_pools",
  "screen_token",
  "lookup_token",
  "find_pools",
] as const;
export type TokenDataTool = (typeof TOKEN_DATA_TOOLS)[number];

/** A-63, micro-USDC per call: registry reads free, a new screen 0.005 USDC; A-65: a new lookup 0.001 USDC. */
export const TOKEN_TOOL_PRICES_USDC_E6: Readonly<Record<TokenDataTool, bigint>> = {
  list_tokens: 0n,
  new_pools: 0n,
  screen_token: 5_000n,
  lookup_token: 1_000n,
  find_pools: 1_000n,
};

/** A-63: new screens per run (lease); cached screens do not count. */
export const TOKEN_TOOL_RUN_CAPS: Readonly<Partial<Record<TokenDataTool, number>>> = {
  screen_token: 3,
  lookup_token: 10,
  find_pools: 10,
};

const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "a token address: 0x followed by 40 hex characters");

export const TokenInputs = {
  list_tokens: z.strictObject({
    priceClass: z
      .enum(["F", "A"])
      .optional()
      .describe(
        "F: priced by a verified Chainlink feed; A: no feed (attested later). Omit for both",
      ),
    minLiquidityUsd: z
      .number()
      .min(0)
      .max(1_000_000_000)
      .default(50_000)
      .describe("Only tokens whose deepest routable pool holds at least this, in USD"),
    screen: z
      .enum(["passed", "refused", "unscreened", "expired", "any"])
      .default("any")
      .describe(
        "Filter by the latest screen: passed or refused (still fresh), unscreened, expired",
      ),
    limit: z.int().min(1).max(50).default(25),
  }),
  new_pools: z.strictObject({
    hours: z
      .union([z.literal(24), z.literal(72), z.literal(168)])
      .default(72)
      .describe("Pools created in the last 24, 72 or 168 hours"),
    limit: z.int().min(1).max(50).default(20),
  }),
  lookup_token: z.strictObject({
    query: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .describe("A token's address on Monad, or its symbol or name (for example SOL or Chog)"),
  }),
  find_pools: z.strictObject({
    token: Address.describe("Any token's address on Monad, including one you found yourself"),
  }),
  screen_token: z.strictObject({
    token: Address.describe(
      "Any token's address on Monad: from list_tokens, new_pools, lookup_token or your own research",
    ),
    fresh: z
      .boolean()
      .default(false)
      .describe("Run a new screen even when a fresh one (under six hours) exists; costs credits"),
  }),
} as const;

const Screen = z.strictObject({
  verdict: z.enum(["passed", "refused"]),
  screenedAt: z.string(),
  expiresAt: z.string(),
  fresh: z.boolean(),
});
const Token = z.strictObject({
  address: z.string(),
  symbol: z.string().max(32),
  name: z.string().max(80),
  decimals: z.int(),
  priceClass: z.enum(["F", "A"]),
  feed: z
    .strictObject({
      kind: z.string(),
      legs: z.array(z.string().max(60)).max(2),
      fresh: z.boolean(),
    })
    .nullable(),
  liquidityUsd: z.number(),
  volume24hUsd: z.number(),
  oldestPoolAt: z.string().nullable(),
  listedOnCoinGecko: z.boolean(),
  coinMarketCapRank: z.int().nullable(),
  screen: Screen.nullable(),
});
const Pool = z.strictObject({
  pool: z.string(),
  dex: z.enum(["uniswap_v3", "uniswap_v4", "pancakeswap_v3"]),
  pair: z.string().max(80),
  token0: z.string(),
  token1: z.string(),
  fee: z.int().nullable(),
  routable: z.boolean(),
  routeNote: z.string().max(200),
  liquidityUsd: z.number(),
  volume24hUsd: z.number(),
  createdAt: z.string().nullable(),
  ageHours: z.number().nullable(),
});
const Check = z.strictObject({
  code: z.enum(SCREEN_CHECK_CODES),
  status: z.enum(["pass", "fail", "skipped"]),
  reason: z.string().max(300),
  evidence: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])),
});

const Match = z.strictObject({
  address: z.string(),
  symbol: z.string().max(32),
  name: z.string().max(80),
  inRegistry: z.boolean(),
  priceClass: z.enum(["F", "A"]).nullable(),
  liquidityUsd: z.number().nullable(),
  screen: Screen.nullable(),
  foundBy: z.string().max(40).nullable(),
  sources: z.array(z.string().max(20)).max(4),
});

export const TokenOutputs = {
  lookup_token: z.strictObject({
    source: z.enum(["registry", "lookup", "search"]),
    cacheHit: z.boolean(),
    query: z.string(),
    note: z.string(),
    count: z.int(),
    matches: z.array(Match).max(20),
    pools: z.array(Pool).max(30),
  }),
  find_pools: z.strictObject({
    source: z.enum(["registry", "lookup"]),
    cacheHit: z.boolean(),
    token: Token,
    foundBy: z.string().max(40),
    count: z.int(),
    pools: z.array(Pool).max(30),
  }),
  list_tokens: z.strictObject({
    source: z.literal("registry"),
    cacheHit: z.boolean(),
    asOf: z.string(),
    rules: z.string(),
    count: z.int(),
    tokens: z.array(Token).max(50),
  }),
  new_pools: z.strictObject({
    source: z.literal("registry"),
    cacheHit: z.boolean(),
    asOf: z.string(),
    hours: z.int(),
    count: z.int(),
    pools: z.array(Pool).max(50),
  }),
  screen_token: z.strictObject({
    source: z.literal("screen"),
    cacheHit: z.boolean(),
    address: z.string(),
    symbol: z.string().max(32),
    verdict: z.enum(["passed", "refused"]),
    buyable: z.boolean(),
    summary: z.string().max(400),
    screenedAt: z.string(),
    expiresAt: z.string(),
    forkBlock: z.int().nullable(),
    route: z
      .strictObject({
        pool: z.string(),
        dex: z.string(),
        base: z.string(),
        fee: z.int().nullable(),
      })
      .nullable(),
    checks: z.array(Check).max(SCREEN_CHECK_CODES.length),
  }),
} as const;

export type TokenListOutput = z.infer<typeof TokenOutputs.list_tokens>;
export type NewPoolsOutput = z.infer<typeof TokenOutputs.new_pools>;
export type ScreenOutput = z.infer<typeof TokenOutputs.screen_token>;
export type TokenItem = z.infer<typeof Token>;
export type PoolItem = z.infer<typeof Pool>;

/** What the platform gives the token tools; the orchestrator implements it over the registry. */
export interface TokenSource {
  readonly configured: { readonly discovery: boolean; readonly screen: boolean };
  list(f: {
    priceClass?: "F" | "A";
    minLiquidityUsd: number;
    screen: "passed" | "refused" | "unscreened" | "expired" | "any";
    limit: number;
  }): Promise<TokenItem[]>;
  newPools(hours: number, limit: number): Promise<PoolItem[]>;
  /** Whether the registry holds the token, seen recently enough that a lookup reads nothing upstream. */
  isFresh(address: string): Promise<boolean>;
  /** A token by address: found and saved for every agent if the registry never saw it (D-360). */
  findPools(
    address: string,
    requestedBy: string,
  ): Promise<{ token: TokenItem; pools: PoolItem[]; foundBy: string; cacheHit: boolean }>;
  /** Tokens by symbol or name: the registry's, then CoinGecko's and GeckoTerminal's. */
  search(query: string): Promise<z.infer<typeof Match>[]>;
  /** The latest screen while it is fresh, else null. */
  freshScreen(address: string): Promise<Omit<ScreenOutput, "source" | "cacheHit"> | null>;
  /** Runs a new screen now; throws a ToolError or RegistryError-like error with a code. */
  screen(address: string, requestedBy: string): Promise<Omit<ScreenOutput, "source" | "cacheHit">>;
  asOf(): string;
}

const DESCRIPTIONS: Readonly<Record<TokenDataTool, string>> = {
  list_tokens:
    "Tokens already in the platform's shared registry: those background discovery and other agents have found in pools of real liquidity on Uniswap v3, Uniswap v4 or PancakeSwap v3, each with its price class (F: a verified Chainlink feed; A: none), its deepest routable pool's liquidity, 24-hour volume, oldest pool's age, listings, and latest safety screen. The registry is a cache that saves requests, never a limit: research any token you like and use lookup_token, find_pools and screen_token for tokens it does not hold. A token can be bought only with a passing screen under six hours old. Free.",
  new_pools:
    "Pools created recently on Monad's Uniswap v3, Uniswap v4 and PancakeSwap v3, newest first, with each pool's pair, liquidity, volume and age. A pool younger than 72 hours always fails the safety screen. Free.",
  lookup_token:
    "Look up any token on Monad by address, or by symbol or name. By address: the token's own symbol, name and decimals, its price class, its pools and liquidity on the supported venues and its latest screen, found from the token itself even if no list has it; the result joins the shared registry for every agent. By symbol or name: the matching tokens in the registry, then on CoinGecko and GeckoTerminal, with their addresses (beware look-alikes: several tokens can share a symbol). A lookup that reads upstream costs a little; one the registry answers is free.",
  find_pools:
    "The pools and liquidity of any token address on Monad's Uniswap v3, Uniswap v4 and PancakeSwap v3, found from the token itself (GeckoTerminal's pools for it, each confirmed onchain, plus the token's pools against USDC, WMON and MON read straight from the venues), even for a token you found through your own research. The token and its pools join the shared registry for every agent. Costs a little unless the registry saw the token in the last half hour.",
  screen_token:
    "The safety screen of any token you found, through your own research or the registry: a simulated buy, transfer and sell through its real route on a fork of the latest block, the owner's powers, upgradeability, pool liquidity and age, look-alike names, and GoPlus as a second opinion. Each check says pass, fail or skipped, with its reason and evidence. The screen is a guardrail, not a whitelist: any token that passes may be bought. Returns a fresh screen (under six hours) for free when one exists; a new screen costs credits and is limited per run. A token the registry never saw is looked up first and joins it.",
};

function tokenError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message.slice(0, 300) : "the token registry failed";
  if (code === "NOT_FOUND") return new ToolError("ASSET_NOT_ALLOWED", message, false);
  if (code === "NOT_CONFIGURED") return new ToolError("UPSTREAM_UNAVAILABLE", message, false);
  if (err instanceof z.ZodError)
    return new ToolError("INTERNAL", "the token registry built an invalid answer", false);
  return new ToolError(
    "UPSTREAM_UNAVAILABLE",
    "the token screen could not run; try again later",
    true,
  );
}

export interface TokenToolsDeps {
  readonly meter: Meter;
  readonly tokens: TokenSource | null;
}

const RULES =
  "Buy only with a passing screen under six hours old. The screen refuses: an unsellable token, any tax above 1%, an owner able to blacklist, pause, or change balances or taxes (unless reviewed), an upgradeable proxy without a timelock (unless reviewed), a route pool under $50,000 or a round trip over 3%, a pool younger than 72 hours, and a look-alike name.";

export function registerTokenTools(
  mcp: McpServer,
  identity: AgentIdentity,
  deps: TokenToolsDeps,
): void {
  const run = async (
    tool: TokenDataTool,
    input: Record<string, unknown>,
    cacheHit: boolean,
    read: (
      t: TokenSource,
    ) => Promise<{ output: Record<string, unknown>; summary: Record<string, unknown> }>,
  ) => {
    const t = deps.tokens;
    if (!t || (tool === "screen_token" ? !t.configured.screen : !t.configured.discovery))
      return errorFrom(
        new ToolError(
          "UPSTREAM_UNAVAILABLE",
          tool === "screen_token"
            ? "Token screens are not configured on this platform."
            : "The token registry is not configured on this platform.",
          false,
        ),
      );
    let callId: string;
    try {
      callId = await deps.meter.begin(identity, {
        tool,
        input,
        priceUsdcE6: cacheHit ? 0n : TOKEN_TOOL_PRICES_USDC_E6[tool],
        provider:
          tool === "screen_token"
            ? "screen"
            : tool === "list_tokens" || tool === "new_pools"
              ? "registry"
              : "lookup",
        cacheHit,
        ...(TOKEN_TOOL_RUN_CAPS[tool] === undefined
          ? {}
          : { maxPerLease: TOKEN_TOOL_RUN_CAPS[tool] }),
      });
    } catch (err) {
      return errorFrom(err);
    }
    try {
      const { output, summary } = await read(t);
      const out = TokenOutputs[tool].parse(output);
      await deps.meter.finish(callId, {
        status: "succeeded",
        summary: {
          ...summary,
          reason: cacheHit ? "cache" : tool === "screen_token" ? "screen" : "registry",
        },
        result: out as Record<string, unknown>,
      });
      return okResult(out as Record<string, unknown>);
    } catch (err) {
      const e = tokenError(err);
      await deps.meter.finish(callId, { status: "failed", errorCode: e.code });
      return errorFrom(e);
    }
  };

  mcp.registerTool(
    "list_tokens",
    {
      description: DESCRIPTIONS.list_tokens,
      inputSchema: TokenInputs.list_tokens,
      outputSchema: TokenOutputs.list_tokens,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      run("list_tokens", input, true, async (t) => {
        const tokens = await t.list({
          ...(input.priceClass ? { priceClass: input.priceClass } : {}),
          minLiquidityUsd: input.minLiquidityUsd,
          screen: input.screen,
          limit: input.limit,
        });
        return {
          output: {
            source: "registry",
            cacheHit: true,
            asOf: t.asOf(),
            rules: RULES,
            count: tokens.length,
            tokens,
          },
          summary: {
            results: tokens.length,
            priceClass: input.priceClass ?? "any",
            screen: input.screen,
          },
        };
      }),
  );

  mcp.registerTool(
    "new_pools",
    {
      description: DESCRIPTIONS.new_pools,
      inputSchema: TokenInputs.new_pools,
      outputSchema: TokenOutputs.new_pools,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      run("new_pools", input, true, async (t) => {
        const pools = await t.newPools(input.hours, input.limit);
        return {
          output: {
            source: "registry",
            cacheHit: true,
            asOf: t.asOf(),
            hours: input.hours,
            count: pools.length,
            pools,
          },
          summary: { results: pools.length, hours: input.hours },
        };
      }),
  );

  mcp.registerTool(
    "lookup_token",
    {
      description: DESCRIPTIONS.lookup_token,
      inputSchema: TokenInputs.lookup_token,
      outputSchema: TokenOutputs.lookup_token,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const query = input.query.trim();
      const byAddress = /^0x[0-9a-fA-F]{40}$/.test(query);
      if (!byAddress)
        return run("lookup_token", { query }, true, async (t) => {
          const matches = (await t.search(query)).slice(0, 20);
          return {
            output: {
              source: "search",
              cacheHit: true,
              query,
              note: "Tokens can share a symbol: confirm the address (lookup_token with it) before relying on one.",
              count: matches.length,
              matches,
              pools: [],
            },
            summary: { query, results: matches.length },
          };
        });
      const address = query.toLowerCase();
      const fresh = (await deps.tokens?.isFresh(address).catch(() => false)) ?? false;
      return run("lookup_token", { query: address }, fresh, async (t) => {
        const r = await t.findPools(address, `agent:${identity.agentId}`);
        return {
          output: {
            source: r.cacheHit ? "registry" : "lookup",
            cacheHit: r.cacheHit,
            query: address,
            note: r.cacheHit
              ? "From the shared registry."
              : "Found from the token itself and added to the shared registry.",
            count: 1,
            matches: [
              {
                address: r.token.address,
                symbol: r.token.symbol,
                name: r.token.name,
                inRegistry: true,
                priceClass: r.token.priceClass,
                liquidityUsd: r.token.liquidityUsd,
                screen: r.token.screen,
                foundBy: r.foundBy,
                sources: ["registry"],
              },
            ],
            pools: r.pools.slice(0, 30),
          },
          summary: {
            query: address,
            pools: r.pools.length,
            reason: r.cacheHit ? "cache" : "lookup",
          },
        };
      });
    },
  );

  mcp.registerTool(
    "find_pools",
    {
      description: DESCRIPTIONS.find_pools,
      inputSchema: TokenInputs.find_pools,
      outputSchema: TokenOutputs.find_pools,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const address = input.token.toLowerCase();
      const fresh = (await deps.tokens?.isFresh(address).catch(() => false)) ?? false;
      return run("find_pools", { token: address }, fresh, async (t) => {
        const r = await t.findPools(address, `agent:${identity.agentId}`);
        return {
          output: {
            source: r.cacheHit ? "registry" : "lookup",
            cacheHit: r.cacheHit,
            token: r.token,
            foundBy: r.foundBy,
            count: r.pools.length,
            pools: r.pools.slice(0, 30),
          },
          summary: { token: address, pools: r.pools.length },
        };
      });
    },
  );

  mcp.registerTool(
    "screen_token",
    {
      description: DESCRIPTIONS.screen_token,
      inputSchema: TokenInputs.screen_token,
      outputSchema: TokenOutputs.screen_token,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const address = input.token.toLowerCase();
      // A fresh screen is free and found before the meter decides the price.
      let cached: Awaited<ReturnType<TokenSource["freshScreen"]>> = null;
      if (!input.fresh && deps.tokens?.configured.screen) {
        try {
          cached = await deps.tokens.freshScreen(address);
        } catch {
          cached = null;
        }
      }
      return run(
        "screen_token",
        { token: address, fresh: input.fresh },
        cached !== null,
        async (t) => {
          const s = cached ?? (await t.screen(address, `agent:${identity.agentId}`));
          return {
            output: { source: "screen", cacheHit: cached !== null, ...s },
            summary: {
              address,
              verdict: s.verdict,
              failed: s.checks.filter((c) => c.status === "fail").length,
            },
          };
        },
      );
    },
  );
}
