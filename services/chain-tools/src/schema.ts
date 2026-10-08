import {
  ACCOUNT_MODES,
  ASSET_IDS,
  INTENT_STATES,
  type IntentState,
  REJECTION_CODES,
  TRADE_FLOW_CODES,
} from "@alpha-agents/domain";
import { z } from "zod";

/**
 * The chain tools' schemas (FINAL_PLAN 4.4.2, P2-U5). Inputs are strict, name
 * assets from the enum and amounts in token units, and never carry an address,
 * an agent, calldata or a recipient: whose account a call reads or proposes for
 * comes only from the injected token. Outputs carry every amount as a decimal
 * string with the raw integer beside it, and every read its block.
 */

const asset = z.enum(ASSET_IDS).describe("USDC or WMON");
const tokenAmount = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "a positive decimal number in token units, like 5 or 0.25")
  .describe("An amount in token units, like 5 or 0.25");

export const EmptyInput = z.strictObject({});

export const TradeInput = z
  .strictObject({ sell: asset, buy: asset, amount: tokenAmount })
  .refine((i) => i.sell !== i.buy, { path: ["buy"], message: "must differ from sell" });
export type TradeInput = z.infer<typeof TradeInput>;

export const ProposeSwapInput = z
  .strictObject({
    sell: asset,
    buy: asset,
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
  .refine((i) => i.sell !== i.buy, { path: ["buy"], message: "must differ from sell" });
export type ProposeSwapInput = z.infer<typeof ProposeSwapInput>;

export const IntentStatusInput = z.strictObject({
  intentId: z.string().regex(/^intent-[0-9a-f-]{36}$/),
});

const AsOf = z.strictObject({ block: z.string(), timestamp: z.string() });
const Amount = z.strictObject({ asset, amount: z.string(), amountRaw: z.string() });
const Usdc = z.strictObject({ amount: z.string(), amountRaw: z.string() });
/** The Executor's reasons and the trade flow's own (P2-U6: GAS_UNFUNDED). */
const reasonCode = z.enum([...REJECTION_CODES, ...TRADE_FLOW_CODES]);

export const PortfolioOutput = z.strictObject({
  asOf: AsOf,
  account: z.string(),
  holdings: z.array(
    z.strictObject({
      asset,
      amount: z.string(),
      amountRaw: z.string(),
      valueUsdc: z.string(),
      shareBps: z.number().int(),
    }),
  ),
  totalValueUsdc: Usdc,
  mode: z.enum(ACCOUNT_MODES),
  breaker: z.strictObject({
    /** Null while the price it needs is unusable. */
    drawdownBps: z.number().int().nullable(),
    /** What a drawdown of this size sets: the breaker trips reduce-only at 10% and pauses at 20%. */
    state: z.enum(["NORMAL", "REDUCE_ONLY", "PAUSED", "UNKNOWN"]),
    valuePerUnit: z.string().nullable(),
    peakValuePerUnit7d: z.string(),
  }),
  priceUsedUsdcPerWmon: z.string(),
});
export type PortfolioOutput = z.infer<typeof PortfolioOutput>;

const FeedPrice = z.strictObject({
  price: z.string(),
  priceE18: z.string(),
  updatedAt: z.string(),
  ageSeconds: z.number().int(),
  status: z.string(),
});

export const PricesOutput = z.strictObject({
  asOf: AsOf,
  monUsd: FeedPrice,
  usdcUsd: FeedPrice,
  pool: z.strictObject({ price: z.string(), priceE18: z.string(), status: z.string() }),
  poolDeviationBps: z.number().int(),
  tradable: z.boolean(),
  blockedBy: reasonCode.nullable(),
});
export type PricesOutput = z.infer<typeof PricesOutput>;

export const QuoteOutput = z.strictObject({
  asOf: AsOf,
  sell: Amount,
  expectedOut: Amount,
  oracleImpliedOut: Amount,
  minimumOutAllowed: Amount,
  slippageBps: z.number().int(),
  maxSlippageBps: z.number().int(),
  passesSlippageLimit: z.boolean(),
  venue: z.literal("uniswap_v4_mon_usdc_0.05"),
  quoteValidSeconds: z.number().int(),
});
export type QuoteOutput = z.infer<typeof QuoteOutput>;

export const LimitsOutput = z.strictObject({
  asOf: AsOf,
  mode: z.enum(ACCOUNT_MODES),
  accountValueUsdc: Usdc,
  maxTradeValueUsdc: Usdc,
  wmonRoomBeforeCapUsdc: Usdc,
  usdcAboveFloor: Usdc,
  tradesLeft24h: z.number().int(),
  nextSlotFreesAt: z.string().nullable(),
  turnoverLeftUsdc: Usdc,
  maxSlippageBps: z.number().int(),
  deadlineSeconds: z.number().int(),
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
  }),
});
export type LimitsOutput = z.infer<typeof LimitsOutput>;

export const BLOCKER_CLEARS = [
  "by_waiting",
  "by_changing_the_trade",
  "by_the_owner",
  "by_the_platform",
] as const;

export const Blocker = z.strictObject({
  code: reasonCode,
  message: z.string(),
  clears: z.enum(BLOCKER_CLEARS),
  /** When it clears by waiting, if the chain says when (the rolling window). */
  clearsAt: z.string().nullable(),
  hint: z.string(),
});
export type Blocker = z.infer<typeof Blocker>;

export const TradableOutput = z.strictObject({
  asOf: AsOf,
  sell: Amount,
  buy: asset,
  tradable: z.boolean(),
  blockers: z.array(Blocker),
});
export type TradableOutput = z.infer<typeof TradableOutput>;

/** The intent states, from packages/domain (one list for the server, the store and the UI). */
export const INTENT_STATUSES = INTENT_STATES;
export type IntentStatus = IntentState;

export const IntentOutput = z.strictObject({
  intentId: z.string(),
  status: z.enum(INTENT_STATUSES),
  sell: Amount,
  buy: asset,
  reason: z.string(),
  reasonCodes: z.array(reasonCode),
  blockers: z.array(Blocker),
  createdAt: z.string(),
  expiresAt: z.string(),
  /** Display only; set once the trade flow sends it (P2-U6). */
  txHash: z.string().nullable(),
  duplicate: z.boolean(),
});
export type IntentOutput = z.infer<typeof IntentOutput>;

/** Every input schema the server registers, for the identity field lint. */
export const CHAIN_TOOL_INPUTS = {
  get_portfolio: EmptyInput,
  get_prices: EmptyInput,
  get_quote: TradeInput,
  get_limits: EmptyInput,
  tradable_now: TradeInput,
  propose_swap: ProposeSwapInput,
  get_intent_status: IntentStatusInput,
} as const;
export type ChainTool = keyof typeof CHAIN_TOOL_INPUTS;
export const CHAIN_TOOLS = Object.keys(CHAIN_TOOL_INPUTS) as ChainTool[];
