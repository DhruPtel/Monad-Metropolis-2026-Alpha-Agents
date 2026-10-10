import {
  REJECTION_MESSAGES,
  type RejectionCode,
  type TradeFlowCode,
  TRADE_FLOW_MESSAGES,
  staleFeedMessage,
} from "@alpha-agents/domain";
import { custodyV3, executorV3 } from "@alpha-agents/policy";
import { ToolError } from "@alpha-agents/tool-server";
import { type Hex, formatUnits, isAddressEqual } from "viem";
import { blocker } from "./logic.ts";
import type {
  AgentStateV3,
  ChainReaderV3,
  HoldingReadV3,
  MarketStateV3,
  PoolInfoV3,
  RouteQuoteV3,
  TokenInfoV3,
} from "./reader-v3.ts";
import { candidateRoutes, routeTokens } from "./routes.ts";
import type { Blocker } from "./schema.ts";
import type {
  LimitsOutputV3,
  PortfolioOutputV3,
  PricesOutputV3,
  QuoteOutputV3,
  RouteHopOutput,
} from "./schema-v3.ts";

/**
 * The chain tools' answers for the fund agent's v3 set (F-U5), computed from
 * what the v3 reader returned. Pure functions: every limit comes from
 * Executor v3's own views and from packages/policy's mirror of the contract,
 * never from constants here. Token keys in the mirror's market are lowercase
 * addresses, one canonical form on both sides.
 */

const BPS = 10_000n;
const DAY = 86_400n;
const lower = (a: Hex) => a.toLowerCase();
const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
const positive = (v: bigint) => (v > 0n ? v : 0n);
export const asOfV3 = (block: bigint, timestamp: bigint) => ({
  block: block.toString(),
  timestamp: iso(timestamp),
});
export const amountOfToken = (
  t: Pick<TokenInfoV3, "symbol" | "token" | "decimals">,
  raw: bigint,
) => ({
  token: t.symbol,
  tokenAddress: t.token,
  amount: formatUnits(raw, t.decimals),
  amountRaw: raw.toString(),
});
export const usdcOfV3 = (raw: bigint) => ({
  amount: formatUnits(raw, 6),
  amountRaw: raw.toString(),
});

/** The token an agent named: its registry address, or its symbol when that is unique. */
export function resolveToken(m: MarketStateV3, ref: string): TokenInfoV3 {
  if (/^0x[0-9a-fA-F]{40}$/.test(ref)) {
    const t = m.tokens.find((x) => isAddressEqual(x.token, ref as Hex));
    if (!t)
      throw new ToolError(
        "INVALID_INPUT",
        `${ref} is not in the token registry; list_tokens names every registered token.`,
        false,
      );
    return t;
  }
  const matches = m.tokens.filter((x) => x.symbol.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0] as TokenInfoV3;
  if (matches.length > 1)
    throw new ToolError(
      "INVALID_INPUT",
      `${ref} names ${matches.length} registered tokens; give the token's address.`,
      false,
    );
  throw new ToolError(
    "INVALID_INPUT",
    `${ref} is not a registered token's symbol or address; list_tokens names every registered token.`,
    false,
  );
}

export const tokenInfo = (m: MarketStateV3, token: Hex): TokenInfoV3 | null =>
  m.tokens.find((x) => isAddressEqual(x.token, token)) ?? null;

/** The account must exist on the v3 set; before the owner opens one there is nothing to read or trade. */
export function requireAccountV3(agent: AgentStateV3 | null): AgentStateV3 & { account: Hex } {
  if (!agent)
    throw new ToolError("ACCOUNT_NOT_AVAILABLE", "This agent does not exist on this chain.", false);
  if (!agent.account)
    throw new ToolError(
      "ACCOUNT_NOT_AVAILABLE",
      "The agent has no fund account yet: its owner opens one before the first deposit.",
      false,
    );
  return agent as AgentStateV3 & { account: Hex };
}

/** The class a holding is priced by: USDC itself, a feed (F) or an attestation (A). */
export type PriceSource = "usdc" | "chainlink" | "attestation";

