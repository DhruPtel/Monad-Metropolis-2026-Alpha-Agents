import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AgentIdentity, ToolError } from "@alpha-agents/tool-server";
import { type Hex, isAddressEqual } from "viem";
import { proposalVerdict } from "./logic.ts";
import {
  amountOfToken,
  asOfV3,
  assessTradeV3,
  floorForV3,
  impliedOutV3,
  limitsViewV3,
  parseTokenAmountV3,
  portfolioViewV3,
  pricesViewV3,
  quoteViewV3,
  requireAccountV3,
  resolveToken,
  routeHopsOutput,
  routeTokensOf,
} from "./logic-v3.ts";
import type { ChainReaderV3, MarketStateV3, RouteQuoteV3, TokenInfoV3 } from "./reader-v3.ts";
import {
  IntentOutputV3,
  LimitsOutputV3,
  PortfolioOutputV3,
  PricesOutputV3,
  ProposeSwapInputV3,
  QuoteOutputV3,
  TradableOutputV3,
  TradeInputV3,
} from "./schema-v3.ts";
import { EmptyInput, IntentStatusInput } from "./schema.ts";
import {
  type ChainToolsOptions,
  INTENT_TTL_SECONDS,
  type IntentDraft,
  type IntentRecord,
  MAX_OPEN_INTENTS,
  type ToolRunner,
} from "./server.ts";

/**
 * The chain tools for the fund agent's v3 set (F-U5): the agent reads its
 * whole portfolio and the market for every registered token, asks for a
 * quote along the best route of up to three registered pools, learns every
 * rule that blocks a trade, and proposes a swap for any registered pair.
 * Identity comes only from the injected token, as on v2; a proposal is a
 * typed intent with its route, never calldata. Class A tokens are refused
 * by name (ATTESTOR_UNAVAILABLE) until the price attestor exists (F-U12).
 */

const NOT_DEPLOYED =
  "The fund agent's contracts are not deployed on this chain yet, so there is nothing to read.";

function upstream(err: unknown): never {
  if (err instanceof ToolError) throw err;
  throw new ToolError(
    "UPSTREAM_UNAVAILABLE",
    "The chain could not be read; try again shortly.",
    true,
  );
}

/** A v3 intent's answer: the token sold with its decimals (kept in the checks), the token bought, the route. */
export function intentOutputV3(r: IntentRecord, duplicate: boolean): IntentOutputV3 {
  const checks = r.checks as { sellDecimals?: unknown; buyDecimals?: unknown };
  const sellDecimals = typeof checks.sellDecimals === "number" ? checks.sellDecimals : 18;
  return {
    intentId: r.intentId,
    status: r.status,
    sell: amountOfToken(
      { symbol: r.sell, token: r.sellToken ?? ("0x" as Hex), decimals: sellDecimals },
      r.amountIn,
    ),
    buy: { token: r.buy, tokenAddress: r.buyToken ?? "0x" },
    route: r.route ? [...r.route] : null,
    reason: r.reason,
    reasonCodes: [...r.reasonCodes],
    blockers: [...r.blockers],
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    txHash: r.txHash,
    duplicate,
  };
}

/** What the pre-checks read, stored with the intent so its verdict can be explained later. */
function checksOfV3(
  m: MarketStateV3,
  sell: TokenInfoV3,
  buy: TokenInfoV3,
  amountIn: bigint,
  a: { readonly block: bigint; readonly timestamp: bigint; readonly mode: string },
  quote: RouteQuoteV3 | null,
): Record<string, unknown> {
  const px = (t: TokenInfoV3) =>
    isAddressEqual(t.token, m.usdc)
      ? (10n ** 18n).toString()
      : (m.prices[t.token.toLowerCase()]?.priceE18 ?? 0n).toString();
  return {
    block: a.block.toString(),
    timestamp: a.timestamp.toString(),
    chainId: m.chainId,
    custody: "v3",
    sellDecimals: sell.decimals,
    buyDecimals: buy.decimals,
    priceInE18: px(sell),
    priceOutE18: px(buy),
    mode: a.mode,
    oracleImpliedOut: impliedOutV3(m, sell, buy, amountIn).toString(),
    minimumOut: floorForV3(m, sell, buy, amountIn).toString(),
    expectedOut: quote?.amountOut.toString() ?? null,
    route: quote ? quote.route.map((p) => p.poolId) : null,
    routeTokens: quote ? routeTokensOf(quote, sell.token) : null,
    hops: quote?.route.length ?? null,
    policyHash: m.policyHash,
  };
}

