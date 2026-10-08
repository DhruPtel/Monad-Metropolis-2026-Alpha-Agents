import {
  ASSET_DECIMALS,
  type AssetId,
  REJECTION_MESSAGES,
  type RejectionCode,
  TRADE_FLOW_MESSAGES,
  type TradeFlowCode,
} from "@alpha-agents/domain";
import {
  type ExecutorMarket,
  type ExecutorTrade,
  executorBlockers,
  oracleFloor,
  rollingWindow,
} from "@alpha-agents/policy";
import { ToolError } from "@alpha-agents/tool-server";
import { type Hex, formatUnits, isAddressEqual } from "viem";
import type { AgentState, ChainReader, MarketState, Quote } from "./reader.ts";
import type {
  Blocker,
  LimitsOutput,
  PortfolioOutput,
  PricesOutput,
  QuoteOutput,
} from "./schema.ts";

/**
 * The chain tools' answers, computed from what the reader returned (P2-U5).
 * Pure functions: the limits and their arithmetic come from the Executor's own
 * views and from packages/policy, which mirrors the contract, never from
 * constants here.
 */

const BPS = 10_000n;
const WMON_VALUE_SCALE = 10n ** 30n;

export const decimal = (raw: bigint, asset: AssetId) => formatUnits(raw, ASSET_DECIMALS[asset]);
export const amountOf = (asset: AssetId, raw: bigint) => ({
  asset,
  amount: decimal(raw, asset),
  amountRaw: raw.toString(),
});
export const usdcOf = (raw: bigint) => ({
  amount: decimal(raw, "USDC"),
  amountRaw: raw.toString(),
});
const positive = (v: bigint) => (v > 0n ? v : 0n);
const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
export const asOf = (block: bigint, timestamp: bigint) => ({
  block: block.toString(),
  timestamp: iso(timestamp),
});

/** USDC value (6 decimals) of an amount at the WMON price (USDC per WMON, 1e18). */
export const valueUsdc = (asset: AssetId, raw: bigint, pxE18: bigint) =>
  asset === "USDC" ? raw : (raw * pxE18) / WMON_VALUE_SCALE;

/** The account must exist; before the owner's first deposit there is nothing to read or trade. */
export function requireAccount(agent: AgentState | null): AgentState & { account: Hex } {
  if (!agent)
    throw new ToolError("ACCOUNT_NOT_AVAILABLE", "This agent does not exist on this chain.", false);
  if (!agent.account)
    throw new ToolError(
      "ACCOUNT_NOT_AVAILABLE",
      "The agent has no trading account yet: its owner opens one with the first deposit.",
      false,
    );
  return agent as AgentState & { account: Hex };
}

const breakerStateOf = (drawdownBps: bigint): "NORMAL" | "REDUCE_ONLY" | "PAUSED" =>
  drawdownBps >= 2_000n ? "PAUSED" : drawdownBps >= 1_000n ? "REDUCE_ONLY" : "NORMAL";

export function portfolioView(a: AgentState & { account: Hex }, m: MarketState): PortfolioOutput {
  const px = m.monUsd.priceE18;
  const wmonValue = valueUsdc("WMON", a.wmon, px);
  const total = a.usdc + wmonValue;
  const share = (v: bigint) => (total === 0n ? 0 : Number((v * BPS) / total));
  return {
    asOf: asOf(a.block, a.timestamp),
    account: a.account,
    holdings: [
      { ...amountOf("USDC", a.usdc), valueUsdc: decimal(a.usdc, "USDC"), shareBps: share(a.usdc) },
      {
        ...amountOf("WMON", a.wmon),
        valueUsdc: decimal(wmonValue, "USDC"),
        shareBps: share(wmonValue),
      },
    ],
    totalValueUsdc: usdcOf(total),
    mode: a.mode,
    breaker: a.breaker
      ? {
          drawdownBps: Number(a.breaker.drawdownBps),
          state: breakerStateOf(a.breaker.drawdownBps),
          valuePerUnit: formatUnits(a.breaker.perUnit, 18),
          peakValuePerUnit7d: formatUnits(a.breaker.peak, 18),
        }
      : {
          drawdownBps: null,
          state: "UNKNOWN",
          valuePerUnit: null,
          peakValuePerUnit7d: formatUnits(a.peak7d, 18),
        },
    priceUsedUsdcPerWmon: formatUnits(px, 18),
  };
}

/** The oracle reason as the rejection code the Executor gives for it. */
export const oracleBlock = (reason: MarketState["tradableReason"]): RejectionCode | null =>
  reason === "OK"
    ? null
    : reason === "POOL_DEVIATION" || reason === "POOL_UNREADABLE"
      ? "ORACLE_POOL_DEVIATION"
      : "ORACLE_STALE";