/**
 * The price the account's views use for a held token now: USDC exactly 1, a
 * class F token's feed when usable, a class A token's last attested price
 * while under a day old, else none (CustodyCoreV3._valuation).
 */
export function holdingPrice(
  h: Pick<HoldingReadV3, "token" | "lastPriceE18" | "lastPricedAt">,
  m: MarketStateV3,
): { readonly priceE18: bigint; readonly usable: boolean; readonly source: PriceSource } {
  if (isAddressEqual(h.token, m.usdc))
    return { priceE18: 10n ** 18n, usable: true, source: "usdc" };
  const info = tokenInfo(m, h.token);
  if (info?.priceClass === "A") {
    const fresh = h.lastPricedAt !== 0n && h.lastPricedAt + DAY > m.timestamp;
    return { priceE18: fresh ? h.lastPriceE18 : 0n, usable: true, source: "attestation" };
  }
  const p = m.prices[lower(h.token)];
  return {
    priceE18: p && p.reason === "OK" ? p.priceE18 : 0n,
    usable: !!p && p.reason === "OK",
    source: "chainlink",
  };
}

const breakerStateOf = (drawdownBps: bigint): "NORMAL" | "REDUCE_ONLY" | "PAUSED" =>
  drawdownBps >= 2_000n ? "PAUSED" : drawdownBps >= 1_000n ? "REDUCE_ONLY" : "NORMAL";

export function portfolioViewV3(
  a: AgentStateV3 & { account: Hex },
  m: MarketStateV3,
): PortfolioOutputV3 {
  const nav = a.values?.nav ?? null;
  const rows: PortfolioOutputV3["holdings"] = a.holdings.map((h) => {
    const info = tokenInfo(m, h.token);
    const price = holdingPrice(h, m);
    const priced = price.priceE18 > 0n;
    const value = priced ? custodyV3.valueE6(h.balance, price.priceE18, h.decimals) : null;
    const shareBps =
      value !== null && nav !== null && nav > 0n ? Number((value * BPS) / nav) : null;
    return {
      token: info?.symbol ?? `${h.token.slice(0, 6)}…${h.token.slice(-4)}`,
      tokenAddress: h.token,
      class: price.source === "usdc" ? "USDC" : (info?.priceClass ?? "A"),
      lane: info?.lane ?? "NONE",
      status: info?.status ?? "NONE",
      amount: formatUnits(h.balance, h.decimals),
      amountRaw: h.balance.toString(),
      free: formatUnits(h.free, h.decimals),
      priceUsdc: priced ? formatUnits(price.priceE18, 18) : null,
      priceSource: price.source,
      valueUsdc: value === null ? null : formatUnits(value, 6),
      costBasisUsdc: isAddressEqual(h.token, m.usdc) ? null : formatUnits(h.costBasis, 6),
      shareBps,
    };
  });
  return {
    asOf: asOfV3(a.block, a.timestamp),
    account: a.account,
    holdings: rows,
    heldCount: a.holdings.length,
    maxHeld: custodyV3.CUSTODY_V3.maxHeldTokens,
    totalValueUsdc: nav === null ? null : usdcOfV3(nav),
    cappedValueUsdc: a.values ? usdcOfV3(a.values.capped) : null,
    costBasisUsdc: a.values ? usdcOfV3(a.values.totalBasis) : null,
    classACostBasisUsdc: a.values ? usdcOfV3(a.values.classABasis) : null,
    valuesUsable: a.values !== null,
    mode: a.mode,
    screenedOptIn: a.screenedOptIn,
    breaker: a.breaker
      ? {
          drawdownBps: Number(a.breaker.drawdownBps),
          state: breakerStateOf(a.breaker.drawdownBps),
          valuePerUnit: formatUnits(a.breaker.perUnit, 18),
          peakValuePerUnit7d: formatUnits(a.breaker.peak, 18),
        }
      : { drawdownBps: null, state: "UNKNOWN", valuePerUnit: null, peakValuePerUnit7d: null },
  };
}

