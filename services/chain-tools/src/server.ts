import { createHash, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type AssetId,
  type RejectionCode,
  SLOT_HOLDING_INTENT_STATES,
  type TradeFlowCode,
} from "@alpha-agents/domain";
import {
  type AgentIdentity,
  type IdentityResolver,
  ToolError,
  type ToolServer,
  errorFrom,
  okResult,
  startToolServer,
} from "@alpha-agents/tool-server";
import { type MarketData, MarketError, type ResearchSources } from "@alpha-agents/market";
import type { Hex } from "viem";
import {
  amountOf,
  blockersFor,
  proposalVerdict,
  floorFor,
  limitsView,
  oracleImplied,
  parseTokenAmount,
  portfolioView,
  pricesView,
  quoteView,
  requireAccount,
} from "./logic.ts";
import type { AgentState, ChainReader, MarketState, Quote } from "./reader.ts";
import {
  type Blocker,
  type ChainTool,
  BalanceInput,
  BalanceOutput,
  EmptyInput,
  GetCodeInput,
  GetCodeOutput,
  PoolDepthOutput,
  ReadContractInput,
  ReadContractOutput,
  IntentOutput,
  type IntentStatus,
  IntentStatusInput,
  LimitsOutput,
  PortfolioOutput,
  PricesOutput,
  ProposeSwapInput,
  QuoteOutput,
  TradableOutput,
  TradeInput,
} from "./schema.ts";

/**
 * The chain tools server (FINAL_PLAN 4.4.2, P2-U5): the agent's reads of its
 * own account and the market, and its swap proposals. Identity, tier and
 * metering come only from the injected token (the shared host resolves it to
 * the lease); nothing in a tool's input names an agent, an account or an
 * address. Reads are free and rate limited per run. A proposal becomes a typed
 * intent, never calldata: it passes every pre-check and waits as
 * `awaiting_approval` for the trade flow (P2-U6), or is kept as `rejected`
 * with every reason code. The deadline is set only when the trade flow signs.
 */

/** Logs every chain tool call and enforces the per-run limit (A-42). */
export interface ChainCallLog {
  /** Records the call as running; throws ToolError RATE_LIMITED when the run has used its reads. */
  begin(identity: AgentIdentity, tool: ChainTool, input: Record<string, unknown>): Promise<string>;
  finish(
    callId: string,
    outcome: {
      readonly status: "succeeded" | "failed";
      readonly errorCode?: string;
      readonly summary?: Record<string, unknown>;
      /** P3-U9: the shared cache answered (a mainnet lookup another agent had just made). */
      readonly cacheHit?: boolean;
      /** P3-U4: what the tool returned, so a research cycle can check a brief against it. */
      readonly result?: Record<string, unknown>;
    },
  ): Promise<void>;
}

export interface IntentDraft {
  readonly idempotencyKey: string;
  readonly account: Hex | null;
  readonly sell: AssetId;
  readonly buy: AssetId;
  readonly amountIn: bigint;
  readonly reason: string;
  readonly clientRequestId: string | null;
  readonly status: "awaiting_approval" | "rejected";
  readonly reasonCodes: readonly (RejectionCode | TradeFlowCode)[];
  readonly blockers: readonly Blocker[];
  readonly checks: Record<string, unknown>;
  readonly ownerEpoch: bigint | null;
  readonly configEpoch: bigint | null;
  readonly expiresAt: Date;
  /** P3-U3: who proposed it; the agent's propose_swap when absent. */
  readonly source?: "agent" | "template";
  /**
   * P3-U3: the strategy epoch the proposal was made under. The template runner
   * gives its plan's; absent, the store takes the agent's epoch now.
   */
  readonly strategyEpoch?: bigint;
}

export interface IntentRecord extends Omit<IntentDraft, "status"> {
  readonly intentId: string;
  readonly status: IntentStatus;
  readonly createdAt: Date;
  readonly txHash: string | null;
}

