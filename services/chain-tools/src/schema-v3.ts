import { ACCOUNT_MODES, REJECTION_CODES, TRADE_FLOW_CODES } from "@alpha-agents/domain";
import { LANES, POOL_STATUSES, PRICE_REASONS, TOKEN_STATUSES } from "@alpha-agents/policy";
import { z } from "zod";
import { Blocker } from "./schema.ts";

/**
 * The chain tools' schemas for the fund agent's v3 set (F-U5): any registered
 * token, named by its symbol or its address, amounts in token units, and
 * routes of up to three registered pools in every answer that trades. As on
 * v2 the inputs are strict and never carry an address of an agent, an
 * account or a recipient: whose account a call reads or proposes for comes
 * only from the injected token. `sell` and `buy` name what is traded, never
 * who trades.
 */

/** A registered token: its symbol (as list_tokens shows it) or its address. */
export const tokenRef = z
  .string()
  .regex(/^(0x[0-9a-fA-F]{40}|[A-Za-z0-9.$_-]{1,16})$/, "a token's symbol, or its 0x address")
  .describe("A registered token: its symbol as list_tokens shows it, or its address");
const tokenAmount = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "a positive decimal number in token units, like 5 or 0.25")
  .describe("An amount in token units of the token sold, like 5 or 0.25");

export const TradeInputV3 = z
  .strictObject({ sell: tokenRef, buy: tokenRef, amount: tokenAmount })
  .refine((i) => i.sell.toLowerCase() !== i.buy.toLowerCase(), {
    path: ["buy"],
    message: "must differ from sell",
  });
export type TradeInputV3 = z.infer<typeof TradeInputV3>;

export const ProposeSwapInputV3 = z
  .strictObject({
    sell: tokenRef,
    buy: tokenRef,
    amount: tokenAmount,
    reason: z
      .string()
      .trim()
      .min(1)
      .max(280)
      .describe("Why you propose this trade, in one or two plain sentences; shown to the owner."),
    clientRequestId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional()
      .describe("Your own ID for this proposal; the same ID in this run returns the same intent."),
  })
  .refine((i) => i.sell.toLowerCase() !== i.buy.toLowerCase(), {
    path: ["buy"],
    message: "must differ from sell",
  });
export type ProposeSwapInputV3 = z.infer<typeof ProposeSwapInputV3>;

const AsOf = z.strictObject({ block: z.string(), timestamp: z.string() });
const Usdc = z.strictObject({ amount: z.string(), amountRaw: z.string() });
const TokenAmount = z.strictObject({
  token: z.string(),
  tokenAddress: z.string(),
  amount: z.string(),
  amountRaw: z.string(),
});
const reasonCode = z.enum([...REJECTION_CODES, ...TRADE_FLOW_CODES]);
const tokenClass = z.enum(["USDC", "F", "A", "NONE"]);
const lane = z.enum(LANES);
const tokenStatus = z.enum(TOKEN_STATUSES);
const priceSource = z.enum(["usdc", "chainlink", "attestation"]);

export const PortfolioOutputV3 = z.strictObject({
  asOf: AsOf,
  account: z.string(),
  holdings: z.array(
    z.strictObject({
      token: z.string(),
      tokenAddress: z.string(),
      /** USDC itself, F (priced by its own feed) or A (priced by a platform attestation). */
      class: tokenClass,
      lane,
      status: tokenStatus,
      amount: z.string(),
      amountRaw: z.string(),
      /** What is not reserved by a swap in progress. */
      free: z.string(),
      /** Null while the token has no usable price (a stale feed, or an attestation older than a day). */
      priceUsdc: z.string().nullable(),
      priceSource,
      valueUsdc: z.string().nullable(),
      /** The USDC paid for what is held (null for USDC itself). */
      costBasisUsdc: z.string().nullable(),
      shareBps: z.number().int().nullable(),
    }),
  ),
  heldCount: z.number().int(),
  maxHeld: z.number().int(),
  /** Null while any held class F feed is unusable: the account's views revert then, and so would a trade. */
  totalValueUsdc: Usdc.nullable(),
  /** The value the caps use: class A at the lower of its cost basis and its value. */
  cappedValueUsdc: Usdc.nullable(),
  costBasisUsdc: Usdc.nullable(),
  classACostBasisUsdc: Usdc.nullable(),
  valuesUsable: z.boolean(),
  mode: z.enum(ACCOUNT_MODES),
  screenedOptIn: z.boolean(),
  breaker: z.strictObject({
    drawdownBps: z.number().int().nullable(),
    state: z.enum(["NORMAL", "REDUCE_ONLY", "PAUSED", "UNKNOWN"]),
    valuePerUnit: z.string().nullable(),
    peakValuePerUnit7d: z.string().nullable(),
  }),
});
export type PortfolioOutputV3 = z.infer<typeof PortfolioOutputV3>;

export const PricesOutputV3 = z.strictObject({
  asOf: AsOf,
  tokens: z.array(
    z.strictObject({
      token: z.string(),
      tokenAddress: z.string(),
      class: tokenClass,
      lane,
      status: tokenStatus,
      source: priceSource,
      price: z.string().nullable(),
      priceE18: z.string().nullable(),
      updatedAt: z.string().nullable(),
      ageSeconds: z.number().int().nullable(),
      /** The oracle's own reason, or for a class A token whether an attestor exists yet. */
      feedStatus: z.enum([...PRICE_REASONS, "ATTESTOR_UNAVAILABLE"]),
      tradable: z.boolean(),
      blockedBy: reasonCode.nullable(),
    }),
  ),
  pools: z.array(
    z.strictObject({
      poolId: z.string(),
      venue: z.enum(["uniswap_v3", "pancakeswap_v3", "uniswap_v4"]),
      pair: z.string(),
      feeBps: z.number().int(),
      lane,
      status: z.enum(POOL_STATUSES),
      codeIntact: z.boolean(),
      /** How far the pool's spot sits from the oracle, when both are readable. */
      deviationBps: z.number().int().nullable(),
      priceStatus: z.enum(PRICE_REASONS),
    }),
  ),
});
export type PricesOutputV3 = z.infer<typeof PricesOutputV3>;