/** The oracle reason as the rejection code Executor v3 gives for it. */
export const oracleBlockV3 = (
  reason: MarketStateV3["prices"][string]["reason"],
): RejectionCode | null =>
  reason === "OK"
    ? null
    : reason === "ATTESTATION_REQUIRED"
      ? "ATTESTOR_UNAVAILABLE"
      : reason === "POOL_DEVIATION" || reason === "POOL_UNREADABLE" || reason === "POOL_UNSUPPORTED"
        ? "ORACLE_POOL_DEVIATION"
        : "ORACLE_STALE";

export function pricesViewV3(m: MarketStateV3): PricesOutputV3 {
  return {
    asOf: asOfV3(m.block, m.timestamp),
    tokens: m.tokens.map((t) => {
      const usdc = isAddressEqual(t.token, m.usdc);
      const p = m.prices[lower(t.token)] ?? {
        priceE18: 0n,
        updatedAt: 0n,
        reason: "FEED_REVERTED" as const,
      };
      const classA = t.priceClass === "A";
      return {
        token: t.symbol,
        tokenAddress: t.token,
        class: usdc ? "USDC" : t.priceClass,
        lane: t.lane,
        status: t.status,
        source: usdc ? "usdc" : classA ? "attestation" : "chainlink",
        price: p.reason === "OK" ? formatUnits(p.priceE18, 18) : null,
        priceE18: p.reason === "OK" ? p.priceE18.toString() : null,
        updatedAt: p.updatedAt === 0n ? null : iso(p.updatedAt),
        ageSeconds: p.updatedAt === 0n ? null : Number(positive(m.timestamp - p.updatedAt)),
        feedStatus: classA
          ? m.attestorSet
            ? "ATTESTATION_REQUIRED"
            : "ATTESTOR_UNAVAILABLE"
          : p.reason,
        tradable: usdc || (!classA && p.reason === "OK"),
        blockedBy: usdc
          ? null
          : classA
            ? m.attestorSet
              ? "ATTESTATION_REQUIRED"
              : "ATTESTOR_UNAVAILABLE"
            : oracleBlockV3(p.reason),
      };
    }),
    pools: m.pools.map((p) => poolRow(p, m)),
  };
}

const venueName = (v: PoolInfoV3["venue"]): "uniswap_v3" | "pancakeswap_v3" | "uniswap_v4" =>
  v === "UNISWAP_V3" ? "uniswap_v3" : v === "PANCAKESWAP_V3" ? "pancakeswap_v3" : "uniswap_v4";

function poolRow(p: PoolInfoV3, m: MarketStateV3): PricesOutputV3["pools"][number] {
  const sym = (t: Hex) => tokenInfo(m, t)?.symbol ?? `${t.slice(0, 6)}…${t.slice(-4)}`;
  return {
    poolId: p.poolId,
    venue: venueName(p.venue),
    pair: `${sym(p.tokenA)}/${sym(p.tokenB)}`,
    feeBps: Number((BigInt(p.fee) + 99n) / 100n),
    lane: p.lane,
    status: p.status,
    codeIntact: p.codeIntact,
    deviationBps:
      p.priceReason === "OK" || p.priceReason === "POOL_DEVIATION" ? Number(p.deviationBps) : null,
    priceStatus: p.priceReason,
  };
}

/** One route hop for an answer: the pool, its venue and fee, and what goes in and comes out. */
export function routeHopsOutput(q: RouteQuoteV3, m: MarketStateV3): RouteHopOutput[] {
  return q.hops.map((h) => {
    const pool = q.route.find((p) => p.poolId === h.poolId) as PoolInfoV3;
    const tin = tokenInfo(m, h.tokenIn);
    const tout = tokenInfo(m, h.tokenOut);
    return {
      poolId: h.poolId,
      venue: venueName(pool.venue),
      feeBps: Number((BigInt(pool.fee) + 99n) / 100n),
      lane: pool.lane,
      sell: amountOfToken(tin ?? { symbol: h.tokenIn, token: h.tokenIn, decimals: 18 }, h.amountIn),
      buy: amountOfToken(
        tout ?? { symbol: h.tokenOut, token: h.tokenOut, decimals: 18 },
        h.amountOut,
      ),
    };
  });
}

