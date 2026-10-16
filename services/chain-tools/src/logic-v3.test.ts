import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { executorV3 } from "@alpha-agents/policy";
import { executorMarketV3, minAmountOutV3, tokenStatsViewV3, whyNotBuyableV3 } from "./logic-v3.ts";
import type {
  AgentStateV3,
  MarketStateV3,
  PoolInfoV3,
  TokenInfoV3,
  V2TokenStatV3,
} from "./reader-v3.ts";

/**
 * The Executor mirror's market for a class A trade (F-U12): a class A side
 * is attested when the market carries the attestor's price (the attested
 * reader lays it over the market), and its hop is judged by the pool's own
 * price against the attested one within the oracle's deviation limit, as
 * ExecutorV3._checkHopPrice does; without the price, the side is unattested
 * and the hop's feed is off.
 */
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603" as Hex;
const GHO = "0xfc421ad3c883bf9e7c4f42de845c4e4405799e73" as Hex;
const E18 = 10n ** 18n;

const token = (t: Hex, symbol: string, priceClass: "F" | "A"): TokenInfoV3 =>
  ({
    token: t,
    symbol,
    decimals: symbol === "USDC" ? 6 : 18,
    lane: priceClass === "A" ? "SCREENED" : "CORE",
    status: "BUYABLE",
    priceClass,
    maxPositionBps: priceClass === "A" ? 1_500 : 10_000,
  }) as unknown as TokenInfoV3;

const pool = (poolPriceE18: bigint | null): PoolInfoV3 =>
  ({
    poolId: `0x${"ab".repeat(32)}`,
    venue: "UNISWAP_V4",
    tokenA: USDC,
    tokenB: GHO,
    currency0: USDC,
    currency1: GHO,
    fee: 100,
    tickSpacing: 1,
    pool: `0x${"00".repeat(20)}`,
    lane: "SCREENED",
    status: "ACTIVE",
    codeIntact: true,
    pricedToken: GHO,
    deviationBps: 0n,
    priceReason: "ATTESTATION_REQUIRED",
    poolPriceE18,
  }) as unknown as PoolInfoV3;

const market = (ghoPrice: bigint | null, poolPriceE18: bigint | null): MarketStateV3 =>
  ({
    chainId: 143143,
    block: 1n,
    timestamp: 1_760_000_000n,
    policy: {},
    policyHash: "0x",
    paused: false,
    adapterAllowed: true,
    attestorSet: true,
    maxDeviationBps: 200n,
    usdc: USDC,
    wmon: "0x3bd359c1e6a1b7b4c8d1f5a9c4e2b7d6f8a1c3e5",
    tokens: [token(USDC, "USDC", "F"), token(GHO, "GHO", "A")],
    prices: {
      [USDC]: { priceE18: E18, updatedAt: 1n, reason: "OK" },
      [GHO]:
        ghoPrice === null
          ? { priceE18: 0n, updatedAt: 0n, reason: "ATTESTATION_REQUIRED" }
          : { priceE18: ghoPrice, updatedAt: 1n, reason: "OK" },
    },
    pools: [pool(poolPriceE18)],
  }) as unknown as MarketStateV3;

const agent = {
  account: `0x${"ac".repeat(20)}`,
  timestamp: 1_760_000_000n,
  mode: "NORMAL",
  screenedOptIn: true,
  holdings: [],
  breaker: null,
  trades: [],
} as unknown as AgentStateV3 & { account: Hex };

describe("the Executor mirror's market for a class A trade", () => {
  it("attests the class A side from the market's price and judges the hop by the pool against it", () => {
    const m = market(E18, (E18 * 1005n) / 1000n);
    const em = executorMarketV3(agent, m, token(USDC, "USDC", "F"), token(GHO, "GHO", "A"), [
      pool((E18 * 1005n) / 1000n),
    ]);
    expect(em.sides[GHO]).toEqual({ priceE18: E18, attestation: "VALID" });
    expect(em.route[0]?.price).toBe("OK");
  });

  it("turns the hop off when the pool is further from the attested price than the deviation limit", () => {
    const m = market(E18, (E18 * 103n) / 100n);
    const em = executorMarketV3(agent, m, token(USDC, "USDC", "F"), token(GHO, "GHO", "A"), [
      pool((E18 * 103n) / 100n),
    ]);
    expect(em.route[0]?.price).toBe("POOL_OFF");
    const unread = executorMarketV3(
      agent,
      market(E18, null),
      token(USDC, "USDC", "F"),
      token(GHO, "GHO", "A"),
      [pool(null)],
    );
    expect(unread.route[0]?.price).toBe("POOL_OFF");
  });

  it("leaves the side unattested and the hop's feed off without an attested price", () => {
    const m = market(null, E18);
    const em = executorMarketV3(agent, m, token(USDC, "USDC", "F"), token(GHO, "GHO", "A"), [
      pool(E18),
    ]);
    expect(em.sides[GHO]).toEqual({ priceE18: 0n, attestation: "NONE" });
    expect(em.route[0]?.price).toBe("FEED_OFF");
  });
});

