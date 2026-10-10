import {
  CHAIN_TOOLS,
  IntentOutputV3,
  LimitsOutputV3,
  MemoryCallLog,
  MemoryIntentStore,
  PortfolioOutput,
  PortfolioOutputV3,
  PricesOutputV3,
  QuoteOutputV3,
  TradableOutputV3,
  ViemChainReader,
  ViemChainReaderV3,
  assessTradeV3,
  contractsFor,
  contractsForV3,
  floorForV3,
  startChainTools,
} from "@alpha-agents/chain-tools";
import {
  type TestFork,
  createTestPersonalAccountV3,
  fundTestPersonalAccountV3,
  refreshLocalFeeds,
  registerTestSessionGrant,
  revertToSnapshot,
  startTestFork,
  takeSnapshot,
  testForkUpstream,
} from "@alpha-agents/devenv";
import {
  INTENT_SCHEMA_VERSION_V3,
  ROUTE_ADAPTER_ID,
  addressEntry,
  executorV3SwapGasLimit,
} from "@alpha-agents/domain";
import { EXECUTOR_V3_ABI, type SwapIntentV3Args, refusalOf } from "@alpha-agents/signer";
import type { AgentIdentity, ToolServer } from "@alpha-agents/tool-server";
import { connectClient, staticResolver, structured } from "@alpha-agents/tool-server/testing";
import { type Hex, createPublicClient, encodeFunctionData, http, isAddressEqual } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { minAmountOutFor } from "../trade-flow.ts";

/**
 * F-U5 on a fork of its own (D-200, port 8557) with the real fund agent's set:
 * an agent whose owner opened a PersonalAccountV3 and funded it with three
 * tokens bought through their real pools gets the v3 chain tools, which read
 * every holding, every registered token's price, the best route of up to three
 * registered pools, its per-token limits, every blocker, and store a proposal
 * for any registered pair; an agent with only a v2 account on the same server
 * still gets the v2 tools (D-367); and our pre-check agrees with Executor v3
 * on a trade that goes through and on one over the limits. Skips without
 * MONAD_RPC_URL (as in CI).
 */
const PORT = 8557;
const upstream = testForkUpstream();
const SLOW = 900_000;
const CHAIN = 143143;
const KEY = "0x00000000000000000000000000000000000c4a1e" as Hex;
const TOKEN_V3 = "3".repeat(43);
const TOKEN_V2 = "2".repeat(43);
const book = (id: Parameters<typeof addressEntry>[1]) => addressEntry("local", id).address as Hex;
/** Core tokens the fund set seeds (packages/domain tokens.ts); no pool joins USDC and WBTC directly. */
const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c" as Hex;
const WETH = "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242" as Hex;
const AUSD = "0x00000000efe302beaa2b3e6e1b18d08d69a9012a" as Hex;