/** How long a quote may be relied on before asking again (A-44). */
export const QUOTE_VALID_SECONDS_V3 = 10;

/** Each side's price for the floor: USDC 1, a class F feed, a class A token none (until F-U12). */
function sidePx(m: MarketStateV3, t: TokenInfoV3): bigint {
  if (isAddressEqual(t.token, m.usdc)) return 10n ** 18n;
  if (t.priceClass === "A") return 0n;
  const p = m.prices[lower(t.token)];
  return p && p.reason === "OK" ? p.priceE18 : 0n;
}

/** The least output Executor v3 accepts: the implied output less the slippage for the pair's class. */
export function floorForV3(
  m: MarketStateV3,
  sell: TokenInfoV3,
  buy: TokenInfoV3,
  amountIn: bigint,
): bigint {
  const pxIn = sidePx(m, sell);
  const pxOut = sidePx(m, buy);
  if (pxIn === 0n || pxOut === 0n) return 0n;
  const classA = sell.priceClass === "A" || buy.priceClass === "A";
  const slippage = classA ? m.policy.maxSlippageClassABps : m.policy.maxSlippageBps;
  return executorV3.floor(amountIn, pxIn, sell.decimals, pxOut, buy.decimals, slippage);
}

export function impliedOutV3(
  m: MarketStateV3,
  sell: TokenInfoV3,
  buy: TokenInfoV3,
  amountIn: bigint,
): bigint {
  const pxIn = sidePx(m, sell);
  const pxOut = sidePx(m, buy);
  if (pxIn === 0n || pxOut === 0n) return 0n;
  return executorV3.impliedOut(amountIn, pxIn, sell.decimals, pxOut, buy.decimals);
}

export function quoteViewV3(
  m: MarketStateV3,
  sell: TokenInfoV3,
  buy: TokenInfoV3,
  amountIn: bigint,
  q: RouteQuoteV3,
): QuoteOutputV3 {
  const implied = impliedOutV3(m, sell, buy, amountIn);
  const floor = floorForV3(m, sell, buy, amountIn);
  const slippage =
    implied === 0n || q.amountOut >= implied ? 0n : ((implied - q.amountOut) * BPS) / implied;
  const classA = sell.priceClass === "A" || buy.priceClass === "A";
  return {
    asOf: asOfV3(q.block, m.timestamp),
    sell: amountOfToken(sell, amountIn),
    expectedOut: amountOfToken(buy, q.amountOut),
    oracleImpliedOut: amountOfToken(buy, implied),
    minimumOutAllowed: amountOfToken(buy, floor),
    slippageBps: Number(slippage),
    maxSlippageBps: classA ? m.policy.maxSlippageClassABps : m.policy.maxSlippageBps,
    passesSlippageLimit: floor > 0n && q.amountOut >= floor,
    route: routeHopsOutput(q, m),
    hops: q.route.length,
    routeFeeBps: Number(executorV3.routeFeeBps(q.route.map((p) => ({ fee: p.fee })))),
    routesConsidered: q.candidates,
    quoteValidSeconds: QUOTE_VALID_SECONDS_V3,
  };
}

