import { afterEach, describe, expect, it } from "vitest";
import { type CustodyPath, REJECTION_CODES } from "@alpha-agents/domain";
import { executorV3 } from "@alpha-agents/policy";
import { type AgentIdentity, type ToolServer, identityFields } from "@alpha-agents/tool-server";
import { connectClient, staticResolver, structured } from "@alpha-agents/tool-server/testing";
import { type Hex, isAddressEqual } from "viem";
import type {
  AgentStateV3,
  ChainReaderV3,
  MarketStateV3,
  PoolInfoV3,
  RouteQuoteV3,
  TokenInfoV3,
} from "./reader-v3.ts";
import { candidateRoutes } from "./routes.ts";
import { CHAIN_TOOL_INPUTS_V3 } from "./schema-v3.ts";
import { CHAIN_TOOLS } from "./schema.ts";
import {
  type ChainToolsOptions,
  MemoryCallLog,
  MemoryIntentStore,
  startChainTools,
} from "./server.ts";

/**
 * The chain tools for many tokens (F-U5), against a fake v3 reader: every
 * tool, the route chosen by the venues' quotes, every blocker Executor v3
 * can give today, proposals with their route, identity binding, and the
 * v2 tools kept for an agent that has only a v2 account (D-367).
 */
const ALICE: AgentIdentity = { chainId: 143143, agentId: 1, tier: "base", leaseId: "lease-alice" };
const BOB: AgentIdentity = { chainId: 143143, agentId: 2, tier: "base", leaseId: "lease-bob" };
const CARL: AgentIdentity = { chainId: 143143, agentId: 3, tier: "base", leaseId: "lease-carl" };
const ALICE_TOKEN = "a".repeat(43);
const BOB_TOKEN = "b".repeat(43);
const CARL_TOKEN = "d".repeat(43);
const KEY = "0x00000000000000000000000000000000000000ee" as Hex;
const NOW = 1_790_000_000n;
const E18 = 10n ** 18n;

const USDC = "0x00000000000000000000000000000000000000c1" as Hex;
const WMON = "0x00000000000000000000000000000000000000c2" as Hex;
const WBTC = "0x00000000000000000000000000000000000000c3" as Hex;
const AUSD = "0x00000000000000000000000000000000000000c4" as Hex;
const LONELY = "0x00000000000000000000000000000000000000c5" as Hex;
const TOK_D = "0x00000000000000000000000000000000000000d1" as Hex;
const PX_WMON = 25_000_000_000_000_000n; // 0.025 USDC
const PX_WBTC = 60_000n * E18;

const usdc = (whole: bigint) => whole * 1_000_000n;
const wmonWorth = (e6: bigint) => (e6 * 10n ** 30n) / PX_WMON;

const token = (
  t: Hex,
  symbol: string,
  decimals: number,
  priceClass: "F" | "A",
  over: Partial<TokenInfoV3> = {},
): TokenInfoV3 => ({
  token: t,
  symbol,
  decimals,
  lane: "CORE",
  status: "BUYABLE",
  priceClass,
  maxPositionBps: 4_000,
  ...over,
});
const pool = (id: string, a: Hex, b: Hex, over: Partial<PoolInfoV3> = {}): PoolInfoV3 => ({
  poolId: `0x${id.padStart(64, "0")}` as Hex,
  venue: "UNISWAP_V3",
  tokenA: a,
  tokenB: b,
  currency0: a,
  currency1: b,
  fee: 3_000,
  tickSpacing: 60,
  pool: `0x${id.padStart(40, "0")}` as Hex,
  lane: "CORE",
  status: "ACTIVE",
  codeIntact: true,
  pricedToken:
    isAddressEqual(a, USDC) || isAddressEqual(a, WMON)
      ? isAddressEqual(b, USDC) || isAddressEqual(b, WMON)
        ? WMON
        : b
      : a,
  deviationBps: 0n,
  priceReason: "OK",
  ...over,
});

