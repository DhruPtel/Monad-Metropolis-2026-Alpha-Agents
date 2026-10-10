import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { PoolInfoV3, TokenInfoV3 } from "./reader-v3.ts";
import { candidateRoutes, poolServes, routeTokens } from "./routes.ts";

/**
 * Route enumeration (F-U5): the routes Executor v3 would accept, and no other.
 */
const USDC = "0x00000000000000000000000000000000000000c1" as Hex;
const WMON = "0x00000000000000000000000000000000000000c2" as Hex;
const WBTC = "0x00000000000000000000000000000000000000c3" as Hex;
const AUSD = "0x00000000000000000000000000000000000000c4" as Hex;
const TOK_D = "0x00000000000000000000000000000000000000d1" as Hex;
const TOK_E = "0x00000000000000000000000000000000000000d2" as Hex;

const token = (t: Hex, priceClass: "F" | "A", lane: "CORE" | "SCREENED" = "CORE"): TokenInfoV3 => ({
  token: t,
  symbol: t.slice(-2),
  decimals: 18,
  lane,
  status: "BUYABLE",
  priceClass,
  maxPositionBps: 4_000,
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
  pricedToken: b,
  deviationBps: 0n,
  priceReason: "OK",
  ...over,
});

const tokens = [
  token(USDC, "F"),
  token(WMON, "F"),
  token(WBTC, "F"),
  token(AUSD, "F"),
  token(TOK_D, "A", "SCREENED"),
  token(TOK_E, "A", "SCREENED"),
];
const pools = [
  pool("1", USDC, WMON),
  pool("2", WMON, WBTC, { venue: "PANCAKESWAP_V3", fee: 500 }),
  pool("3", USDC, AUSD, { venue: "UNISWAP_V4", fee: 100 }),
  pool("4", WMON, TOK_D, { lane: "SCREENED" }),
  pool("5", USDC, WBTC, { status: "EXIT_ONLY" }),
  pool("6", TOK_D, TOK_E, { lane: "SCREENED" }),
  pool("7", AUSD, WBTC, { codeIntact: false }),
];
const market = { pools, tokens, usdc: USDC, wmon: WMON };
const rules = { optedIn: false, intoUsdc: false, sellsScreened: false };
const ids = (routes: PoolInfoV3[][]) => routes.map((r) => r.map((p) => Number(p.poolId)).join(">"));

describe("route enumeration (F-U5)", () => {
  it("finds every route of up to three hops, shortest first, through pools that serve", () => {
    // USDC to WBTC: the exit-only direct pool serves only into USDC, so the way is through WMON.
    expect(ids(candidateRoutes(market, USDC, WBTC, rules))).toEqual(["1>2"]);
    // WBTC to USDC: the direct exit-only pool and the two-hop route, shortest first.
    expect(ids(candidateRoutes(market, WBTC, USDC, { ...rules, intoUsdc: true }))).toEqual([
      "5",
      "2>1",
    ]);
    // AUSD to WBTC: three hops through USDC and WMON; the pool whose code changed never serves.
    expect(ids(candidateRoutes(market, AUSD, WBTC, rules))).toEqual(["3>1>2"]);
  });

  it("never revisits a token, never passes through a class A token, and stops at three hops", () => {
    // TOK_E could only be reached through TOK_D, a class A token between the ends.
    expect(candidateRoutes(market, WMON, TOK_E, { ...rules, optedIn: true })).toEqual([]);
    // AUSD to TOK_D is exactly three hops, through USDC and WMON.
    expect(ids(candidateRoutes(market, AUSD, TOK_D, { ...rules, optedIn: true }))).toEqual([
      "3>1>4",
    ]);
    expect(candidateRoutes(market, USDC, USDC, rules)).toEqual([]);
  });

  it("screened pools serve an account that opted in, or one selling a screened token (D-365)", () => {
    expect(candidateRoutes(market, WMON, TOK_D, rules)).toEqual([]);
    expect(ids(candidateRoutes(market, WMON, TOK_D, { ...rules, optedIn: true }))).toEqual(["4"]);
    expect(
      ids(candidateRoutes(market, TOK_D, USDC, { ...rules, intoUsdc: true, sellsScreened: true })),
    ).toEqual(["4>1", "4>2>5"]);
    const screened = pool("4", WMON, TOK_D, { lane: "SCREENED" });
    expect(poolServes(screened, rules)).toBe(false);
    expect(poolServes(screened, { ...rules, sellsScreened: true })).toBe(true);
    expect(poolServes(pool("9", USDC, WMON, { status: "PAUSED" }), rules)).toBe(false);
    expect(poolServes(pool("9", USDC, WMON, { status: "EXIT_ONLY" }), rules)).toBe(false);
    expect(
      poolServes(pool("9", USDC, WMON, { status: "EXIT_ONLY" }), { ...rules, intoUsdc: true }),
    ).toBe(true);
  });

  it("names the tokens a route crosses, the ends included", () => {
    const [route] = candidateRoutes(market, AUSD, WBTC, rules);
    expect(routeTokens(route as PoolInfoV3[], AUSD)).toEqual([AUSD, USDC, WMON, WBTC]);
  });
});