export function pricesView(m: MarketState): PricesOutput {
  const feed = (f: MarketState["monUsd"]) => ({
    price: formatUnits(f.priceE18, 18),
    priceE18: f.priceE18.toString(),
    updatedAt: f.updatedAt === 0n ? "never" : iso(f.updatedAt),
    ageSeconds: f.updatedAt === 0n ? -1 : Number(positive(m.timestamp - f.updatedAt)),
    status: f.reason,
  });
  return {
    asOf: asOf(m.block, m.timestamp),
    monUsd: feed(m.monUsd),
    usdcUsd: feed(m.usdcUsd),
    pool: {
      price: formatUnits(m.pool.priceE18, 18),
      priceE18: m.pool.priceE18.toString(),
      status: m.pool.reason,
    },
    poolDeviationBps: Number(m.deviationBps),
    tradable: m.tradableReason === "OK",
    blockedBy: oracleBlock(m.tradableReason),
  };
}

/** What selling `amountIn` of `sell` is worth in the other asset at the oracle price. */
export function oracleImplied(sell: AssetId, amountIn: bigint, pxE18: bigint): bigint {
  if (pxE18 === 0n) return 0n;
  return sell === "USDC"
    ? (amountIn * WMON_VALUE_SCALE) / pxE18
    : (amountIn * pxE18) / WMON_VALUE_SCALE;
}

/** The least output the Executor accepts for this trade (its `oracleFloor`). */
export const floorFor = (sell: AssetId, amountIn: bigint, m: MarketState) =>
  m.monUsd.priceE18 === 0n
    ? 0n
    : oracleFloor(sell, amountIn, m.monUsd.priceE18, m.policy.maxSlippageBps);

/** How long a quote may be relied on before asking again (A-44). */
export const QUOTE_VALID_SECONDS = 10;

export function quoteView(
  sell: AssetId,
  buy: AssetId,
  amountIn: bigint,
  q: Quote,
  m: MarketState,
): QuoteOutput {
  const implied = oracleImplied(sell, amountIn, m.monUsd.priceE18);
  const floor = floorFor(sell, amountIn, m);
  const slippage =
    implied === 0n || q.amountOut >= implied ? 0n : ((implied - q.amountOut) * BPS) / implied;
  return {
    asOf: asOf(q.block, m.timestamp),
    sell: amountOf(sell, amountIn),
    expectedOut: amountOf(buy, q.amountOut),
    oracleImpliedOut: amountOf(buy, implied),
    minimumOutAllowed: amountOf(buy, floor),
    slippageBps: Number(slippage),
    maxSlippageBps: m.policy.maxSlippageBps,
    passesSlippageLimit: floor > 0n && q.amountOut >= floor,
    venue: "uniswap_v4_mon_usdc_0.05",
    quoteValidSeconds: QUOTE_VALID_SECONDS,
  };
}

export function limitsView(a: AgentState & { account: Hex }, m: MarketState): LimitsOutput {
  const p = m.policy;
  const px = m.monUsd.priceE18;
  const wmonValue = valueUsdc("WMON", a.wmon, px);
  const nav = a.breaker?.nav ?? a.usdc + wmonValue;
  const grant = a.grant;
  return {
    asOf: asOf(a.block, a.timestamp),
    mode: a.mode,
    accountValueUsdc: usdcOf(nav),
    maxTradeValueUsdc: usdcOf((nav * BigInt(p.maxTradeBps)) / BPS),
    wmonRoomBeforeCapUsdc: usdcOf(positive((nav * BigInt(p.maxAssetBps)) / BPS - wmonValue)),
    usdcAboveFloor: usdcOf(positive(a.usdc - (nav * BigInt(p.minUsdcBps)) / BPS)),
    tradesLeft24h: a.tradesLeft,
    nextSlotFreesAt: a.tradesLeft === 0 && a.nextSlotFreesAt > 0n ? iso(a.nextSlotFreesAt) : null,
    turnoverLeftUsdc: usdcOf(positive((nav * BigInt(p.maxTurnoverBps)) / BPS - a.turnoverUsed)),
    maxSlippageBps: p.maxSlippageBps,
    deadlineSeconds: p.deadlineSeconds,
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
    },
  };
}

/**
 * The intent a trade would carry if it were sent now: the oracle floor as
 * minimum out, a fresh deadline. With no usable price there is no floor; the
 * trade flow would still send a positive minimum, so 1 stands in for it here
 * and only the oracle rule blocks the trade (a zero would read as an invalid
 * intent, which the Executor would never see).
 */
export function tradeNow(sell: AssetId, amountIn: bigint, m: MarketState): ExecutorTrade {
  const floor = floorFor(sell, amountIn, m);
  return {
    tokenIn: sell,
    amountIn,
    minAmountOut: floor > 0n ? floor : 1n,
    deadline: m.timestamp + BigInt(m.policy.deadlineSeconds),
  };
}