export function limitsViewV3(a: AgentStateV3 & { account: Hex }, m: MarketStateV3): LimitsOutputV3 {
  const p = m.policy;
  const v = a.values;
  const grant = a.grant;
  const nav = v?.nav ?? null;
  const capped = v?.capped ?? null;
  const usdcFree = a.holdings.find((h) => isAddressEqual(h.token, m.usdc))?.free ?? 0n;
  const perToken = m.tokens
    .filter((t) => !isAddressEqual(t.token, m.usdc))
    .map((t) => {
      const h = a.holdings.find((x) => isAddressEqual(x.token, t.token));
      const classA = t.priceClass === "A";
      const capBps = classA
        ? Math.min(p.maxClassAPositionBps, t.maxPositionBps)
        : Math.min(p.maxAssetBps, t.maxPositionBps);
      let room: bigint | null = null;
      if (classA) {
        // By cost basis: what was paid stays within the cap of what the account paid for everything.
        if (v) room = positive((v.totalBasis * BigInt(capBps)) / BPS - (h?.costBasis ?? 0n));
      } else if (capped !== null) {
        const px = holdingPrice({ token: t.token, lastPriceE18: 0n, lastPricedAt: 0n }, m);
        const held =
          h && px.priceE18 > 0n ? custodyV3.valueE6(h.free, px.priceE18, t.decimals) : 0n;
        room = positive((capped * BigInt(capBps)) / BPS - held);
      }
      return {
        token: t.symbol,
        tokenAddress: t.token,
        class: t.priceClass,
        lane: t.lane,
        status: t.status,
        held: !!h && h.balance > 0n,
        capBps,
        roomBeforeCapUsdc: room === null ? null : usdcOfV3(room),
        buyable:
          t.status === "BUYABLE" &&
          (t.lane === "CORE" || (t.lane === "SCREENED" && a.screenedOptIn)),
      };
    });
  return {
    asOf: asOfV3(a.block, a.timestamp),
    mode: a.mode,
    screenedOptIn: a.screenedOptIn,
    accountValueUsdc: nav === null ? null : usdcOfV3(nav),
    cappedValueUsdc: capped === null ? null : usdcOfV3(capped),
    maxTradeValueUsdc: capped === null ? null : usdcOfV3((capped * BigInt(p.maxTradeBps)) / BPS),
    usdcAboveFloor:
      nav === null ? null : usdcOfV3(positive(usdcFree - (nav * BigInt(p.minUsdcBps)) / BPS)),
    tradesLeft24h: a.tradesLeft,
    nextSlotFreesAt: a.tradesLeft === 0 && a.nextSlotFreesAt > 0n ? iso(a.nextSlotFreesAt) : null,
    turnoverLeftUsdc:
      capped === null
        ? null
        : usdcOfV3(positive((capped * BigInt(p.maxTurnoverBps)) / BPS - a.turnoverUsed)),
    maxSlippageBps: p.maxSlippageBps,
    maxSlippageClassABps: p.maxSlippageClassABps,
    deadlineSeconds: p.deadlineSeconds,
    classA: {
      positionCapBps: p.maxClassAPositionBps,
      totalCapBps: p.maxClassATotalBps,
      costBasisUsdc: v ? usdcOfV3(v.classABasis) : null,
      roomBeforeTotalCapUsdc: v
        ? usdcOfV3(positive((v.totalBasis * BigInt(p.maxClassATotalBps)) / BPS - v.classABasis))
        : null,
      attestorAvailable: m.attestorSet,
    },
    perToken,
    sessionGrant: {
      registered: grant !== null,
      validUntil: grant ? iso(grant.validUntil) : null,
      expired: grant !== null && grant.validUntil < a.timestamp,
    },
    limits: {
      maxTradeBps: p.maxTradeBps,
      maxAssetBps: p.maxAssetBps,
      minUsdcBps: p.minUsdcBps,
      maxTurnoverBps: p.maxTurnoverBps,
      maxTradesPerWindow: p.maxTradesPerWindow,
      windowSeconds: p.windowSeconds,
      maxClassAPositionBps: p.maxClassAPositionBps,
      maxClassATotalBps: p.maxClassATotalBps,
    },
  };
}

/** The mirror's hop state for a registered pool: usable by status and code, and its price against the oracle. */
function hopOf(p: PoolInfoV3, intoUsdc: boolean): executorV3.RouteHopV3 {
  const price: executorV3.HopPriceStateV3 =
    p.priceReason === "OK"
      ? "OK"
      : p.priceReason === "POOL_DEVIATION" ||
          p.priceReason === "POOL_UNREADABLE" ||
          p.priceReason === "POOL_UNSUPPORTED"
        ? "POOL_OFF"
        : "FEED_OFF";
  return {
    tokenA: lower(p.tokenA),
    tokenB: lower(p.tokenB),
    fee: p.fee,
    lane: p.lane,
    usable: p.codeIntact && (p.status === "ACTIVE" || (p.status === "EXIT_ONLY" && intoUsdc)),
    price,
  };
}