function marketState(): MarketStateV3 {
  return {
    chainId: 143143,
    block: 500n,
    timestamp: NOW,
    policy: { ...executorV3.LAUNCH_POLICY },
    policyHash: executorV3.LAUNCH_POLICY_HASH,
    paused: false,
    adapterAllowed: true,
    attestorSet: false,
    usdc: USDC,
    wmon: WMON,
    tokens: [
      token(USDC, "USDC", 6, "F"),
      token(WMON, "WMON", 18, "F"),
      token(WBTC, "WBTC", 8, "F"),
      token(AUSD, "AUSD", 6, "F"),
      token(LONELY, "LONELY", 18, "F"),
      token(TOK_D, "TOKD", 18, "A", { lane: "SCREENED", maxPositionBps: 1_500 }),
    ],
    prices: {
      [USDC]: { priceE18: E18, updatedAt: NOW, reason: "OK" },
      [WMON]: { priceE18: PX_WMON, updatedAt: NOW - 20n, reason: "OK" },
      [WBTC]: { priceE18: PX_WBTC, updatedAt: NOW - 100n, reason: "OK" },
      [AUSD]: { priceE18: E18, updatedAt: NOW - 1_000n, reason: "OK" },
      [LONELY]: { priceE18: E18, updatedAt: NOW - 10n, reason: "OK" },
      [TOK_D]: { priceE18: 0n, updatedAt: 0n, reason: "ATTESTATION_REQUIRED" },
    },
    pools: [
      pool("1", USDC, WMON),
      pool("2", WMON, WBTC, { venue: "PANCAKESWAP_V3", fee: 500 }),
      pool("3", USDC, AUSD, { venue: "UNISWAP_V4", fee: 100, tickSpacing: 1 }),
      pool("4", WMON, TOK_D, { lane: "SCREENED" }),
      pool("5", USDC, WBTC, { venue: "PANCAKESWAP_V3", fee: 500, status: "EXIT_ONLY" }),
      pool("6", WMON, USDC, {
        venue: "UNISWAP_V4",
        fee: 500,
        tickSpacing: 10,
        currency0: "0x0000000000000000000000000000000000000000",
        currency1: USDC,
      }),
    ],
  };
}

function agentState(over: Partial<AgentStateV3> = {}): AgentStateV3 {
  return {
    block: 500n,
    timestamp: NOW,
    owner: "0x00000000000000000000000000000000000a11ce",
    ownerEpoch: 0n,
    configEpoch: 0n,
    account: "0x00000000000000000000000000000000000ac003",
    v2Account: null,
    mode: "NORMAL",
    screenedOptIn: false,
    holdings: [
      {
        token: USDC,
        decimals: 6,
        balance: usdc(70n),
        free: usdc(70n),
        costBasis: usdc(70n),
        lastPriceE18: E18,
        lastPricedAt: NOW,
      },
      {
        token: WMON,
        decimals: 18,
        balance: wmonWorth(usdc(30n)),
        free: wmonWorth(usdc(30n)),
        costBasis: usdc(30n),
        lastPriceE18: PX_WMON,
        lastPricedAt: NOW - 20n,
      },
    ],
    values: { nav: usdc(100n), capped: usdc(100n), totalBasis: usdc(100n), classABasis: 0n },
    breaker: { nav: usdc(100n), perUnit: E18, peak: E18, drawdownBps: 0n },
    grant: { key: KEY, ownerEpoch: 0n, configEpoch: 0n, validUntil: NOW + 86_400n },
    trades: [],
    tradesLeft: 20,
    nextSlotFreesAt: 0n,
    turnoverUsed: 0n,
    ...over,
  };
}

const px = (m: MarketStateV3, t: Hex) =>
  isAddressEqual(t, USDC) ? E18 : (m.prices[t]?.priceE18 ?? 0n);
const dec = (m: MarketStateV3, t: Hex) =>
  m.tokens.find((x) => isAddressEqual(x.token, t))?.decimals ?? 18;

/** A reader over fixed state that tests change field by field; quotes follow the oracle, filled `fillBps` per hop. */
class FakeReaderV3 implements ChainReaderV3 {
  readonly chainId = 143143;
  readonly executorAddress = "0x3443dbBd29E19CF17853732C260C6abDb6dC0658" as Hex;
  market_ = marketState();
  agents = new Map<number, AgentStateV3>();
  paths = new Map<number, CustodyPath | null>();
  fillBps = 9_990n;
  /** Per pool, a fill override (basis points of the oracle's implied output). */
  poolFill = new Map<string, bigint>();
  quoteFails = false;
  agentReads: number[] = [];