export function executorMarketOf(sell: AssetId, a: AgentState, m: MarketState): ExecutorMarket {
  const buy = sell === "USDC";
  return {
    usdc: a.usdc,
    wmon: a.wmon,
    priceE18: m.tradableReason === "OK" ? m.monUsd.priceE18 : 0n,
    oracleReason: m.tradableReason,
    mode: a.mode === "NORMAL" || a.mode === "REDUCE_ONLY" ? a.mode : "PAUSED",
    drawdownBps: a.breaker?.drawdownBps ?? 0n,
    trades: a.trades,
    now: a.timestamp,
    paused: m.paused,
    buyable: m.wmonBuyable,
    venueAllowed: buy ? a.venueAllowed.buy : a.venueAllowed.sell,
  };
}

const CLEARS: Readonly<
  Record<RejectionCode | TradeFlowCode, { clears: Blocker["clears"]; hint: string }>
> = {
  GAS_UNFUNDED: {
    clears: "by_the_owner",
    hint: "Send a little MON to the agent's funding address for gas.",
  },
  ASSET_NOT_ALLOWED: {
    clears: "by_the_platform",
    hint: "The asset is off the buy list; only sales of it are possible.",
  },
  VENUE_NOT_ALLOWED: {
    clears: "by_the_platform",
    hint: "The venue is paused by the platform; nothing to do but wait.",
  },
  TRADE_SIZE_EXCEEDED: {
    clears: "by_changing_the_trade",
    hint: "Propose a smaller amount, within maxTradeValueUsdc from get_limits.",
  },
  CONCENTRATION_CAP: {
    clears: "by_changing_the_trade",
    hint: "Buy less WMON, within wmonRoomBeforeCapUsdc from get_limits.",
  },
  USDC_FLOOR: {
    clears: "by_changing_the_trade",
    hint: "Spend less USDC, within usdcAboveFloor from get_limits.",
  },
  SLIPPAGE_TOO_HIGH: {
    clears: "by_changing_the_trade",
    hint: "A smaller trade moves the pool price less; or wait for deeper liquidity.",
  },
  DAILY_TRADE_LIMIT: {
    clears: "by_waiting",
    hint: "A trade slot frees when the oldest trade leaves the 24-hour window.",
  },
  TURNOVER_CAP: {
    clears: "by_waiting",
    hint: "Trade less now, or wait for earlier trades to leave the 24-hour window.",
  },
  ORACLE_STALE: {
    clears: "by_waiting",
    hint: "The price feed updates often; check again shortly.",
  },
  ORACLE_POOL_DEVIATION: {
    clears: "by_waiting",
    hint: "Wait until the pool price is back within 2% of the oracle price.",
  },
  INSUFFICIENT_BALANCE: {
    clears: "by_changing_the_trade",
    hint: "Sell at most what get_portfolio shows the account holds.",
  },
  REDUCE_ONLY_MODE: {
    clears: "by_the_owner",
    hint: "Only sales into USDC are possible until the owner reviews the drawdown.",
  },
  PAUSED: {
    clears: "by_the_owner",
    hint: "No new trades until the account is unpaused after review.",
  },
  EPOCH_MISMATCH: {
    clears: "by_the_owner",
    hint: "The owner must register the agent's session again for its current owner and configuration.",
  },
  VAULT_IN_HANDOVER: {
    clears: "by_the_owner",
    hint: "The new owner must accept management first.",
  },
  SIMULATION_FAILED: {
    clears: "by_waiting",
    hint: "The venue could not quote this trade; check again later or trade less.",
  },
  DEADLINE_EXPIRED: { clears: "by_changing_the_trade", hint: "Propose the trade again." },
  DEADLINE_TOO_FAR: { clears: "by_changing_the_trade", hint: "Propose the trade again." },
  EXECUTOR_REVERTED: { clears: "by_waiting", hint: "Check the account and try again later." },
  SESSION_UNKNOWN: {
    clears: "by_the_owner",
    hint: "The owner must arm the agent: register its session key for trading.",
  },
  SESSION_EXPIRED: {
    clears: "by_the_owner",
    hint: "The owner must renew the agent's trading permission.",
  },
  ACTION_REPLAYED: { clears: "by_changing_the_trade", hint: "Propose a new trade." },
  INTENT_INVALID: { clears: "by_changing_the_trade", hint: "Propose an amount greater than zero." },
};