/** The market as packages/policy's Executor v3 mirror reads it, for one trade along one route. */
export function executorMarketV3(
  a: AgentStateV3 & { account: Hex },
  m: MarketStateV3,
  sell: TokenInfoV3,
  buy: TokenInfoV3,
  route: readonly PoolInfoV3[],
): executorV3.ExecutorMarketV3 {
  const tokens: Record<string, executorV3.TokenRuleV3> = {};
  for (const t of m.tokens)
    tokens[lower(t.token)] = {
      lane: t.lane,
      status: t.status,
      priceClass: t.priceClass,
      decimals: t.decimals,
      maxPositionBps: t.maxPositionBps,
    };
  const sides: Record<string, executorV3.SidePriceV3> = {};
  for (const t of [sell, buy]) {
    if (isAddressEqual(t.token, m.usdc)) continue;
    if (t.priceClass === "A") sides[lower(t.token)] = { priceE18: 0n, attestation: "NONE" };
    else {
      const p = m.prices[lower(t.token)];
      sides[lower(t.token)] = {
        priceE18: p && p.reason === "OK" ? p.priceE18 : 0n,
        feed: p && p.reason === "OK" ? "OK" : "UNUSABLE",
      };
    }
  }
  const intoUsdc = isAddressEqual(buy.token, m.usdc);
  return {
    now: a.timestamp,
    paused: m.paused,
    mode: a.mode === "WIND_DOWN" ? "PAUSED" : a.mode,
    adapterAllowed: m.adapterAllowed,
    oracleSet: true,
    usdc: lower(m.usdc),
    wmon: lower(m.wmon),
    tokens,
    holdings: a.holdings.map((h) => {
      const px = holdingPrice(h, m);
      return {
        token: lower(h.token),
        free: h.free,
        costBasis: h.costBasis,
        priceE18: px.priceE18,
        priceUsable: px.usable,
      };
    }),
    optedIn: a.screenedOptIn,
    attestorSet: m.attestorSet,
    sides,
    route: route.map((p) => hopOf(p, intoUsdc)),
    drawdownBps: a.breaker?.drawdownBps ?? 0n,
    trades: a.trades,
  };
}

/**
 * The intent a trade would carry if sent now: the oracle floor as the minimum
 * out, a fresh deadline. With no usable price there is no floor; 1 stands in,
 * so only the price rule blocks the trade (L-118).
 */
export function tradeNowV3(
  m: MarketStateV3,
  sell: TokenInfoV3,
  buy: TokenInfoV3,
  amountIn: bigint,
): executorV3.ExecutorIntentV3 {
  const floor = floorForV3(m, sell, buy, amountIn);
  return {
    tokenIn: lower(sell.token),
    tokenOut: lower(buy.token),
    amountIn,
    minAmountOut: floor > 0n ? floor : 1n,
    deadline: m.timestamp + BigInt(m.policy.deadlineSeconds),
  };
}

const ROUTE_HINTS: Readonly<Record<string, { clears: Blocker["clears"]; hint: string }>> = {
  NO_ROUTE: {
    clears: "by_the_platform",
    hint: "No registered route of up to three pools connects these two tokens; find_pools shows which pools exist, and the platform registers them.",
  },
};

/**
 * Every rule that blocks this trade right now (`tradable_now`, and the
 * pre-check of `propose_swap`): Executor v3's own rules in its order from
 * packages/policy, the session grant's, the reserved slots, and the venues'
 * best quote against the oracle floor. `quote` is null when no route exists
 * or none could be quoted.
 */
