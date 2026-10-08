import {
  CHAIN_TOOLS,
  IntentOutput,
  LimitsOutput,
  MemoryCallLog,
  MemoryIntentStore,
  PortfolioOutput,
  PricesOutput,
  QuoteOutput,
  TradableOutput,
  ViemChainReader,
  blockersFor,
  contractsFor,
  startChainTools,
} from "@alpha-agents/chain-tools";
import {
  type TestFork,
  advanceTime,
  revertToSnapshot,
  startTestFork,
  takeSnapshot,
  testForkUpstream,
} from "@alpha-agents/devenv";
import { type AssetId, REJECTION_CODES, addressEntry } from "@alpha-agents/domain";
import { EXECUTOR_ABI, type SwapIntentArgs, buildTestSwap, refusalOf } from "@alpha-agents/signer";
import type { AgentIdentity, ToolServer } from "@alpha-agents/tool-server";
import { connectClient, staticResolver, structured } from "@alpha-agents/tool-server/testing";
import { type Hex, createPublicClient, encodeFunctionData, http, parseAbi } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * P2-U5 on a fork of its own (D-200, port 8555) with the real stack: the
 * chain tools read real USDC, WMON, the Chainlink feeds (LocalFeed, D-237)
 * and the v4 pool, and for each real blocking condition the pre-check's first
 * reason is what the real Executor answers to the same swap (an eth_call from
 * the agent's session key). Skips without MONAD_RPC_URL (as in CI).
 */
const PORT = 8555;
const upstream = testForkUpstream();
const SLOW = 600_000;
const KEY = "0x00000000000000000000000000000000000c4a1e" as Hex;
const TOKEN = "t".repeat(43);
const ACCOUNT_ABI = parseAbi(["function setReduceOnly()", "function pause()"]);

describe.skipIf(upstream === null)("the chain tools on a real fork", { timeout: SLOW }, () => {
  let fork: TestFork;
  let agentId: number;
  let owner: Hex;
  let account: Hex;
  let reader: ViemChainReader;
  let server: ToolServer;
  let snapshot: string;
  let send: (from: Hex, request: unknown) => Promise<unknown>;
  let impersonate: (address: Hex) => Promise<void>;
  let setMonUsd: (answer: bigint) => Promise<void>;
  let useFreshFeeds: () => Promise<{ monUsd: bigint }>;
  const previousPort = process.env.LOCAL_FORK_PORT;
  const executor = () => addressEntry("local", "executor").address as Hex;
  const client = () => createPublicClient({ transport: http(fork.url) });

  beforeAll(async () => {
    process.env.LOCAL_FORK_PORT = String(PORT);
    fork = await startTestFork({ port: PORT });
    const { deployAccountFactoryLocal } =
      await import("../../../../scripts/lib/account-factory.js");
    const custody = await import("../../../../scripts/lib/custody.js");
    const oracle = await import("../../../../scripts/lib/oracle.js");
    ({ send, impersonate } = (await import("../../../../scripts/lib/agent-reveal.js")) as never);
    ({ setMonUsd, useFreshFeeds } = oracle as never);
    await deployAccountFactoryLocal({ quiet: true });
    await useFreshFeeds();
    owner = custody.testOwner(6) as Hex;
    agentId = Number(
      await custody.ownersAgent(addressEntry("local", "agent_nft").address as Hex, owner),
    );
    ({ account } = (await custody.ensureAccount(
      addressEntry("local", "account_factory").address as Hex,
      BigInt(agentId),
      owner,
    )) as { account: Hex });
    await custody.depositUsdc(account, owner, 60_000_000n);
    const now = (await client().getBlock()).timestamp;
    await send(owner, {
      address: executor(),
      abi: EXECUTOR_ABI,
      functionName: "registerSession",
      args: [BigInt(agentId), KEY, now + 30n * 86_400n],
    });
    await impersonate(KEY);
    const c = contractsFor("local");
    if (!c.ok) throw new Error(`missing ${c.missing.join(", ")}`);
    // No cache: every test changes the chain under it.
    reader = new ViemChainReader({
      chainId: 143143,
      rpcUrl: fork.url,
      contracts: c.contracts,
      cacheMs: 0,
    });
    const identity: AgentIdentity = {
      chainId: 143143,
      agentId,
      tier: "base",
      leaseId: "fork-lease",
    };
    server = await startChainTools({
      resolve: staticResolver({ [TOKEN]: identity }),
      reader,
      log: new MemoryCallLog(500),
      intents: new MemoryIntentStore(),
      sessionKeyOf: async () => KEY,
    });
  }, SLOW);

  afterAll(async () => {
    await server?.close();
    await fork?.stop();
    if (previousPort === undefined) delete process.env.LOCAL_FORK_PORT;
    else process.env.LOCAL_FORK_PORT = previousPort;
  }, SLOW);

  beforeEach(async () => {
    snapshot = await takeSnapshot(fork.url);
  });
  afterEach(async () => {
    await revertToSnapshot(snapshot, fork.url);
  });

  /** Our pre-check's codes, and what the real Executor answers to the same swap from the session key. */
  async function both(sell: AssetId, amountIn: bigint, prebuilt?: SwapIntentArgs) {
    const [m, a, q] = await Promise.all([
      reader.market(),
      reader.agent(agentId),
      reader.quote(sell, amountIn).catch(() => null),
    ]);
    if (!a) throw new Error("no agent");
    const ours = blockersFor(sell, amountIn, a, m, q, KEY).map((b) => b.code);
    // A stale feed makes the price read revert, so that case builds its swap before the clock moves.
    const intent =
      prebuilt ??
      (await (async () => {
        const swap = await buildTestSwap(fork.url, {
          agentId,
          direction: sell === "USDC" ? "buy" : "sell",
          amountIn,
        });
        if (swap.kind !== "swap") throw new Error("expected a swap");
        return swap.intent;
      })());
    let executorCode: string | null = null;
    try {
      await client().call({
        account: KEY,
        to: executor(),
        data: encodeFunctionData({ abi: EXECUTOR_ABI, functionName: "swap", args: [intent] }),
      });
    } catch (err) {
      executorCode = refusalOf(err).code;
    }
    return { ours, executorCode };
  }

  it("serves every read tool from real tokens, feeds and the pool, with typed output", async () => {
    const alice = await connectClient(server.url, TOKEN);
    const { tools } = await alice.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...CHAIN_TOOLS].sort());
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await alice.callTool({ name, arguments: args });
      expect(r.isError, `${name}: ${JSON.stringify(structured(r))}`).toBeFalsy();
      return structured(r);
    };
    const portfolio = PortfolioOutput.parse(await call("get_portfolio"));
    expect(portfolio.account.toLowerCase()).toBe(account.toLowerCase());
    expect(portfolio.holdings[0]).toMatchObject({ asset: "USDC", amount: "60", shareBps: 10_000 });
    expect(portfolio.mode).toBe("NORMAL");
    const prices = PricesOutput.parse(await call("get_prices"));
    expect(prices).toMatchObject({ tradable: true, blockedBy: null });
    expect(Number(prices.monUsd.price)).toBeGreaterThan(0);
    expect(Number(prices.pool.price)).toBeGreaterThan(0);
    expect(prices.poolDeviationBps).toBeLessThan(200);
    const quote = QuoteOutput.parse(
      await call("get_quote", { sell: "USDC", buy: "WMON", amount: "5" }),
    );
    expect(BigInt(quote.expectedOut.amountRaw)).toBeGreaterThan(0n);
    expect(quote.passesSlippageLimit).toBe(true);
    const limits = LimitsOutput.parse(await call("get_limits"));
    expect(limits).toMatchObject({
      accountValueUsdc: { amount: "60" },
      maxTradeValueUsdc: { amount: "6" },
      tradesLeft24h: 20,
      sessionGrant: { registered: true, expired: false },
    });
    const ok = TradableOutput.parse(
      await call("tradable_now", { sell: "USDC", buy: "WMON", amount: "5" }),
    );
    expect(ok.blockers).toEqual([]);
    const intent = IntentOutput.parse(
      await call("propose_swap", { sell: "USDC", buy: "WMON", amount: "5", reason: "fork test" }),
    );
    expect(intent.status).toBe("awaiting_approval");
    expect(
      IntentOutput.parse(await call("get_intent_status", { intentId: intent.intentId })).status,
    ).toBe("awaiting_approval");
    await alice.close();
  });

  it("agrees with the Executor on a trade that goes through", async () => {
    expect(await both("USDC", 5_000_000n)).toEqual({ ours: [], executorCode: null });
  });

  it("names the Executor's reason for a trade over 10% of the account", async () => {
    const r = await both("USDC", 10_000_000n);
    expect(r.ours[0]).toBe("TRADE_SIZE_EXCEEDED");
    expect(r.executorCode).toBe("TRADE_SIZE_EXCEEDED");
  });

  it("names the Executor's reason for selling what the account does not hold", async () => {
    const r = await both("WMON", 10n ** 18n);
    expect(r.ours[0]).toBe(r.executorCode);
    expect(r.executorCode).toBe("INSUFFICIENT_BALANCE");
  });

  it("blocks buys in reduce-only mode and every trade when paused, as the Executor does", async () => {
    await send(owner, { address: account, abi: ACCOUNT_ABI, functionName: "setReduceOnly" });
    const reduce = await both("USDC", 1_000_000n);
    expect(reduce).toMatchObject({ ours: ["REDUCE_ONLY_MODE"], executorCode: "REDUCE_ONLY_MODE" });
    await send(owner, { address: account, abi: ACCOUNT_ABI, functionName: "pause" });
    const paused = await both("USDC", 1_000_000n);
    expect(paused.ours[0]).toBe("PAUSED");
    expect(paused.executorCode).toBe("PAUSED");
  });

  it("blocks on a stale price, as the Executor does", async () => {
    const swap = await buildTestSwap(fork.url, { agentId, direction: "buy", amountIn: 1_000_000n });
    if (swap.kind !== "swap") throw new Error("expected a swap");
    const { timestamp } = await advanceTime(400, fork.url);
    const r = await both("USDC", 1_000_000n, { ...swap.intent, deadline: BigInt(timestamp) + 60n });
    expect(r.ours[0]).toBe("ORACLE_STALE");
    expect(r.executorCode).toBe("ORACLE_STALE");
  });

  it("blocks when the pool is more than 2% from the oracle, as the Executor does", async () => {
    const { monUsd } = await useFreshFeeds();
    await setMonUsd((monUsd * 103n) / 100n);
    const r = await both("USDC", 1_000_000n);
    expect(r.ours[0]).toBe("ORACLE_POOL_DEVIATION");
    expect(r.executorCode).toBe("ORACLE_POOL_DEVIATION");
  });

  it("blocks the 21st trade in 24 hours, as the Executor does, and says when a slot frees", async () => {
    for (let k = 0; k < 20; k++) {
      await useFreshFeeds();
      const swap = await buildTestSwap(fork.url, {
        agentId,
        direction: "buy",
        amountIn: 1_000_000n,
      });
      if (swap.kind !== "swap") throw new Error("expected a swap");
      await send(KEY, {
        address: executor(),
        abi: EXECUTOR_ABI,
        functionName: "swap",
        args: [swap.intent],
      });
    }
    await useFreshFeeds();
    const r = await both("USDC", 1_000_000n);
    expect(r.ours[0]).toBe("DAILY_TRADE_LIMIT");
    expect(r.executorCode).toBe("DAILY_TRADE_LIMIT");
    const [m, a] = await Promise.all([reader.market(), reader.agent(agentId)]);
    if (!a) throw new Error("no agent");
    const blocked = blockersFor("USDC", 1_000_000n, a, m, null, KEY).find(
      (b) => b.code === "DAILY_TRADE_LIMIT",
    );
    expect(blocked?.clears).toBe("by_waiting");
    expect(Date.parse(blocked?.clearsAt ?? "")).toBeGreaterThan(Number(m.timestamp) * 1000);
    expect(REJECTION_CODES).toContain(r.executorCode);
  });
});