export const RouteHopOutput = z.strictObject({
  poolId: z.string(),
  venue: z.enum(["uniswap_v3", "pancakeswap_v3", "uniswap_v4"]),
  feeBps: z.number().int(),
  lane,
  sell: TokenAmount,
  buy: TokenAmount,
});
export type RouteHopOutput = z.infer<typeof RouteHopOutput>;

export const QuoteOutputV3 = z.strictObject({
  asOf: AsOf,
  sell: TokenAmount,
  expectedOut: TokenAmount,
  oracleImpliedOut: TokenAmount,
  minimumOutAllowed: TokenAmount,
  slippageBps: z.number().int(),
  maxSlippageBps: z.number().int(),
  passesSlippageLimit: z.boolean(),
  /** The best route by the venues' quotes: one to three registered pools, in order. */
  route: z.array(RouteHopOutput).min(1).max(3),
  hops: z.number().int(),
  routeFeeBps: z.number().int(),
  routesConsidered: z.number().int(),
  quoteValidSeconds: z.number().int(),
});
export type QuoteOutputV3 = z.infer<typeof QuoteOutputV3>;

export const LimitsOutputV3 = z.strictObject({
  asOf: AsOf,
  mode: z.enum(ACCOUNT_MODES),
  screenedOptIn: z.boolean(),
  accountValueUsdc: Usdc.nullable(),
  cappedValueUsdc: Usdc.nullable(),
  maxTradeValueUsdc: Usdc.nullable(),
  usdcAboveFloor: Usdc.nullable(),
  tradesLeft24h: z.number().int(),
  nextSlotFreesAt: z.string().nullable(),
  turnoverLeftUsdc: Usdc.nullable(),
  maxSlippageBps: z.number().int(),
  maxSlippageClassABps: z.number().int(),
  deadlineSeconds: z.number().int(),
  classA: z.strictObject({
    positionCapBps: z.number().int(),
    totalCapBps: z.number().int(),
    costBasisUsdc: Usdc.nullable(),
    roomBeforeTotalCapUsdc: Usdc.nullable(),
    /** False until the platform's price attestor is live (F-U12): no class A token trades before. */
    attestorAvailable: z.boolean(),
  }),
  perToken: z.array(
    z.strictObject({
      token: z.string(),
      tokenAddress: z.string(),
      class: z.enum(["F", "A", "NONE"]),
      lane,
      status: tokenStatus,
      held: z.boolean(),
      /** The lower of the policy's cap and the registry's cap on this token. */
      capBps: z.number().int(),
      /** Class F by value, class A by cost basis; null while the account's values are unusable. */
      roomBeforeCapUsdc: Usdc.nullable(),
      /** Whether this account may buy it now: buyable, and core or opted in. */
      buyable: z.boolean(),
    }),
  ),
  sessionGrant: z.strictObject({
    registered: z.boolean(),
    validUntil: z.string().nullable(),
    expired: z.boolean(),
  }),
  limits: z.strictObject({
    maxTradeBps: z.number().int(),
    maxAssetBps: z.number().int(),
    minUsdcBps: z.number().int(),
    maxTurnoverBps: z.number().int(),
    maxTradesPerWindow: z.number().int(),
    windowSeconds: z.number().int(),
    maxClassAPositionBps: z.number().int(),
    maxClassATotalBps: z.number().int(),
  }),
});
export type LimitsOutputV3 = z.infer<typeof LimitsOutputV3>;

export const TradableOutputV3 = z.strictObject({
  asOf: AsOf,
  sell: TokenAmount,
  buy: z.strictObject({ token: z.string(), tokenAddress: z.string() }),
  tradable: z.boolean(),
  /** The route the trade would take, when one exists and could be quoted. */
  route: z.array(RouteHopOutput).max(3).nullable(),
  blockers: z.array(Blocker),
});
export type TradableOutputV3 = z.infer<typeof TradableOutputV3>;

export const IntentOutputV3 = z.strictObject({
  intentId: z.string(),
  status: z.enum([
    "awaiting_approval",
    "approved",
    "submitted",
    "confirmed",
    "reconciled",
    "rejected",
    "expired",
    "failed",
    "cancelled",
  ]),
  sell: TokenAmount,
  buy: z.strictObject({ token: z.string(), tokenAddress: z.string() }),
  route: z.array(z.string()).max(3).nullable(),
  reason: z.string(),
  reasonCodes: z.array(reasonCode),
  blockers: z.array(Blocker),
  createdAt: z.string(),
  expiresAt: z.string(),
  txHash: z.string().nullable(),
  duplicate: z.boolean(),
});
export type IntentOutputV3 = z.infer<typeof IntentOutputV3>;

export const CHAIN_TOOL_INPUTS_V3 = {
  get_portfolio: z.strictObject({}),
  get_prices: z.strictObject({}),
  get_quote: TradeInputV3,
  get_limits: z.strictObject({}),
  tradable_now: TradeInputV3,
  propose_swap: ProposeSwapInputV3,
} as const;