export function blockersForV3(
  a: AgentStateV3 & { account: Hex },
  m: MarketStateV3,
  sell: TokenInfoV3,
  buy: TokenInfoV3,
  amountIn: bigint,
  quote: RouteQuoteV3 | null,
  /** A route through registered pools whatever their lanes, so a lane refusal names itself; null when none exists. */
  anyRoute: readonly PoolInfoV3[] | null,
  sessionKey: Hex | null,
  reservedSlots = 0,
): Blocker[] {
  const routeExists = anyRoute !== null;
  const route = quote?.route ?? anyRoute ?? [];
  const market = executorMarketV3(a, m, sell, buy, route);
  const trade = tradeNowV3(m, sell, buy, amountIn);
  const executorCodes = executorV3.blockers(trade, market, m.policy);
  // Executor v3 checks the pause, the intent's shape and the tokens first, then the session, then the rest.
  const shape: RejectionCode[] = [
    "PAUSED",
    "INTENT_INVALID",
    "ROUTE_INVALID",
    "ASSET_NOT_ALLOWED",
    "TOKEN_FROZEN",
    "TOKEN_SELL_ONLY",
    "NOT_OPTED_IN",
  ];
  const first = executorCodes.filter(
    (c) => (c === "PAUSED" && m.paused) || (c !== "PAUSED" && shape.includes(c)),
  );
  const session: RejectionCode[] = [];
  const g = a.grant;
  if (!g || (sessionKey !== null && !isAddressEqual(g.key, sessionKey)))
    session.push("SESSION_UNKNOWN");
  else {
    if (g.validUntil < a.timestamp) session.push("SESSION_EXPIRED");
    if (g.ownerEpoch !== a.ownerEpoch || g.configEpoch !== a.configEpoch)
      session.push("EPOCH_MISMATCH");
  }
  const codes: RejectionCode[] = [];
  for (const c of [...first, ...session, ...executorCodes]) if (!codes.includes(c)) codes.push(c);
  // A route the mirror could not check because none exists is ROUTE_INVALID, named once.
  if (!routeExists && !codes.includes("ROUTE_INVALID")) codes.push("ROUTE_INVALID");
  const used = executorV3.rollingWindow(market, m.policy).count + reservedSlots;
  if (used >= m.policy.maxTradesPerWindow && !codes.includes("DAILY_TRADE_LIMIT"))
    codes.push("DAILY_TRADE_LIMIT");
  // The venues must fill at least the floor; the price rules above cover a missing price.
  const priced = trade.minAmountOut > 1n;
  if (priced && amountIn > 0n && routeExists && !codes.includes("SLIPPAGE_TOO_HIGH")) {
    if (quote === null) {
      if (!codes.includes("VENUE_NOT_ALLOWED")) codes.push("SIMULATION_FAILED");
    } else if (quote.amountOut < trade.minAmountOut) codes.push("SLIPPAGE_TOO_HIGH");
  }
  const window = executorV3.rollingWindow(market, m.policy);
  return codes.map((c) => {
    const b = blocker(
      c,
      c === "DAILY_TRADE_LIMIT" || c === "TURNOVER_CAP" ? window.oldestLeavesAt : null,
      m.paused && a.mode !== "PAUSED",
    );
    if (c === "ROUTE_INVALID" && !routeExists)
      return {
        ...b,
        clears: ROUTE_HINTS.NO_ROUTE?.clears ?? b.clears,
        hint: ROUTE_HINTS.NO_ROUTE?.hint ?? b.hint,
      };
    if (c === "ORACLE_STALE") return staleBlockerV3(b, m, sell, buy, a);
    return b;
  });
}

/**
 * A stale class F feed names its token and how old its answer is (L-145,
 * D-317): MON/USD through the domain's message, any other token's feed in
 * the same words with its own age; anything else keeps the generic text.
 */