  constructor() {
    for (const id of [1, 2, 3]) this.agents.set(id, agentState());
    this.paths.set(1, "v3");
    this.paths.set(2, "v2");
    this.paths.set(3, "v3");
  }
  async market() {
    return this.market_;
  }
  async agent(id: number) {
    this.agentReads.push(id);
    return this.agents.get(id) ?? null;
  }
  async custodyPath(id: number) {
    return this.paths.get(id) ?? null;
  }
  private hop(p: PoolInfoV3, tokenIn: Hex, amountIn: bigint): { out: Hex; amountOut: bigint } {
    const m = this.market_;
    const out = isAddressEqual(tokenIn, p.tokenA) ? p.tokenB : p.tokenA;
    // An unpriced side (a class A token before the attestor) fills one for one, so a route exists.
    if (px(m, tokenIn) === 0n || px(m, out) === 0n) return { out, amountOut: amountIn };
    const valueE18 = (amountIn * px(m, tokenIn)) / 10n ** BigInt(dec(m, tokenIn));
    const implied = (valueE18 * 10n ** BigInt(dec(m, out))) / px(m, out);
    const fill = this.poolFill.get(p.poolId) ?? this.fillBps;
    return { out, amountOut: (implied * fill) / 10_000n };
  }
  private along(
    route: readonly PoolInfoV3[],
    tokenIn: Hex,
    amountIn: bigint,
    candidates: number,
  ): RouteQuoteV3 | null {
    if (this.quoteFails) return null;
    const hops: RouteQuoteV3["hops"][number][] = [];
    let at = tokenIn;
    let amount = amountIn;
    for (const p of route) {
      const h = this.hop(p, at, amount);
      hops.push({
        poolId: p.poolId,
        tokenIn: at,
        tokenOut: h.out,
        amountIn: amount,
        amountOut: h.amountOut,
      });
      at = h.out;
      amount = h.amountOut;
    }
    return { block: 500n, route, hops, amountOut: amount, candidates };
  }
  async bestRoute(
    tokenIn: Hex,
    tokenOut: Hex,
    amountIn: bigint,
    rules: { optedIn: boolean; intoUsdc: boolean; sellsScreened: boolean },
  ) {
    const routes = candidateRoutes(this.market_, tokenIn, tokenOut, rules);
    let best: RouteQuoteV3 | null = null;
    for (const r of routes) {
      const q = this.along(r, tokenIn, amountIn, routes.length);
      if (q && (!best || q.amountOut > best.amountOut)) best = q;
    }
    return best;
  }
  async quoteRoute(route: readonly Hex[], tokenIn: Hex, amountIn: bigint) {
    const pools = route.map((id) => this.market_.pools.find((p) => p.poolId === id) as PoolInfoV3);
    return this.along(pools, tokenIn, amountIn, 1);
  }
}

const servers: ToolServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(over: Partial<ChainToolsOptions> = {}) {
  const reader = new FakeReaderV3();
  const log = new MemoryCallLog();
  let clock = new Date(Number(NOW) * 1000);
  const intents = new MemoryIntentStore(() => clock);
  const proposed: string[] = [];
  const server = await startChainTools({
    resolve: staticResolver({ [ALICE_TOKEN]: ALICE, [BOB_TOKEN]: BOB, [CARL_TOKEN]: CARL }),
    reader: null,
    readerV3: reader,
    log,
    intents,
    sessionKeyOf: async () => KEY,
    onProposed: (_i, r) => proposed.push(r.intentId),
    now: () => clock,
    ...over,
  });
  servers.push(server);
  const alice = await connectClient(server.url, ALICE_TOKEN);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await alice.callTool({ name, arguments: args });
    return { error: r.isError === true, out: structured(r) };
  };
  const codes = async (sell: string, buy: string, amount: string) => {
    const r = await call("tradable_now", { sell, buy, amount });
    return (r.out as { blockers: { code: string }[] }).blockers.map((b) => b.code);
  };
  return {
    server,
    reader,
    log,
    intents,
    proposed,
    alice,
    call,
    codes,
    tick: (s: number) => (clock = new Date(clock.getTime() + s * 1000)),
  };
}