export interface IntentStore {
  /**
   * Stores the intent for the identity's agent, or returns the one already
   * stored under the same idempotency key. Throws ToolError RATE_LIMITED when
   * a passing intent would exceed the agent's open intents (A-43).
   */
  propose(
    identity: AgentIdentity,
    draft: IntentDraft,
    maxOpen: number,
  ): Promise<{ readonly record: IntentRecord; readonly duplicate: boolean }>;
  /** The agent's own intent, with expiry applied; null for an unknown ID or another agent's. */
  get(identity: AgentIdentity, intentId: string): Promise<IntentRecord | null>;
  /**
   * Trade slots the agent's intents hold: those waiting for approval, approved
   * or submitted (P2-U6). A waiting intent reserves its slot until it is
   * rejected, expires or is sent.
   */
  reservedSlots(identity: AgentIdentity, exceptIntentId?: string): Promise<number>;
}

export interface ChainToolsOptions {
  readonly resolve: IdentityResolver;
  /** Null when this environment has no trading contracts yet: every tool says so. */
  readonly reader: ChainReader | null;
  readonly log: ChainCallLog;
  readonly intents: IntentStore;
  /** The agent's session key in the signer (its funding address, D-243), to check the grant names it. */
  readonly sessionKeyOf?: (agentId: number) => Promise<Hex | null>;
  /** Called once per new intent, for its activity entry. Errors are ignored. */
  readonly onProposed?: (identity: AgentIdentity, intent: IntentRecord) => void;
  /** How long a passing intent waits for approval (A-43). */
  readonly intentTtlSeconds?: number;
  /** At most this many intents await approval per agent (A-43). */
  readonly maxOpenIntents?: number;
  readonly now?: () => Date;
  readonly port?: number;
  /** P3-U2: the platform's market data, for the pool's depth on mainnet; none answers "not configured". */
  readonly market?: MarketData | null;
  /** P3-U9: research's mainnet lookups (read_contract, balance, get_code); none answers "not configured". */
  readonly research?: ResearchSources | null;
}

export const INTENT_TTL_SECONDS = 1_800;
export const MAX_OPEN_INTENTS = 3;

const NOT_DEPLOYED =
  "The trading contracts are not deployed on this chain yet, so there is nothing to read.";

function upstream(err: unknown): never {
  if (err instanceof ToolError) throw err;
  throw new ToolError(
    "UPSTREAM_UNAVAILABLE",
    "The chain could not be read; try again shortly.",
    true,
  );
}

const intentOutput = (r: IntentRecord, duplicate: boolean): IntentOutput => ({
  intentId: r.intentId,
  status: r.status,
  sell: amountOf(r.sell, r.amountIn),
  buy: r.buy,
  reason: r.reason,
  reasonCodes: [...r.reasonCodes],
  blockers: [...r.blockers],
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt.toISOString(),
  txHash: r.txHash,
  duplicate,
});