export function blocker(
  code: RejectionCode | TradeFlowCode,
  clearsAt: bigint | null = null,
  globalPause = false,
): Blocker {
  const c = CLEARS[code];
  const message =
    code in REJECTION_MESSAGES
      ? REJECTION_MESSAGES[code as RejectionCode]
      : TRADE_FLOW_MESSAGES[code as TradeFlowCode];
  if (code === "PAUSED" && globalPause)
    return {
      code,
      message,
      clears: "by_the_platform",
      clearsAt: null,
      hint: "The platform paused all trading; nothing to do but wait.",
    };
  return {
    code,
    message,
    clears: c.clears,
    clearsAt: clearsAt === null ? null : iso(clearsAt),
    hint: c.hint,
  };
}

/**
 * Every rule that blocks this trade right now (`tradable_now`, and the
 * pre-check of `propose_swap`): the Executor's own rules in its order from
 * packages/policy, the session grant's (which the Executor checks right after
 * the intent's shape), and the venue's quote against the oracle floor.
 */
/** The session grant's rules: the owner's to resolve by arming, so a proposal may wait on them. */
export const SESSION_CODES: readonly RejectionCode[] = [
  "SESSION_UNKNOWN",
  "SESSION_EXPIRED",
  "EPOCH_MISMATCH",
];

export function blockersFor(
  sell: AssetId,
  amountIn: bigint,
  a: AgentState,
  m: MarketState,
  quote: Quote | null,
  sessionKey: Hex | null,
  /** Trade slots other intents of this agent already hold in the rolling window (P2-U6). */
  reservedSlots = 0,
): Blocker[] {
  const market = executorMarketOf(sell, a, m);
  const trade = tradeNow(sell, amountIn, m);
  const executorCodes = executorBlockers(trade, market, m.policy);
  // The Executor checks its pause and the buy list first, then the session, then the rest.
  const first = executorCodes.filter(
    (c) => (c === "PAUSED" && m.paused) || c === "ASSET_NOT_ALLOWED" || c === "INTENT_INVALID",
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
  // Slots held by this agent's waiting and sent intents count as used (P2-U6).
  const used = rollingWindow(market, m.policy).count + reservedSlots;
  if (used >= m.policy.maxTradesPerWindow && !codes.includes("DAILY_TRADE_LIMIT"))
    codes.push("DAILY_TRADE_LIMIT");
  // The venue must be able to fill at least the floor; the oracle checks above cover a bad price.
  const priceOk = market.priceE18 > 0n;
  if (priceOk && amountIn > 0n && !codes.includes("SLIPPAGE_TOO_HIGH")) {
    if (quote === null) {
      if (!codes.includes("VENUE_NOT_ALLOWED")) codes.push("SIMULATION_FAILED");
    } else if (quote.amountOut < trade.minAmountOut) codes.push("SLIPPAGE_TOO_HIGH");
  }
  const window = rollingWindow(market, m.policy);
  return codes.map((c) =>
    blocker(
      c,
      c === "DAILY_TRADE_LIMIT" || c === "TURNOVER_CAP" ? window.oldestLeavesAt : null,
      m.paused && a.mode !== "PAUSED",
    ),
  );
}

export interface TradeAssessment {
  readonly m: MarketState;
  readonly a: AgentState;
  readonly quote: Quote | null;
  readonly blockers: Blocker[];
}

/**
 * Every pre-check for one trade from fresh reads: what propose_swap and
 * tradable_now answer, and what the trade flow re-runs at submission (P2-U6).
 * Null when the agent has no account.
 */
export async function assessTrade(
  reader: ChainReader,
  agentId: number,
  sell: AssetId,
  amountIn: bigint,
  sessionKey: Hex | null,
  reservedSlots = 0,
): Promise<TradeAssessment | null> {
  const [m, a, quote] = await Promise.all([
    reader.market(),
    reader.agent(agentId),
    reader.quote(sell, amountIn).catch(() => null),
  ]);
  if (!a?.account) return null;
  return { m, a, quote, blockers: blockersFor(sell, amountIn, a, m, quote, sessionKey, reservedSlots) };
}

/**
 * Splits blockers into those that reject a proposal and those that only make
 * it wait for the owner: the session grant's, which arming resolves (P2-U6).
 */
export function proposalVerdict(blockers: readonly Blocker[]): {
  readonly status: "awaiting_approval" | "rejected";
  readonly rejecting: readonly Blocker[];
} {
  const rejecting = blockers.filter((b) => !SESSION_CODES.includes(b.code as RejectionCode));
  return { status: rejecting.length === 0 ? "awaiting_approval" : "rejected", rejecting };
}

/** Parses an amount in token units; refuses more decimals than the token has. */
export function parseTokenAmount(text: string, asset: AssetId): bigint {
  const decimals = ASSET_DECIMALS[asset];
  const [whole = "0", frac = ""] = text.split(".");
  if (frac.length > decimals)
    throw new ToolError(
      "INVALID_INPUT",
      `${asset} has ${decimals} decimals; the amount has more.`,
      false,
    );
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}