function staleBlockerV3(
  b: Blocker,
  m: MarketStateV3,
  sell: TokenInfoV3,
  buy: TokenInfoV3,
  a: AgentStateV3,
): Blocker {
  const candidates = [sell, buy, ...a.holdings.map((h) => tokenInfo(m, h.token))].filter(
    (t): t is TokenInfoV3 => !!t,
  );
  const stale = candidates.find(
    (t) => t.priceClass === "F" && m.prices[lower(t.token)]?.reason === "STALE",
  );
  if (!stale) return b;
  const p = m.prices[lower(stale.token)];
  if (!p) return b;
  if (isAddressEqual(stale.token, m.wmon))
    return {
      ...b,
      message: staleFeedMessage({
        feed: "MON_USD",
        updatedAt: Number(p.updatedAt),
        now: Number(m.timestamp),
        refused: "trade",
      }),
    };
  const age = Number(positive(m.timestamp - p.updatedAt));
  const minutes = Math.floor(age / 60);
  return {
    ...b,
    message: `Trades are refused because ${stale.symbol}'s price feed is stale: it last updated ${minutes >= 1 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${age} seconds`} ago, past its own staleness bound. Trades wait for its next update; withdrawals need no price. Nothing was sent.`,
  };
}

export interface TradeAssessmentV3 {
  readonly m: MarketStateV3;
  readonly a: AgentStateV3 & { account: Hex };
  readonly sell: TokenInfoV3;
  readonly buy: TokenInfoV3;
  readonly quote: RouteQuoteV3 | null;
  readonly routeExists: boolean;
  readonly blockers: Blocker[];
}

/**
 * Every pre-check for one trade from fresh reads: what propose_swap and
 * tradable_now answer, and what the trade flow re-runs at submission. Null
 * when the agent has no v3 account.
 */
export async function assessTradeV3(
  reader: ChainReaderV3,
  agentId: number,
  sellRef: string,
  buyRef: string,
  amountIn: bigint,
  sessionKey: Hex | null,
  reservedSlots = 0,
): Promise<TradeAssessmentV3 | null> {
  const [m, agent] = await Promise.all([reader.market(), reader.agent(agentId)]);
  if (!agent?.account) return null;
  const a = agent as AgentStateV3 & { account: Hex };
  const sell = resolveToken(m, sellRef);
  const buy = resolveToken(m, buyRef);
  const rules = {
    optedIn: a.screenedOptIn,
    intoUsdc: isAddressEqual(buy.token, m.usdc),
    sellsScreened: sell.lane === "SCREENED",
  };
  // Every registered path, lanes aside: when the account's own rules leave none, the mirror
  // still sees the pools and names the lane (NOT_OPTED_IN, VENUE_NOT_ALLOWED), not "no route".
  const anyRoute =
    candidateRoutes(m, sell.token, buy.token, {
      ...rules,
      optedIn: true,
      sellsScreened: true,
    })[0] ?? null;
  const quote =
    anyRoute && candidateRoutes(m, sell.token, buy.token, rules).length > 0
      ? await reader.bestRoute(sell.token, buy.token, amountIn, rules).catch(() => null)
      : null;
  return {
    m,
    a,
    sell,
    buy,
    quote,
    routeExists: anyRoute !== null,
    blockers: blockersForV3(a, m, sell, buy, amountIn, quote, anyRoute, sessionKey, reservedSlots),
  };
}

/** The tokens a quoted route crosses, for the signer's reconciliation. */
export const routeTokensOf = (q: RouteQuoteV3, tokenIn: Hex): Hex[] =>
  routeTokens(q.route, tokenIn);

/** Parses an amount in token units; refuses more decimals than the token has. */
export function parseTokenAmountV3(text: string, t: TokenInfoV3): bigint {
  const [whole = "0", frac = ""] = text.split(".");
  if (frac.length > t.decimals)
    throw new ToolError(
      "INVALID_INPUT",
      `${t.symbol} has ${t.decimals} decimals; the amount has more.`,
      false,
    );
  return BigInt(whole) * 10n ** BigInt(t.decimals) + BigInt(frac.padEnd(t.decimals, "0") || "0");
}

export const messageFor = (code: RejectionCode | TradeFlowCode): string =>
  code in REJECTION_MESSAGES
    ? REJECTION_MESSAGES[code as RejectionCode]
    : TRADE_FLOW_MESSAGES[code as TradeFlowCode];