export function registerChainTools(
  mcp: McpServer,
  identity: AgentIdentity,
  o: Omit<ChainToolsOptions, "resolve" | "port">,
): void {
  const reader = o.reader;
  const now = () => o.now?.() ?? new Date();

  const read = async <T>(fn: (r: ChainReader) => Promise<T>): Promise<T> => {
    if (!reader) throw new ToolError("UPSTREAM_UNAVAILABLE", NOT_DEPLOYED, false);
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
  const quoteOrNull = (sell: AssetId, amountIn: bigint): Promise<Quote | null> =>
    reader ? reader.quote(sell, amountIn).catch(() => null) : Promise.resolve(null);
  const sessionKey = async () => (o.sessionKeyOf ? o.sessionKeyOf(identity.agentId) : null);

  /** Logs the call, runs it, and answers in the shared shape. */
  const tool = async (
    name: ChainTool,
    input: Record<string, unknown>,
    run: () => Promise<{
      output: Record<string, unknown>;
      summary?: Record<string, unknown>;
      cacheHit?: boolean;
    }>,
  ): Promise<CallToolResult> => {
    let callId: string | null = null;
    try {
      callId = await o.log.begin(identity, name, input);
      const { output, summary, cacheHit } = await run();
      await o.log.finish(callId, {
        status: "succeeded",
        ...(summary ? { summary } : {}),
        ...(cacheHit === undefined ? {} : { cacheHit }),
        result: output,
      });
      return okResult(output);
    } catch (err) {
      if (callId)
        await o.log
          .finish(callId, {
            status: "failed",
            errorCode: err instanceof ToolError ? err.code : "INTERNAL",
          })
          .catch(() => undefined);
      return errorFrom(err);
    }
  };

  mcp.registerTool(
    "get_portfolio",
    {
      description:
        "Your trading account: USDC and WMON held, their value in USDC and share of the total, the account mode, and the circuit breaker's drawdown from its 7-day peak.",
      inputSchema: EmptyInput,
      outputSchema: PortfolioOutput,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      tool("get_portfolio", input, async () => {
        const { m, a } = await marketAndAgent();
        const out = portfolioView(requireAccount(a), m);
        return {
          output: out,
          summary: {
            block: out.asOf.block,
            usdc: out.holdings[0]?.amount,
            wmon: out.holdings[1]?.amount,
            totalValueUsdc: out.totalValueUsdc.amount,
            mode: out.mode,
            drawdownBps: out.breaker.drawdownBps,
          },
        };
      }),
  );

  mcp.registerTool(
    "get_pool_depth",
    {
      description:
        "The launch venue's depth on Monad mainnet: its mid price, active liquidity, and the price impact of buying and selling MON at 10, 100, 1,000 and 10,000 USD, with and without the 0.05% fee. Research reads mainnet; your own trades use your environment's pool, so check get_quote before proposing.",
      inputSchema: EmptyInput,
      outputSchema: PoolDepthOutput,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      tool("get_pool_depth", input, async () => {
        const market = o.market;
        if (!market)
          throw new ToolError(
            "UPSTREAM_UNAVAILABLE",
            "Market data is not configured on this platform.",
            false,
          );
        let depth;
        try {
          depth = await market.poolDepth();
        } catch (err) {
          if (err instanceof MarketError) throw new ToolError(err.code, err.message, err.retryable);
          throw err;
        }
        const out = PoolDepthOutput.parse(
          JSON.parse(
            JSON.stringify({
              chain: "monad-mainnet",
              venue: "Uniswap v4 MON/USDC 0.05%",
              ...depth.value,
              cacheHit: depth.cacheHit,
              note: "Impact is measured against the pool's mid price; the fee is the pool's own 0.05%.",
            }),
          ),
        );
        return { output: out, summary: { block: out.block, cacheHit: out.cacheHit } };
      }),
  );

  // P3-U9: contract lookups on Monad mainnet for research (A-24), read-only and typed.
  const research = async <T>(fn: (r: ResearchSources) => Promise<T>): Promise<T> => {
    const r = o.research;
    if (!r)
      throw new ToolError(
        "UPSTREAM_UNAVAILABLE",
        "Monad mainnet reads are not configured on this platform.",
        false,
      );
    try {
      return await fn(r);
    } catch (err) {
      if (err instanceof MarketError) throw new ToolError(err.code, err.message, err.retryable);
      throw err;
    }
  };
  const LOOKUP_NOTE =
    "Read on Monad mainnet for research. Integers are decimal strings in raw units; a string or bytes value is given only as its length and keccak256 hash.";

  mcp.registerTool(
    "read_contract",
    {
      description:
        "Call one read-only function from a curated list on any contract on Monad mainnet (`target`): ERC-20 supply, decimals, balance, name and symbol (as hashes), owner, paused, EIP-1967 proxy slots, a Chainlink feed's latest round, or a Uniswap v4 pool's state through StateView. Returns typed values only; strings never come back as text. Free; limited per run.",
      inputSchema: ReadContractInput,
      outputSchema: ReadContractOutput,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      tool("read_contract", input, async () => {
        const args: Record<string, string> = {};
        if (input.holder) args.holder = input.holder;
        if (input.poolId) args.poolId = input.poolId;
        const res = await research((r) =>
          r.readContract(input.function, input.target as Hex, args),
        );
        const out = ReadContractOutput.parse(
          JSON.parse(
            JSON.stringify({
              chain: "monad-mainnet",
              ...res.value,
              cacheHit: res.cacheHit,
              note: LOOKUP_NOTE,
            }),
          ),
        );
        return {
          output: out,
          summary: { function: out.function, target: out.target, block: out.asOf.block },
          cacheHit: res.cacheHit,
        };
      }),
  );

  mcp.registerTool(
    "balance",
    {
      description:
        "The USDC, WMON or native MON balance of any address on Monad mainnet (`target`), as a decimal string with the raw amount. Free; limited per run.",
      inputSchema: BalanceInput,
      outputSchema: BalanceOutput,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      tool("balance", input, async () => {
        const res = await research((r) => r.balance(input.target as Hex, input.asset));
        const out = BalanceOutput.parse({
          chain: "monad-mainnet",
          ...res.value,
          cacheHit: res.cacheHit,
        });
        return {
          output: out,
          summary: { target: out.target, asset: out.asset, block: out.asOf.block },
          cacheHit: res.cacheHit,
        };
      }),
  );

  mcp.registerTool(
    "get_code",
    {
      description:
        "Whether an address on Monad mainnet (`target`) holds contract code: its size, its keccak256 hash, and the proxy pattern detected (EIP-1967, beacon, the older ZeppelinOS slot, EIP-1167 minimal proxy, or an EIP-7702 delegation) with the implementation it points to. An address with no code says so. Free; limited per run.",
      inputSchema: GetCodeInput,
      outputSchema: GetCodeOutput,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      tool("get_code", input, async () => {
        const res = await research((r) => r.code(input.target as Hex));
        const out = GetCodeOutput.parse({
          chain: "monad-mainnet",
          ...res.value,
          proxy: { ...res.value.proxy },
          cacheHit: res.cacheHit,
        });
        return {
          output: out,
          summary: { target: out.target, hasCode: out.hasCode, proxy: out.proxy.pattern },
          cacheHit: res.cacheHit,
        };
      }),
  );

  mcp.registerTool(
    "get_prices",
    {
      description:
        "The oracle prices (MON/USD and USDC/USD) with their age, the trading pool's price, how far the pool is from the oracle, and whether trading is allowed on these prices now.",
      inputSchema: EmptyInput,
      outputSchema: PricesOutput,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      tool("get_prices", input, async () => {
        const m = await read((r) => r.market());
        const out = pricesView(m);
        return {
          output: out,
          summary: { block: out.asOf.block, monUsd: out.monUsd.price, tradable: out.tradable },
        };
      }),
  );

  mcp.registerTool(
    "get_quote",
    {
      description:
        "What selling an amount of USDC or WMON would return on the trading venue now, compared with the oracle price, and whether it is inside the slippage limit. Indicative: it reserves nothing.",
      inputSchema: TradeInput,
      outputSchema: QuoteOutput,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      tool("get_quote", input, async () => {
        const amountIn = parseTokenAmount(input.amount, input.sell);
        if (amountIn === 0n)
          throw new ToolError("INVALID_INPUT", "The amount must be above zero.", false);
        const [m, q] = await Promise.all([
          read((r) => r.market()),
          read((r) => r.quote(input.sell, amountIn)),
        ]);
        const out = quoteView(input.sell, input.buy, amountIn, q, m);
        return {
          output: out,
          summary: { expectedOut: out.expectedOut.amount, slippageBps: out.slippageBps },
        };
      }),
  );

  mcp.registerTool(
    "get_limits",
    {
      description:
        "What your limits leave room for now, read from the Executor: the largest trade, room before the 40% cap on WMON, USDC above the 10% floor, trades and turnover left in the rolling 24 hours, and when your trading permission expires.",
      inputSchema: EmptyInput,
      outputSchema: LimitsOutput,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      tool("get_limits", input, async () => {
        const { m, a } = await marketAndAgent();
        const out = limitsView(requireAccount(a), m);
        return {
          output: out,
          summary: {
            tradesLeft24h: out.tradesLeft24h,
            maxTradeValueUsdc: out.maxTradeValueUsdc.amount,
          },
        };
      }),
  );

  const assess = async (sell: AssetId, amountIn: bigint) => {
    const { m, a } = await marketAndAgent();
    const agent = requireAccount(a);
    const [quote, key, reserved] = await Promise.all([
      quoteOrNull(sell, amountIn),
      sessionKey(),
      o.intents.reservedSlots(identity),
    ]);
    return {
      m,
      a: agent,
      quote,
      blockers: blockersFor(sell, amountIn, agent, m, quote, key, reserved),
    };
  };

  mcp.registerTool(
    "tradable_now",
    {
      description:
        "Whether a swap of this direction and size could go through right now. If not, every rule that blocks it, the owner-facing reason, and whether it clears by waiting (and when), by changing the trade, or only by the owner or the platform.",
      inputSchema: TradeInput,
      outputSchema: TradableOutput,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      tool("tradable_now", input, async () => {
        const amountIn = parseTokenAmount(input.amount, input.sell);
        const { a, blockers } = await assess(input.sell, amountIn);
        const out: TradableOutput = {
          asOf: {
            block: a.block.toString(),
            timestamp: new Date(Number(a.timestamp) * 1000).toISOString(),
          },
          sell: amountOf(input.sell, amountIn),
          buy: input.buy,
          tradable: blockers.length === 0,
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
        "Propose a swap from your trading account. It is checked against every limit at once: if it passes it waits for the owner's approval and is never sent before; if not, you get every reason code. Returns an intent ID, never a transaction.",
      inputSchema: ProposeSwapInput,
      outputSchema: IntentOutput,
      annotations: { idempotentHint: true },
    },
    async (input) =>
      tool("propose_swap", input, async () => {
        const amountIn = parseTokenAmount(input.amount, input.sell);
        const { m, a, quote, blockers } = await assess(input.sell, amountIn);
        // Only the session grant missing makes a passing trade wait for the owner to arm (P2-U6).
        const verdict = proposalVerdict(blockers);
        const codes = verdict.rejecting.map((b) => b.code);
        const fingerprint = createHash("sha256")
          .update(JSON.stringify([input.sell, input.buy, amountIn.toString()]))
          .digest("hex")
          .slice(0, 32);
        const draft: IntentDraft = {
          idempotencyKey: `${identity.leaseId}:${input.clientRequestId ?? fingerprint}`,
          account: a.account,
          sell: input.sell,
          buy: input.buy,
          amountIn,
          reason: input.reason,
          clientRequestId: input.clientRequestId ?? null,
          status: verdict.status,
          reasonCodes: codes,
          blockers,
          checks: checksOf(input.sell, amountIn, a, m, quote),
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
          output: intentOutput(record, duplicate),
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
      outputSchema: IntentOutput,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      tool("get_intent_status", input, async () => {
        const r = await o.intents.get(identity, input.intentId);
        // Another agent's intent is indistinguishable from one that does not exist (4.4.1).
        if (!r) throw new ToolError("INTENT_NOT_FOUND", "No such intent for this agent.", false);
        return { output: intentOutput(r, false), summary: { status: r.status } };
      }),
  );
}

/** What the pre-checks read, stored with the intent so its verdict can be explained later. */
function checksOf(
  sell: AssetId,
  amountIn: bigint,
  a: AgentState,
  m: MarketState,
  quote: Quote | null,
): Record<string, unknown> {
  return {
    block: a.block.toString(),
    timestamp: a.timestamp.toString(),
    chainId: m.chainId,
    monUsdE18: m.monUsd.priceE18.toString(),
    oracle: m.tradableReason,
    usdc: a.usdc.toString(),
    wmon: a.wmon.toString(),
    mode: a.mode,
    drawdownBps: a.breaker?.drawdownBps.toString() ?? null,
    oracleImpliedOut: oracleImplied(sell, amountIn, m.monUsd.priceE18).toString(),
    minimumOut: floorFor(sell, amountIn, m).toString(),
    expectedOut: quote?.amountOut.toString() ?? null,
    policyHash: m.policyHash,
  };
}

export async function startChainTools(options: ChainToolsOptions): Promise<ToolServer> {
  return startToolServer({
    name: "chain",
    resolve: options.resolve,
    register: (mcp, identity) => registerChainTools(mcp, identity, options),
    ...(options.port === undefined ? {} : { port: options.port }),
  });
}

/** The call log in memory, for tests: a per-lease limit like the real one. */
export class MemoryCallLog implements ChainCallLog {
  readonly calls: {
    callId: string;
    identity: AgentIdentity;
    tool: ChainTool;
    input: Record<string, unknown>;
    status: "running" | "succeeded" | "failed" | "refused";
    errorCode?: string;
    summary?: Record<string, unknown>;
    cacheHit?: boolean;
  }[] = [];
  readonly limit: number;

  constructor(limit = 60) {
    this.limit = limit;
  }

  async begin(identity: AgentIdentity, tool: ChainTool, input: Record<string, unknown>) {
    const used = this.calls.filter(
      (c) => c.identity.leaseId === identity.leaseId && c.status !== "refused",
    ).length;
    const callId = `call-${randomUUID()}`;
    if (used >= this.limit) {
      this.calls.push({
        callId,
        identity,
        tool,
        input,
        status: "refused",
        errorCode: "LEASE_READ_LIMIT",
      });
      throw new ToolError(
        "RATE_LIMITED",
        `This run has used all ${this.limit} of its chain tool calls.`,
        false,
      );
    }
    this.calls.push({ callId, identity, tool, input, status: "running" });
    return callId;
  }

  async finish(callId: string, outcome: Parameters<ChainCallLog["finish"]>[1]) {
    const c = this.calls.find((x) => x.callId === callId);
    if (!c) return;
    c.status = outcome.status;
    if (outcome.errorCode) c.errorCode = outcome.errorCode;
    if (outcome.summary) c.summary = outcome.summary;
    if (outcome.cacheHit !== undefined) c.cacheHit = outcome.cacheHit;
  }
}

/** The intent store in memory, for tests: the same idempotency, expiry, scoping and open limit. */
export class MemoryIntentStore implements IntentStore {
  readonly records: (IntentRecord & { agentKey: string })[] = [];
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  private key = (i: AgentIdentity) => `${i.chainId}:${i.agentId}`;

  private expire(r: IntentRecord & { agentKey: string }) {
    if (r.status === "awaiting_approval" && r.expiresAt <= this.now())
      (r as { status: IntentStatus }).status = "expired";
    return r;
  }

  async propose(identity: AgentIdentity, draft: IntentDraft, maxOpen: number) {
    const agentKey = this.key(identity);
    const same = this.records.find(
      (r) => r.agentKey === agentKey && r.idempotencyKey === draft.idempotencyKey,
    );
    if (same) return { record: this.expire(same), duplicate: true };
    const open = this.records.filter(
      (r) => r.agentKey === agentKey && this.expire(r).status === "awaiting_approval",
    ).length;
    if (draft.status === "awaiting_approval" && open >= maxOpen)
      throw new ToolError(
        "RATE_LIMITED",
        `You already have ${maxOpen} intents awaiting approval; wait for them to be approved or expire.`,
        false,
      );
    const record = {
      ...draft,
      agentKey,
      intentId: `intent-${randomUUID()}`,
      createdAt: this.now(),
      txHash: null,
    };
    this.records.push(record);
    return { record, duplicate: false };
  }

  async get(identity: AgentIdentity, intentId: string) {
    const r = this.records.find(
      (x) => x.intentId === intentId && x.agentKey === this.key(identity),
    );
    return r ? this.expire(r) : null;
  }

  async reservedSlots(identity: AgentIdentity, exceptIntentId?: string) {
    return this.records.filter(
      (r) =>
        r.agentKey === this.key(identity) &&
        r.intentId !== exceptIntentId &&
        (SLOT_HOLDING_INTENT_STATES as readonly string[]).includes(this.expire(r).status),
    ).length;
  }
}
