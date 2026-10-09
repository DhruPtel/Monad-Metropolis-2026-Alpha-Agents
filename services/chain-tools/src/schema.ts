import {
  ACCOUNT_MODES,
  ASSET_IDS,
  INTENT_STATES,
  type IntentState,
  REJECTION_CODES,
  TRADE_FLOW_CODES,
} from "@alpha-agents/domain";
import { READ_FUNCTIONS, READ_FUNCTION_NAMES, type ReadFunction } from "@alpha-agents/market";
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
/**
 * `get_pool_depth` (P3-U2, D-097): the launch venue's price impact at
 * reference sizes, read from Monad mainnet (D-289), each figure with its
 * source, time and warnings.
 */
const DepthFigure = z.strictObject({
  value: z.number().nullable(),
  source: z.enum(["coinmarketcap", "defillama", "chainlink", "uniswap_v4", "computed"]),
  asOf: z.string(),
  warnings: z
    .array(
      z.strictObject({
        code: z.enum([
          "REFUSED_OUT_OF_RANGE",
          "MISSING",
          "STALE",
          "SOURCES_DISAGREE",
          "THIN_HISTORY",
        ]),
        message: z.string().max(300),
      }),
    )
    .max(5),
});
export const PoolDepthOutput = z.strictObject({
  chain: z.literal("monad-mainnet"),
  venue: z.string(),
  block: z.string(),
  asOf: z.string(),
  cacheHit: z.boolean(),
  midPriceUsd: DepthFigure,
  activeLiquidity: DepthFigure,
  feeBps: z.number(),
  rows: z
    .array(
      z.strictObject({
        sizeUsd: z.number(),
        side: z.enum(["buy_mon", "sell_mon"]),
        impactBps: DepthFigure,
        impactExFeeBps: DepthFigure,
      }),
    )
    .max(10),
  note: z.string(),
});
export type PoolDepthOutput = z.infer<typeof PoolDepthOutput>;

/**
 * Contract lookups on Monad mainnet (P3-U9, A-24): any `target`, a curated set
 * of read-only calls, typed outputs only. `target` names what is read, never
 * whose account a call acts for (FINAL_PLAN 4.4.1).
 */
const target = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "a 0x-prefixed 20-byte address")
  .describe("The contract or account to read on Monad mainnet");

export const ReadContractInput = z
  .strictObject({
    target,
    function: z
      .enum(READ_FUNCTION_NAMES as [ReadFunction, ...ReadFunction[]])
      .describe(READ_FUNCTION_NAMES.map((f) => `${f}: ${READ_FUNCTIONS[f].about}`).join("; ")),
    holder: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional()
      .describe("For erc20_balance_of only: whose balance to read"),
    poolId: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional()
      .describe("For the uniswap_v4_* calls only: the pool's 32-byte ID"),
  })
  .superRefine((i, ctx) => {
    const needs = READ_FUNCTIONS[i.function].args as readonly string[];
    for (const arg of ["holder", "poolId"] as const) {
      if (needs.includes(arg) && i[arg] === undefined)
        ctx.addIssue({ code: "custom", path: [arg], message: `${i.function} needs ${arg}` });
      if (!needs.includes(arg) && i[arg] !== undefined)
        ctx.addIssue({ code: "custom", path: [arg], message: `${i.function} takes no ${arg}` });
    }
  });

export const BalanceInput = z.strictObject({
  target,
  asset: z.enum(["USDC", "WMON", "NATIVE"]).describe("USDC, WMON, or NATIVE for MON itself"),
});

export const GetCodeInput = z.strictObject({ target });

const LookupAsOf = z.strictObject({ block: z.string(), timestamp: z.string() });
const TypedValue = z.union([
  z.strictObject({ type: z.enum(["uint", "int"]), value: z.string().regex(/^-?\d+$/) }),
  z.strictObject({
    type: z.literal("address"),
    value: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .nullable(),
  }),
  z.strictObject({ type: z.literal("bool"), value: z.boolean() }),
  z.strictObject({ type: z.literal("bytes32"), value: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
  z.strictObject({
    type: z.enum(["string", "bytes"]),
    length: z.int().min(0),
    keccak256: z.string().regex(/^0x[0-9a-f]{64}$/),
  }),
]);

export const ReadContractOutput = z.strictObject({
  chain: z.literal("monad-mainnet"),
  function: z.enum(READ_FUNCTION_NAMES as [ReadFunction, ...ReadFunction[]]),
  target: z.string(),
  outputs: z.record(z.string().max(32), TypedValue),
  asOf: LookupAsOf,
  cacheHit: z.boolean(),
  note: z.string(),
});

export const BalanceOutput = z.strictObject({
  chain: z.literal("monad-mainnet"),
  target: z.string(),
  asset: z.enum(["USDC", "WMON", "NATIVE"]),
  amount: z.string(),
  amountRaw: z.string(),
  decimals: z.int(),
  asOf: LookupAsOf,
  cacheHit: z.boolean(),
});

export const GetCodeOutput = z.strictObject({
  chain: z.literal("monad-mainnet"),
  target: z.string(),
  hasCode: z.boolean(),
  sizeBytes: z.int().min(0),
  codeHash: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/)
    .nullable(),
  proxy: z.strictObject({
    pattern: z.enum([
      "none",
      "eip1967",
      "eip1967_beacon",
      "zeppelinos",
      "eip1167_minimal_proxy",
      "eip7702_delegation",
    ]),
    implementation: z.string().nullable(),
  }),
  note: z.string(),
  asOf: LookupAsOf,
  cacheHit: z.boolean(),
});

export const CHAIN_TOOL_INPUTS = {
  get_portfolio: EmptyInput,
  get_prices: EmptyInput,
  get_quote: TradeInput,
  get_limits: EmptyInput,
  tradable_now: TradeInput,
  propose_swap: ProposeSwapInput,
  get_intent_status: IntentStatusInput,
  get_pool_depth: EmptyInput,
  read_contract: ReadContractInput,
  balance: BalanceInput,
  get_code: GetCodeInput,
} as const;
export type ChainTool = keyof typeof CHAIN_TOOL_INPUTS;
export const CHAIN_TOOLS = Object.keys(CHAIN_TOOL_INPUTS) as ChainTool[];