export function registerChainToolsV3(
  mcp: McpServer,
  identity: AgentIdentity,
  o: Omit<ChainToolsOptions, "resolve" | "port"> & { readonly readerV3: ChainReaderV3 },
  tool: ToolRunner,
): void {
  const reader = o.readerV3;
  const now = () => o.now?.() ?? new Date();
  const read = async <T>(fn: (r: ChainReaderV3) => Promise<T>): Promise<T> => {
    try {
      return await fn(reader);
    } catch (err) {
      return upstream(err);
    }
  };
  const marketAndAgent = () =>
    read(async (r) => {
      const [m, a] = await Promise.all([r.market(), r.agent(identity.agentId)]);
      return { m, a };
    });
  const sessionKey = async () => (o.sessionKeyOf ? o.sessionKeyOf(identity.agentId) : null);

  mcp.registerTool(
    "get_portfolio",
    {
      description:
        "Your fund account: every token held with its class (USDC, F priced by its own feed, A priced by an attestation), amount, price and value where priced, the USDC paid for it (its cost basis) and its share of the total; the account's value, the value the caps use, the mode, whether screened tokens are opted in, and the circuit breaker's drawdown.",
      inputSchema: EmptyInput,
      outputSchema: PortfolioOutputV3,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      tool("get_portfolio", input, async () => {
        const { m, a } = await marketAndAgent();
        const out = portfolioViewV3(requireAccountV3(a), m);
        return {
          output: out,
          summary: {
            block: out.asOf.block,
            held: out.holdings.map((h) => `${h.amount} ${h.token}`),
            totalValueUsdc: out.totalValueUsdc?.amount ?? null,
            mode: out.mode,
            drawdownBps: out.breaker.drawdownBps,
          },
        };
      }),
  );

  mcp.registerTool(
    "get_prices",
    {
      description:
        "Every registered token's price: USDC at 1, a class F token from its Chainlink feed with the feed's age and status, a class A token from a platform attestation (none until the attestor is live), and whether each can trade on its price now; plus every registered pool with its venue, fee, lane, status and distance from the oracle.",
      inputSchema: EmptyInput,
      outputSchema: PricesOutputV3,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      tool("get_prices", input, async () => {
        const m = await read((r) => r.market());
        const out = pricesViewV3(m);
        return {
          output: out,
          summary: {
            block: out.asOf.block,
            tradable: out.tokens.filter((t) => t.tradable).map((t) => t.token),
            pools: out.pools.length,
          },
        };
      }),
  );

  mcp.registerTool(
    "get_quote",
    {
      description:
        "What selling an amount of one registered token for another would return now along the best route of up to three registered pools (Uniswap v3, PancakeSwap v3, Uniswap v4), compared with the oracle price, and whether it is inside the slippage limit. Name tokens by symbol or address. Indicative: it reserves nothing.",
      inputSchema: TradeInputV3,
      outputSchema: QuoteOutputV3,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      tool("get_quote", input, async () => {
        const { m, a } = await marketAndAgent();
        const sell = resolveToken(m, input.sell);
        const buy = resolveToken(m, input.buy);
        if (isAddressEqual(sell.token, buy.token))
          throw new ToolError("INVALID_INPUT", "sell and buy name the same token.", false);
        const amountIn = parseTokenAmountV3(input.amount, sell);
        if (amountIn === 0n)
          throw new ToolError("INVALID_INPUT", "The amount must be above zero.", false);
        const optedIn = a?.screenedOptIn ?? false;
        const q = await read((r) =>
          r.bestRoute(sell.token, buy.token, amountIn, {
            optedIn,
            intoUsdc: isAddressEqual(buy.token, m.usdc),
            sellsScreened: sell.lane === "SCREENED",
          }),
        );
        if (!q)
          throw new ToolError(
            "UPSTREAM_UNAVAILABLE",
            `No registered route of up to three pools could be quoted from ${sell.symbol} to ${buy.symbol} now.`,
            true,
          );
        const out = quoteViewV3(m, sell, buy, amountIn, q);
        return {
          output: out,
          summary: {
            expectedOut: `${out.expectedOut.amount} ${out.expectedOut.token}`,
            hops: out.hops,
            slippageBps: out.slippageBps,
          },
        };
      }),
  );

  mcp.registerTool(
    "get_limits",
    {
      description:
        "What your limits leave room for now, read from Executor v3 and your account: the largest trade, USDC above the floor, trades and turnover left in the rolling 24 hours, the room before each token's cap (class F by value, class A by what was paid), the class A caps, and when your trading permission expires.",
      inputSchema: EmptyInput,
      outputSchema: LimitsOutputV3,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      tool("get_limits", input, async () => {
        const { m, a } = await marketAndAgent();
        const out = limitsViewV3(requireAccountV3(a), m);
        return {
          output: out,
          summary: {
            tradesLeft24h: out.tradesLeft24h,
            maxTradeValueUsdc: out.maxTradeValueUsdc?.amount ?? null,
          },
        };
      }),
  );

  const assess = async (sellRef: string, buyRef: string, amountText: string) => {
    const [key, reserved] = await Promise.all([sessionKey(), o.intents.reservedSlots(identity)]);
    // The amount is parsed against the token sold, so the token is resolved first.
    const m = await read((r) => r.market());
    const sell = resolveToken(m, sellRef);
    const buy = resolveToken(m, buyRef);
    if (isAddressEqual(sell.token, buy.token))
      throw new ToolError("INVALID_INPUT", "sell and buy name the same token.", false);
    const amountIn = parseTokenAmountV3(amountText, sell);
    const assessed = await read((r) =>
      assessTradeV3(r, identity.agentId, sell.token, buy.token, amountIn, key, reserved),
    );
    if (!assessed) requireAccountV3(await read((r) => r.agent(identity.agentId)));
    if (!assessed) throw new ToolError("ACCOUNT_NOT_AVAILABLE", NOT_DEPLOYED, false);
    return { ...assessed, amountIn };
  };

  mcp.registerTool(
    "tradable_now",
    {
      description:
        "Whether a swap of these two tokens and this size could go through right now. If not, every rule that blocks it, the owner-facing reason, and whether it clears by waiting (and when), by changing the trade, or only by the owner or the platform. Shows the route it would take.",
      inputSchema: TradeInputV3,
      outputSchema: TradableOutputV3,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      tool("tradable_now", input, async () => {
        const { m, a, sell, buy, quote, blockers, amountIn } = await assess(
          input.sell,
          input.buy,
          input.amount,
        );
        const out: TradableOutputV3 = {
          asOf: asOfV3(a.block, a.timestamp),
          sell: amountOfToken(sell, amountIn),
          buy: { token: buy.symbol, tokenAddress: buy.token },
          tradable: blockers.length === 0,
          route: quote ? routeHopsOutput(quote, m) : null,
          blockers,
        };
        return {
          output: out,
          summary: { tradable: out.tradable, codes: blockers.map((b) => b.code) },
        };
      }),
  );

  mcp.registerTool(
    "propose_swap",
    {
      description:
        "Propose a swap of any registered pair from your fund account. It is checked against every limit at once along the best route: if it passes it waits for the owner's approval and is never sent before; if not, you get every reason code. Returns an intent ID, never a transaction.",
      inputSchema: ProposeSwapInputV3,
      outputSchema: IntentOutputV3,
      annotations: { idempotentHint: true },
    },
    async (input) =>
      tool("propose_swap", input, async () => {
        const { m, a, sell, buy, quote, blockers, amountIn } = await assess(
          input.sell,
          input.buy,
          input.amount,
        );
        // Only the session grant missing makes a passing trade wait for the owner to arm (P2-U6).
        const verdict = proposalVerdict(blockers);
        const codes = verdict.rejecting.map((b) => b.code);
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify([
              sell.token.toLowerCase(),
              buy.token.toLowerCase(),
              amountIn.toString(),
            ]),
          )
          .digest("hex")
          .slice(0, 32);
        const draft: IntentDraft = {
          idempotencyKey: `${identity.leaseId}:${input.clientRequestId ?? fingerprint}`,
          account: a.account,
          custody: "v3",
          sell: sell.symbol,
          buy: buy.symbol,
          sellToken: sell.token,
          buyToken: buy.token,
          route: quote ? quote.route.map((p) => p.poolId) : null,
          amountIn,
          reason: input.reason,
          clientRequestId: input.clientRequestId ?? null,
          status: verdict.status,
          reasonCodes: codes,
          blockers,
          checks: checksOfV3(m, sell, buy, amountIn, a, quote),
          ownerEpoch: a.ownerEpoch,
          configEpoch: a.configEpoch,
          expiresAt: new Date(now().getTime() + (o.intentTtlSeconds ?? INTENT_TTL_SECONDS) * 1000),
        };
        const { record, duplicate } = await o.intents.propose(
          identity,
          draft,
          o.maxOpenIntents ?? MAX_OPEN_INTENTS,
        );
        if (!duplicate)
          try {
            o.onProposed?.(identity, record);
          } catch {
            // the activity entry is best effort; the intent is stored
          }
        return {
          output: intentOutputV3(record, duplicate),
          summary: {
            intentId: record.intentId,
            status: record.status,
            codes: [...record.reasonCodes],
          },
        };
      }),
  );

  mcp.registerTool(
    "get_intent_status",
    {
      description:
        "The state of one of your intents: awaiting approval, rejected (with every reason), expired, or sent, with the transaction hash once it is sent.",
      inputSchema: IntentStatusInput,
      outputSchema: IntentOutputV3,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      tool("get_intent_status", input, async () => {
        const r = await o.intents.get(identity, input.intentId);
        // Another agent's intent is indistinguishable from one that does not exist (4.4.1).
        if (!r) throw new ToolError("INTENT_NOT_FOUND", "No such intent for this agent.", false);
        return { output: intentOutputV3(r, false), summary: { status: r.status } };
      }),
  );
}