describe("chain tools for many tokens (F-U5)", () => {
  it("lists the same tool names with v3 schemas, no identity fields, every tool in the registry", async () => {
    const { alice } = await start();
    const { tools } = await alice.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...CHAIN_TOOLS].sort());
    for (const t of tools) {
      expect(t.outputSchema, t.name).toBeDefined();
      expect(t.description?.length, t.name).toBeGreaterThan(40);
    }
    for (const schema of Object.values(CHAIN_TOOL_INPUTS_V3))
      expect(identityFields(schema)).toEqual([]);
    const quote = tools.find((t) => t.name === "get_quote");
    // A token is named by symbol or address, not from a two-asset enum.
    expect(JSON.stringify(quote?.inputSchema)).toContain("pattern");
    expect(JSON.stringify(quote?.inputSchema)).not.toContain('"enum":["USDC","WMON"]');
    await alice.close();
  });

  it("keeps the v2 tools for an agent that has only a v2 account, and picks v3 for one with none (D-367)", async () => {
    const { server, reader } = await start();
    const bob = await connectClient(server.url, BOB_TOKEN);
    const quote = (await bob.listTools()).tools.find((t) => t.name === "get_quote");
    expect(JSON.stringify(quote?.inputSchema)).toContain('"enum":["USDC","WMON"]');
    await bob.close();
    reader.paths.set(2, null);
    const bobAgain = await connectClient(server.url, BOB_TOKEN);
    const q2 = (await bobAgain.listTools()).tools.find((t) => t.name === "get_quote");
    expect(JSON.stringify(q2?.inputSchema)).toContain("pattern");
    await bobAgain.close();
  });

  it("reads the portfolio: every token with its class, price, value, cost basis and share", async () => {
    const { call } = await start();
    const r = await call("get_portfolio");
    expect(r.error).toBe(false);
    expect(r.out).toMatchObject({
      account: "0x00000000000000000000000000000000000ac003",
      heldCount: 2,
      maxHeld: 16,
      totalValueUsdc: { amount: "100" },
      valuesUsable: true,
      mode: "NORMAL",
      screenedOptIn: false,
      holdings: [
        {
          token: "USDC",
          class: "USDC",
          amount: "70",
          valueUsdc: "70",
          shareBps: 7000,
          priceSource: "usdc",
          costBasisUsdc: null,
        },
        {
          token: "WMON",
          class: "F",
          amount: "1200",
          priceUsdc: "0.025",
          valueUsdc: "30",
          costBasisUsdc: "30",
          shareBps: 3000,
          priceSource: "chainlink",
        },
      ],
    });
  });

  it("says the values are unusable while a held feed is stale, and still lists the holdings", async () => {
    const { call, reader } = await start();
    reader.market_ = {
      ...reader.market_,
      prices: {
        ...reader.market_.prices,
        [WMON]: { priceE18: PX_WMON, updatedAt: NOW - 9_000n, reason: "STALE" },
      },
    };
    reader.agents.set(1, agentState({ values: null, breaker: null }));
    const r = await call("get_portfolio");
    expect(r.out).toMatchObject({
      valuesUsable: false,
      totalValueUsdc: null,
      breaker: { state: "UNKNOWN", drawdownBps: null },
      holdings: [{ token: "USDC" }, { token: "WMON", priceUsdc: null, valueUsdc: null }],
    });
  });

  it("reads every token's price with its source and status, and every pool", async () => {
    const { call } = await start();
    const r = await call("get_prices");
    const out = r.out as {
      tokens: {
        token: string;
        source: string;
        tradable: boolean;
        blockedBy: string | null;
        feedStatus: string;
      }[];
      pools: { pair: string; venue: string; status: string }[];
    };
    expect(out.tokens.map((t) => [t.token, t.source, t.tradable, t.blockedBy])).toEqual([
      ["USDC", "usdc", true, null],
      ["WMON", "chainlink", true, null],
      ["WBTC", "chainlink", true, null],
      ["AUSD", "chainlink", true, null],
      ["LONELY", "chainlink", true, null],
      ["TOKD", "attestation", false, "ATTESTOR_UNAVAILABLE"],
    ]);
    expect(out.pools.map((p) => `${p.venue} ${p.pair} ${p.status}`)).toEqual([
      "uniswap_v3 USDC/WMON ACTIVE",
      "pancakeswap_v3 WMON/WBTC ACTIVE",
      "uniswap_v4 USDC/AUSD ACTIVE",
      "uniswap_v3 WMON/TOKD ACTIVE",
      "pancakeswap_v3 USDC/WBTC EXIT_ONLY",
      "uniswap_v4 WMON/USDC ACTIVE",
    ]);
  });

  it("quotes along the best route of up to three hops, chosen by the venues' quotes", async () => {
    const { call, reader } = await start();
    // Buying WBTC with USDC: the direct pool is exit-only, so the route goes through WMON.
    const buy = await call("get_quote", { sell: "USDC", buy: "WBTC", amount: "5" });
    expect(buy.error).toBe(false);
    expect(buy.out).toMatchObject({
      hops: 2,
      routesConsidered: 2,
      route: [
        { venue: "uniswap_v3", sell: { token: "USDC", amount: "5" }, buy: { token: "WMON" } },
        { venue: "pancakeswap_v3", buy: { token: "WBTC" } },
      ],
      passesSlippageLimit: true,
    });
    expect((buy.out as { routeFeeBps: number }).routeFeeBps).toBe(35);
    // Selling WBTC: the direct exit-only pool fills better than the two-hop route, so it wins.
    reader.poolFill.set(`0x${"5".padStart(64, "0")}`, 9_995n);
    const sell = await call("get_quote", { sell: "wbtc", buy: USDC, amount: "0.0001" });
    expect(sell.out).toMatchObject({
      hops: 1,
      routesConsidered: 3,
      route: [{ venue: "pancakeswap_v3" }],
    });
    expect((sell.out as { expectedOut: { amount: string } }).expectedOut.amount).toBe("5.997");
    // The two USDC/WMON pools compete: a better fill on the v4 pool picks it.
    reader.poolFill.set(`0x${"6".padStart(64, "0")}`, 10_000n);
    const mon = await call("get_quote", { sell: "USDC", buy: "WMON", amount: "1" });
    expect(mon.out).toMatchObject({ hops: 1, route: [{ venue: "uniswap_v4" }], slippageBps: 0 });
  });

  it("refuses a quote for an unknown token, an ambiguous symbol, the same token twice, or a pair with no route", async () => {
    const { call, reader } = await start();
    expect(await call("get_quote", { sell: "USDC", buy: "NOPE", amount: "1" })).toMatchObject({
      error: true,
      out: { code: "INVALID_INPUT" },
    });
    expect(await call("get_quote", { sell: "USDC", buy: USDC, amount: "1" })).toMatchObject({
      error: true,
      out: { code: "INVALID_INPUT" },
    });
    expect(
      await call("get_quote", { sell: "USDC", buy: "WMON", amount: "1.1234567" }),
    ).toMatchObject({ error: true, out: { code: "INVALID_INPUT" } });
    expect(await call("get_quote", { sell: "USDC", buy: "LONELY", amount: "1" })).toMatchObject({
      error: true,
      out: { code: "UPSTREAM_UNAVAILABLE" },
    });
    reader.market_ = {
      ...reader.market_,
      tokens: [...reader.market_.tokens, token(LONELY, "WBTC", 18, "F")],
    };
    const r = await call("get_quote", { sell: "USDC", buy: "WBTC", amount: "1" });
    expect(r).toMatchObject({ error: true, out: { code: "INVALID_INPUT" } });
    expect((r.out as { message: string }).message).toContain("2 registered tokens");
  });

  it("reads the limits: the room before each token's cap, the class A caps and the grant", async () => {
    const { call } = await start();
    const r = await call("get_limits");
    expect(r.out).toMatchObject({
      maxTradeValueUsdc: { amount: "10" },
      usdcAboveFloor: { amount: "60" },
      turnoverLeftUsdc: { amount: "100" },
      tradesLeft24h: 20,
      maxSlippageBps: 50,
      maxSlippageClassABps: 100,
      classA: {
        positionCapBps: 1500,
        totalCapBps: 5000,
        costBasisUsdc: { amount: "0" },
        roomBeforeTotalCapUsdc: { amount: "50" },
        attestorAvailable: false,
      },
      sessionGrant: { registered: true, expired: false },
    });
    const per = (
      r.out as {
        perToken: {
          token: string;
          capBps: number;
          roomBeforeCapUsdc: { amount: string } | null;
          buyable: boolean;
          held: boolean;
        }[];
      }
    ).perToken;
    expect(per.find((t) => t.token === "WMON")).toMatchObject({
      capBps: 4000,
      roomBeforeCapUsdc: { amount: "10" },
      buyable: true,
      held: true,
    });
    expect(per.find((t) => t.token === "WBTC")).toMatchObject({
      capBps: 4000,
      roomBeforeCapUsdc: { amount: "40" },
      held: false,
    });
    expect(per.find((t) => t.token === "TOKD")).toMatchObject({
      capBps: 1500,
      roomBeforeCapUsdc: { amount: "15" },
      buyable: false,
    });
  });

  it("tradable_now: a trade inside every limit is tradable, with its route", async () => {
    const { call } = await start();
    const r = await call("tradable_now", { sell: "USDC", buy: "WBTC", amount: "5" });
    expect(r.out).toMatchObject({
      tradable: true,
      blockers: [],
      route: [{ venue: "uniswap_v3" }, { venue: "pancakeswap_v3" }],
      buy: { token: "WBTC" },
    });
  });

  it("tradable_now: every blocker Executor v3 gives today, each with its owner-facing reason", async () => {
    const { codes, reader } = await start();
    // A screened token: not opted in, and no attestor yet for its class A price.
    expect(await codes("WMON", "TOKD", "100")).toEqual(["NOT_OPTED_IN", "ATTESTOR_UNAVAILABLE"]);
    reader.agents.set(1, agentState({ screenedOptIn: true }));
    expect(await codes("WMON", "TOKD", "100")).toEqual(["ATTESTOR_UNAVAILABLE"]);
    reader.market_ = { ...reader.market_, attestorSet: true };
    expect(await codes("WMON", "TOKD", "100")).toEqual(["ATTESTATION_REQUIRED"]);
    reader.market_ = marketState();
    reader.agents.set(1, agentState());
    // Sell-only and frozen tokens.
    const status = (s: "SELL_ONLY" | "FROZEN") =>
      (reader.market_ = {
        ...reader.market_,
        tokens: reader.market_.tokens.map((t) => (t.symbol === "WBTC" ? { ...t, status: s } : t)),
      });
    status("SELL_ONLY");
    expect(await codes("USDC", "WBTC", "5")).toEqual(["TOKEN_SELL_ONLY"]);
    expect(await codes("WMON", "WBTC", "100")).toEqual(["TOKEN_SELL_ONLY"]);
    status("FROZEN");
    expect(await codes("USDC", "WBTC", "5")).toEqual(["TOKEN_FROZEN"]);
    reader.market_ = marketState();
    // No route connects the pair.
    const lonely = await codes("USDC", "LONELY", "5");
    expect(lonely).toEqual(["ROUTE_INVALID"]);
    // A stale feed names its token; the account's values revert then too.
    reader.market_ = {
      ...reader.market_,
      prices: {
        ...reader.market_.prices,
        [WBTC]: { priceE18: PX_WBTC, updatedAt: NOW - 9_000n, reason: "STALE" },
      },
    };
    expect(await codes("USDC", "WBTC", "5")).toEqual(["ORACLE_STALE"]);
    reader.market_ = marketState();
    // The pool sits too far from the oracle.
    reader.market_ = {
      ...reader.market_,
      pools: reader.market_.pools.map((p) =>
        p.poolId.endsWith("2") ? { ...p, priceReason: "POOL_DEVIATION", deviationBps: 300n } : p,
      ),
    };
    expect(await codes("USDC", "WBTC", "5")).toEqual(["ORACLE_POOL_DEVIATION"]);
    reader.market_ = marketState();
    // Size, the cap on the token bought, the USDC floor, and the balance.
    expect(await codes("USDC", "WBTC", "11")).toEqual(["TRADE_SIZE_EXCEEDED"]);
    expect(await codes("USDC", "WMON", "10.000001")).toContain("TRADE_SIZE_EXCEEDED");
    reader.agents.set(
      1,
      agentState({
        holdings: [
          {
            token: USDC,
            decimals: 6,
            balance: usdc(55n),
            free: usdc(55n),
            costBasis: usdc(55n),
            lastPriceE18: E18,
            lastPricedAt: NOW,
          },
          {
            token: WMON,
            decimals: 18,
            balance: wmonWorth(usdc(45n)),
            free: wmonWorth(usdc(45n)),
            costBasis: usdc(45n),
            lastPriceE18: PX_WMON,
            lastPricedAt: NOW,
          },
        ],
      }),
    );
    expect(await codes("USDC", "WMON", "5")).toEqual(["CONCENTRATION_CAP"]);
    reader.agents.set(
      1,
      agentState({
        holdings: [
          {
            token: USDC,
            decimals: 6,
            balance: usdc(12n),
            free: usdc(12n),
            costBasis: usdc(12n),
            lastPriceE18: E18,
            lastPricedAt: NOW,
          },
          {
            token: WBTC,
            decimals: 8,
            balance: 146_666n,
            free: 146_666n,
            costBasis: usdc(88n),
            lastPriceE18: PX_WBTC,
            lastPricedAt: NOW,
          },
        ],
      }),
    );
    expect(await codes("USDC", "WMON", "5")).toContain("USDC_FLOOR");
    reader.agents.set(
      1,
      agentState({
        holdings: [
          {
            token: USDC,
            decimals: 6,
            balance: usdc(70n),
            free: usdc(70n),
            costBasis: usdc(70n),
            lastPriceE18: E18,
            lastPricedAt: NOW,
          },
          {
            token: WMON,
            decimals: 18,
            balance: 100n * E18,
            free: 100n * E18,
            costBasis: usdc(2n),
            lastPriceE18: PX_WMON,
            lastPricedAt: NOW,
          },
        ],
        values: {
          nav: usdc(72n) + 500_000n,
          capped: usdc(72n) + 500_000n,
          totalBasis: usdc(72n),
          classABasis: 0n,
        },
      }),
    );
    expect(await codes("WMON", "USDC", "200")).toEqual(["INSUFFICIENT_BALANCE"]);
    reader.agents.set(1, agentState());
    // Modes, the pause, the grant, the window.
    reader.agents.set(1, agentState({ mode: "REDUCE_ONLY" }));
    expect(await codes("USDC", "WMON", "1")).toEqual(["REDUCE_ONLY_MODE"]);
    expect(await codes("WMON", "USDC", "40")).toEqual([]);
    reader.agents.set(1, agentState({ mode: "PAUSED" }));
    expect(await codes("WMON", "USDC", "40")).toEqual(["PAUSED"]);
    reader.agents.set(1, agentState({ grant: null }));
    expect(await codes("USDC", "WMON", "1")).toEqual(["SESSION_UNKNOWN"]);
    reader.agents.set(
      1,
      agentState({ grant: { key: KEY, ownerEpoch: 0n, configEpoch: 0n, validUntil: NOW - 1n } }),
    );
    expect(await codes("USDC", "WMON", "1")).toEqual(["SESSION_EXPIRED"]);
    reader.agents.set(1, agentState({ configEpoch: 1n }));
    expect(await codes("USDC", "WMON", "1")).toEqual(["EPOCH_MISMATCH"]);
    reader.agents.set(
      1,
      agentState({
        trades: Array.from({ length: 20 }, (_, i) => ({
          at: NOW - BigInt(i) * 600n,
          valueUsdcE6: usdc(1n),
        })),
      }),
    );
    expect(await codes("USDC", "WMON", "1")).toEqual(["DAILY_TRADE_LIMIT"]);
    reader.agents.set(1, agentState());
    reader.market_ = { ...reader.market_, paused: true };
    expect(await codes("USDC", "WMON", "1")).toEqual(["PAUSED"]);
    reader.market_ = { ...reader.market_, paused: false, adapterAllowed: false };
    expect(await codes("USDC", "WMON", "1")).toEqual(["VENUE_NOT_ALLOWED"]);
    reader.market_ = marketState();
    // The venues' fill against the floor.
    reader.fillBps = 9_900n;
    expect(await codes("USDC", "WMON", "1")).toEqual(["SLIPPAGE_TOO_HIGH"]);
    reader.fillBps = 9_990n;
    reader.quoteFails = true;
    expect(await codes("USDC", "WMON", "1")).toEqual(["SIMULATION_FAILED"]);
  });

  it("every blocker carries its message and how it clears; the class A cap codes are wired for F-U12", async () => {
    const { call, reader } = await start();
    reader.agents.set(
      1,
      agentState({
        grant: null,
        trades: Array.from({ length: 20 }, (_, i) => ({
          at: NOW - BigInt(i) * 600n,
          valueUsdcE6: usdc(1n),
        })),
      }),
    );
    const r = await call("tradable_now", { sell: "WMON", buy: "TOKD", amount: "1" });
    const blockers = (
      r.out as {
        blockers: {
          code: string;
          message: string;
          clears: string;
          clearsAt: string | null;
          hint: string;
        }[];
      }
    ).blockers;
    expect(blockers.map((b) => b.code)).toEqual([
      "NOT_OPTED_IN",
      "SESSION_UNKNOWN",
      "ATTESTOR_UNAVAILABLE",
      "DAILY_TRADE_LIMIT",
    ]);
    for (const b of blockers) {
      expect(b.message.length).toBeGreaterThan(10);
      expect(b.hint.length).toBeGreaterThan(10);
    }
    expect(blockers.find((b) => b.code === "NOT_OPTED_IN")?.clears).toBe("by_the_owner");
    expect(blockers.find((b) => b.code === "DAILY_TRADE_LIMIT")?.clearsAt).not.toBeNull();
    const { blocker } = await import("./logic.ts");
    for (const code of [
      "CLASS_A_POSITION_CAP",
      "CLASS_A_TOTAL_CAP",
      "ATTESTATION_INVALID",
    ] as const) {
      expect(REJECTION_CODES).toContain(code);
      expect(blocker(code).hint.length).toBeGreaterThan(10);
    }
  });

  it("propose_swap: a passing swap becomes an intent awaiting approval, with its route and no calldata", async () => {
    const { call, intents, proposed } = await start();
    const r = await call("propose_swap", {
      sell: "USDC",
      buy: "WBTC",
      amount: "5",
      reason: "Add a little bitcoin.",
      clientRequestId: "req-1",
    });
    expect(r.error).toBe(false);
    expect(r.out).toMatchObject({
      status: "awaiting_approval",
      sell: { token: "USDC", amount: "5", tokenAddress: USDC },
      buy: { token: "WBTC", tokenAddress: WBTC },
      reasonCodes: [],
      duplicate: false,
    });
    expect((r.out as { route: string[] }).route).toHaveLength(2);
    expect(JSON.stringify(r.out)).not.toMatch(/calldata|"to"|selector/);
    const rec = intents.records[0];
    expect(rec).toMatchObject({
      custody: "v3",
      sell: "USDC",
      buy: "WBTC",
      sellToken: USDC,
      buyToken: WBTC,
      amountIn: usdc(5n),
    });
    expect(rec?.route).toHaveLength(2);
    expect(rec?.checks).toMatchObject({ custody: "v3", sellDecimals: 6, buyDecimals: 8, hops: 2 });
    expect((rec?.checks as { routeTokens: string[] }).routeTokens).toEqual([USDC, WMON, WBTC]);
    expect(proposed).toEqual([rec?.intentId]);
    const again = await call("propose_swap", {
      sell: "USDC",
      buy: "WBTC",
      amount: "5",
      reason: "Again.",
      clientRequestId: "req-1",
    });
    expect(again.out).toMatchObject({ intentId: rec?.intentId, duplicate: true });
    const status = await call("get_intent_status", { intentId: rec?.intentId });
    expect(status.out).toMatchObject({
      status: "awaiting_approval",
      sell: { token: "USDC" },
      buy: { token: "WBTC" },
    });
  });

  it("propose_swap: a breaking swap is rejected with every reason, and stores no route when none exists", async () => {
    const { call, intents } = await start();
    const r = await call("propose_swap", {
      sell: "WMON",
      buy: "TOKD",
      amount: "100",
      reason: "Try a screened token.",
    });
    expect(r.out).toMatchObject({
      status: "rejected",
      reasonCodes: ["NOT_OPTED_IN", "ATTESTOR_UNAVAILABLE"],
    });
    const lonely = await call("propose_swap", {
      sell: "USDC",
      buy: "LONELY",
      amount: "1",
      reason: "No pool.",
    });
    expect(lonely.out).toMatchObject({
      status: "rejected",
      reasonCodes: ["ROUTE_INVALID"],
      route: null,
    });
    expect(intents.records.every((x) => x.status === "rejected")).toBe(true);
  });

  it("identity comes only from the token: another agent reads nothing of this one, and a forged header changes nothing", async () => {
    const { server, reader, call } = await start();
    const mine = await call("propose_swap", {
      sell: "USDC",
      buy: "WMON",
      amount: "1",
      reason: "Mine.",
    });
    const intentId = (mine.out as { intentId: string }).intentId;
    const carl = await connectClient(server.url, CARL_TOKEN, {
      extra: { "x-agent-id": "1", "x-alpha-agent": "1" },
    });
    await carl.callTool({ name: "get_portfolio", arguments: {} });
    expect(reader.agentReads.filter((id) => id === 3)).toHaveLength(1);
    const forged = await carl.callTool({ name: "get_portfolio", arguments: { agentId: 1 } });
    expect(structured(forged)).toMatchObject({ code: "INVALID_INPUT" });
    const other = await carl.callTool({ name: "get_intent_status", arguments: { intentId } });
    expect(structured(other)).toMatchObject({ code: "INTENT_NOT_FOUND" });
    await carl.close();
  });

  it("answers ACCOUNT_NOT_AVAILABLE before the owner opens a fund account, and logs every call", async () => {
    const { call, reader, log } = await start();
    reader.agents.set(1, agentState({ account: null, holdings: [], values: null, breaker: null }));
    expect(await call("get_portfolio")).toMatchObject({
      error: true,
      out: { code: "ACCOUNT_NOT_AVAILABLE" },
    });
    expect(await call("tradable_now", { sell: "USDC", buy: "WMON", amount: "1" })).toMatchObject({
      error: true,
      out: { code: "ACCOUNT_NOT_AVAILABLE" },
    });
    expect(log.calls.map((c) => [c.tool, c.status])).toEqual([
      ["get_portfolio", "failed"],
      ["tradable_now", "failed"],
    ]);
  });
});