describe.skipIf(upstream === null)(
  "the v3 chain tools on a real fork of the fund agent's set",
  { timeout: SLOW },
  () => {
    let fork: TestFork;
    let agentId: number;
    let v2AgentId: number;
    let owner: Hex;
    let account: Hex;
    let reader: ViemChainReader;
    let readerV3: ViemChainReaderV3;
    let server: ToolServer;
    let snapshot: string;
    let impersonate: (address: Hex) => Promise<void>;
    const previousPort = process.env.LOCAL_FORK_PORT;
    const client = () => createPublicClient({ transport: http(fork.url) });
    const executorV3 = () => book("executor_v3");

    beforeAll(async () => {
      process.env.LOCAL_FORK_PORT = String(PORT);
      fork = await startTestFork({ port: PORT });
      const { deployAccountFactoryLocal } =
        await import("../../../../scripts/lib/account-factory.js");
      const { deployFundLocal } = await import("../../../../scripts/lib/fund.js");
      const { deployExecutorV3Local } = await import("../../../../scripts/lib/executor-v3.js");
      const custody = await import("../../../../scripts/lib/custody.js");
      ({ impersonate } = (await import("../../../../scripts/lib/agent-reveal.js")) as never);
      await deployAccountFactoryLocal({ quiet: true });
      // The fund agent's set, every candidate seeded (a throwaway fork), then Executor v3 over it.
      const fund = await deployFundLocal({ quiet: true, skipScreens: true });
      await deployExecutorV3Local({ quiet: true, tokenRegistry: fund.tokenRegistry });
      // Every feed the oracles read, re-dated to the fork's clock (LocalFeed, D-237).
      await refreshLocalFeeds(fork.url);
      owner = custody.testOwner(6) as Hex;
      agentId = Number(await custody.ownersAgent(book("agent_nft"), owner));
      // Agent of owner 6: a v3 account of USDC, WMON and WBTC, bought through the real pools.
      account = (await createTestPersonalAccountV3(fork.url, agentId, owner)) as Hex;
      await fundTestPersonalAccountV3(fork.url, agentId, owner, [
        { token: book("usdc"), usdcE6: 40_000_000n },
        { token: book("wmon"), usdcE6: 25_000_000n },
        { token: WBTC, usdcE6: 20_000_000n },
      ]);
      await registerTestSessionGrant(fork.url, agentId, owner, KEY, 30, executorV3());
      // Agent of owner 7: only a v2 PersonalAccount, so it stays on the v2 path (D-367).
      const v2Owner = custody.testOwner(7) as Hex;
      v2AgentId = Number(await custody.ownersAgent(book("agent_nft"), v2Owner));
      const v2 = (await custody.ensureAccount(
        book("account_factory"),
        BigInt(v2AgentId),
        v2Owner,
      )) as { account: Hex };
      await custody.depositUsdc(v2.account, v2Owner, 60_000_000n);
      await impersonate(KEY);
      const c = contractsFor("local");
      if (!c.ok) throw new Error(`missing ${c.missing.join(", ")}`);
      const c3 = contractsForV3("local");
      if (!c3.ok) throw new Error(`missing ${c3.missing.join(", ")}`);
      // No cache: every test changes the chain under it.
      reader = new ViemChainReader({
        chainId: CHAIN,
        rpcUrl: fork.url,
        contracts: c.contracts,
        cacheMs: 0,
      });
      readerV3 = new ViemChainReaderV3({
        chainId: CHAIN,
        rpcUrl: fork.url,
        contracts: c3.contracts,
        cacheMs: 0,
      });
      const identity = (id: number): AgentIdentity => ({
        chainId: CHAIN,
        agentId: id,
        tier: "base",
        leaseId: `fork-lease-${id}`,
      });
      server = await startChainTools({
        resolve: staticResolver({ [TOKEN_V3]: identity(agentId), [TOKEN_V2]: identity(v2AgentId) }),
        reader,
        readerV3,
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

    async function tools(token: string) {
      const c = await connectClient(server.url, token);
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = await c.callTool({ name, arguments: args });
        expect(r.isError, `${name}: ${JSON.stringify(structured(r))}`).toBeFalsy();
        return structured(r);
      };
      const refused = async (name: string, args: Record<string, unknown>) => {
        const r = await c.callTool({ name, arguments: args });
        expect(r.isError, `${name} should be refused`).toBeTruthy();
        return structured(r) as { code?: string; message?: string };
      };
      return { c, call, refused };
    }

    /** Our pre-check's codes, and what Executor v3 answers to the same swap along the quoted route. */
    async function both(sell: Hex, buy: Hex, amountIn: bigint) {
      const assessed = await assessTradeV3(readerV3, agentId, sell, buy, amountIn, KEY, 0);
      if (!assessed) throw new Error("no v3 account");
      const ours = assessed.blockers.map((b) => b.code);
      const { m, a, quote } = assessed;
      if (!quote) return { ours, executorCode: null as string | null, hops: 0 };
      const floor = floorForV3(m, assessed.sell, assessed.buy, amountIn);
      const intent: SwapIntentV3Args = {
        schemaVersion: INTENT_SCHEMA_VERSION_V3,
        chainId: BigInt(CHAIN),
        agentId: BigInt(agentId),
        account: a.account as Hex,
        actionId: `0x${"ab".repeat(32)}`,
        ownerEpoch: a.ownerEpoch,
        configEpoch: a.configEpoch,
        policyHash: m.policyHash,
        adapterId: ROUTE_ADAPTER_ID,
        tokenIn: sell,
        tokenOut: buy,
        amountIn,
        minAmountOut: minAmountOutFor(quote.amountOut, floor, m.policy.maxSlippageBps),
        deadline: m.timestamp + BigInt(m.policy.deadlineSeconds),
        route: quote.route.map((p) => p.poolId),
        attestationIn: "0x",
        attestationOut: "0x",
      };
      let executorCode: string | null = null;
      try {
        await client().call({
          account: KEY,
          to: executorV3(),
          gas: executorV3SwapGasLimit(quote.route.length, 4),
          data: encodeFunctionData({ abi: EXECUTOR_V3_ABI, functionName: "swap", args: [intent] }),
        });
      } catch (err) {
        executorCode = refusalOf(err).code;
      }
      return { ours, executorCode, hops: quote.route.length };
    }

    it("serves every read tool from a real account of three tokens, with routes of up to three pools", async () => {
      const { c, call } = await tools(TOKEN_V3);
      const { tools: listed } = await c.listTools();
      expect(listed.map((t) => t.name).sort()).toEqual([...CHAIN_TOOLS].sort());
      expect(await readerV3.custodyPath(agentId)).toBe("v3");

      const portfolio = PortfolioOutputV3.parse(await call("get_portfolio"));
      expect(portfolio.account.toLowerCase()).toBe(account.toLowerCase());
      const held = Object.fromEntries(portfolio.holdings.map((h) => [h.token, h]));
      expect(Object.keys(held).sort()).toEqual(["USDC", "WBTC", "WMON"]);
      expect(held.USDC).toMatchObject({ amount: "40", class: "USDC" });
      expect(BigInt(held.WMON?.amountRaw ?? "0")).toBeGreaterThan(0n);
      expect(BigInt(held.WBTC?.amountRaw ?? "0")).toBeGreaterThan(0n);
      expect(held.WBTC).toMatchObject({ class: "F", lane: "CORE", status: "BUYABLE" });
      expect(Number(held.WBTC?.costBasisUsdc)).toBeCloseTo(20, 0);
      expect(portfolio.heldCount).toBe(3);
      expect(portfolio.valuesUsable).toBe(true);
      expect(Number(portfolio.totalValueUsdc?.amount)).toBeGreaterThan(80);
      expect(Number(portfolio.totalValueUsdc?.amount)).toBeLessThan(90);
      expect(portfolio.mode).toBe("NORMAL");

      const prices = PricesOutputV3.parse(await call("get_prices"));
      expect(prices.tokens.length).toBeGreaterThanOrEqual(7);
      for (const t of prices.tokens) {
        expect(t.price, t.token).not.toBeNull();
        expect(Number(t.price), t.token).toBeGreaterThan(0);
        expect(t.tradable, t.token).toBe(true);
      }
      expect(prices.pools.length).toBeGreaterThanOrEqual(6);
      expect(prices.pools.every((p) => p.codeIntact)).toBe(true);

      // USDC to WBTC: no direct pool, so the best route crosses WMON (or native MON) in two hops.
      const quote = QuoteOutputV3.parse(
        await call("get_quote", { sell: "USDC", buy: "WBTC", amount: "5" }),
      );
      expect(quote.hops).toBe(2);
      expect(quote.route).toHaveLength(2);
      expect(quote.route[0]?.sell.token).toBe("USDC");
      expect(quote.route[1]?.buy.token).toBe("WBTC");
      expect(BigInt(quote.expectedOut.amountRaw)).toBeGreaterThan(0n);
      expect(quote.routesConsidered).toBeGreaterThanOrEqual(3);
      expect(quote.passesSlippageLimit).toBe(true);
      // AUSD to WETH: three hops, AUSD to USDC to MON to WETH, the most a route may have.
      const three = QuoteOutputV3.parse(
        await call("get_quote", { sell: AUSD, buy: WETH, amount: "5" }),
      );
      expect(three.hops).toBe(3);
      expect(three.route.map((h) => h.sell.token)).toEqual(["AUSD", "USDC", "WMON"]);
      expect(BigInt(three.expectedOut.amountRaw)).toBeGreaterThan(0n);

      const limits = LimitsOutputV3.parse(await call("get_limits"));
      expect(limits.sessionGrant).toMatchObject({ registered: true, expired: false });
      expect(limits.classA.attestorAvailable).toBe(false);
      expect(Number(limits.maxTradeValueUsdc?.amount)).toBeGreaterThan(8);
      const perToken = Object.fromEntries(limits.perToken.map((t) => [t.token, t]));
      expect(perToken.WBTC).toMatchObject({ held: true, buyable: true });
      // The lower of the policy's cap and the registry's 4,500 bps on WBTC.
      expect(perToken.WBTC?.capBps).toBeGreaterThan(0);
      expect(perToken.WBTC?.capBps).toBeLessThanOrEqual(4_500);
      expect(perToken.WETH).toMatchObject({ held: false, buyable: true });
      expect(Number(perToken.WETH?.roomBeforeCapUsdc?.amount)).toBeGreaterThan(0);

      const ok = TradableOutputV3.parse(
        await call("tradable_now", { sell: "USDC", buy: "WBTC", amount: "5" }),
      );
      expect(ok.tradable).toBe(true);
      expect(ok.blockers).toEqual([]);
      expect(ok.route).toHaveLength(2);

      const intent = IntentOutputV3.parse(
        await call("propose_swap", {
          sell: "USDC",
          buy: "WBTC",
          amount: "5",
          reason: "fork test: a class F trade over two pools",
        }),
      );
      expect(intent.status).toBe("awaiting_approval");
      expect(intent.route).toHaveLength(2);
      expect(intent.buy.tokenAddress.toLowerCase()).toBe(WBTC);
      expect(
        IntentOutputV3.parse(await call("get_intent_status", { intentId: intent.intentId })).status,
      ).toBe("awaiting_approval");
      // Selling a held token for another along its own route is proposed too (WBTC to WETH, two hops).
      const across = IntentOutputV3.parse(
        await call("propose_swap", {
          sell: "WBTC",
          buy: "WETH",
          amount: "0.00004",
          reason: "fork test: a pair with no USDC leg",
        }),
      );
      expect(across.status, across.reasonCodes.join(",")).toBe("awaiting_approval");
      expect(across.route).toHaveLength(2);
      await c.close();
    });

    it("names every blocker plainly: a token outside the registry, a token not held, and a class A trade before F-U12", async () => {
      const { c, call, refused } = await tools(TOKEN_V3);
      const outside = await refused("get_quote", {
        sell: "USDC",
        buy: "0x000000000000000000000000000000000000dEaD",
        amount: "1",
      });
      expect(outside.message).toMatch(/not in the token registry/);
      const notHeld = TradableOutputV3.parse(
        await call("tradable_now", { sell: "WETH", buy: "USDC", amount: "0.001" }),
      );
      expect(notHeld.tradable).toBe(false);
      expect(notHeld.blockers.map((b) => b.code)).toContain("INSUFFICIENT_BALANCE");
      // Every token on this fork is class F, so class A is refused on its lane: no attestor yet.
      const limits = LimitsOutputV3.parse(await call("get_limits"));
      expect(limits.classA.attestorAvailable).toBe(false);
      expect(limits.perToken.every((t) => t.class === "F")).toBe(true);
      await c.close();
    });

    it("keeps an agent with only a v2 account on the v2 tools (D-367)", async () => {
      expect(await readerV3.custodyPath(v2AgentId)).toBe("v2");
      const { c, call } = await tools(TOKEN_V2);
      const portfolio = PortfolioOutput.parse(await call("get_portfolio"));
      expect(portfolio.holdings[0]).toMatchObject({ asset: "USDC", amount: "60" });
      await c.close();
    });

    it("agrees with Executor v3 on a two-hop trade that goes through and on one over 10% of the account", async () => {
      const fine = await both(book("usdc"), WBTC, 5_000_000n);
      expect(fine).toEqual({ ours: [], executorCode: null, hops: 2 });
      const big = await both(book("usdc"), WBTC, 20_000_000n);
      expect(big.ours[0]).toBe("TRADE_SIZE_EXCEEDED");
      expect(big.executorCode).toBe("TRADE_SIZE_EXCEEDED");
      const a = await readerV3.agent(agentId);
      expect(a?.holdings.some((h) => isAddressEqual(h.token, WBTC) && h.balance > 0n)).toBe(true);
    });
  },
);