describe("a vault's account in the mirror and the buyability (P7-U2, D-338)", () => {
  const vaultAgent = { ...agent, isVault: true, mode: "WIND_DOWN" } as unknown as AgentStateV3 & {
    account: Hex;
  };

  it("carries the vault flag and the canonical mode into the Executor's market", () => {
    const em = executorMarketV3(
      vaultAgent,
      market(E18, E18),
      token(USDC, "USDC", "F"),
      token(GHO, "GHO", "A"),
      [pool(E18)],
    );
    expect(em.isVault).toBe(true);
    expect(em.mode).toBe("WIND_DOWN");
    const personal = executorMarketV3(
      agent,
      market(E18, E18),
      token(USDC, "USDC", "F"),
      token(GHO, "GHO", "A"),
      [pool(E18)],
    );
    expect(personal.isVault).toBeFalsy();
  });

  it("names why a vault cannot buy a class A or a screened token, and lets a core class F one through", () => {
    const ok = { reason: "OK" };
    expect(whyNotBuyableV3(token(GHO, "GHO", "A"), ok, true, true, true)).toMatch(
      /class F tokens only/,
    );
    const screenedF = { ...token(GHO, "X", "F"), lane: "SCREENED" } as TokenInfoV3;
    expect(whyNotBuyableV3(screenedF, ok, true, true, true)).toMatch(/class F tokens only/);
    expect(whyNotBuyableV3(token(GHO, "WMON", "F"), ok, false, true, true)).toBeNull();
    // The same tokens for a personal account that opted in are buyable.
    expect(whyNotBuyableV3(token(GHO, "GHO", "A"), ok, true, true)).toBeNull();
    expect(whyNotBuyableV3(token(GHO, "GHO", "A"), ok, true, true, false)).toBeNull();
  });
});

describe("the testnet price mode and a v2 family venue's tokens (2026-10-16)", () => {
  const WMON = "0x5a4e0bfdef88c9032cb4d24338c5eb3d3870bfdd" as Hex;
  const TOK = "0xfa3fcbebfbd3160731caa3ab868e073777da7777" as Hex;
  const quoteMarket = {
    ...market(E18, E18),
    quoteMode: true,
    wmon: WMON,
    policy: { maxSlippageBps: 300, maxSlippageClassABps: 300 },
    tokens: [token(USDC, "USDC", "F"), token(WMON, "WMON", "F"), token(TOK, "TTT", "F")],
    prices: {
      [USDC]: { priceE18: E18, updatedAt: 1n, reason: "OK" },
      [WMON]: { priceE18: 25n * 10n ** 15n, updatedAt: 1n, reason: "OK" },
      [TOK]: { priceE18: 10n ** 13n, updatedAt: 1n, reason: "OK" },
    },
  } as unknown as MarketStateV3;

  it("takes the route's own quote less the slippage limit as the least out, never the prices' floor", () => {
    const sell = token(USDC, "USDC", "F");
    const buy = token(TOK, "TTT", "F");
    expect(minAmountOutV3(quoteMarket, sell, buy, 10_000_000n, 1_000_000n)).toBe(970_000n);
    expect(minAmountOutV3(quoteMarket, sell, buy, 10_000_000n, null)).toBe(0n);
    // The mirror applies the same floor when the market carries the quote.
    expect(
      executorV3.slippageFloor(
        { amountIn: 10_000_000n },
        { quotedOut: 1_000_000n },
        E18,
        6,
        E18,
        18,
        300,
      ),
    ).toBe(970_000n);
    expect(executorV3.slippageFloor({ amountIn: 10n ** 6n }, {}, E18, 6, E18, 6, 300)).toBe(
      970_000n,
    );
  });

  it("reads a token's market from its pair: price, liquidity, depth, round trip, swaps and change", () => {
    const pool = {
      poolId: `0x${"cd".repeat(32)}`,
      venue: "UNISWAP_V2",
      currency0: WMON,
      currency1: TOK,
      fee: 16_000,
    } as unknown as PoolInfoV3;
    const stat: V2TokenStatV3 = {
      token: TOK,
      symbol: "TTT",
      decimals: 18,
      pool,
      baseToken: WMON,
      reserveBase: 200_000n * E18,
      reserveToken: 500_000_000n * E18,
      totalSupply: 1_000_000_000n * E18,
      swaps: 3,
      baseVolume: 1_000n * E18,
      startReserves: { base: 190_000n * E18, token: 500_000_000n * E18 },
      fromBlock: 1n,
      toBlock: 2n,
    };
    const out = tokenStatsViewV3([stat], quoteMarket, 60);
    expect(out.tokens[0]).toMatchObject({
      token: "TTT",
      pairedWith: "WMON",
      feeBps: 160,
      priceUsd: "0.00001",
      // Both sides of 200,000 WMON at 0.025 USD.
      liquidityUsd: "10000.00",
      marketCapUsd: "10000.00",
      depthFor1PctUsd: "24.94",
      roundTripCostPct: "3.17",
      swaps: 3,
      volumeUsd: "25.00",
      priceChangePct: "5.26",
      holders: null,
    });
    expect(out.note).toMatch(/Testnet tokens/);
  });
});
