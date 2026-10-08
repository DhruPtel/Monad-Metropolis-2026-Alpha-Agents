import { afterEach, describe, expect, it } from "vitest";
import { FORBIDDEN_INTENT_FIELDS, REJECTION_CODES } from "@alpha-agents/domain";
import { LAUNCH_EXECUTOR_POLICY, LAUNCH_POLICY_HASH, executorPreCheck } from "@alpha-agents/policy";
import { type AgentIdentity, type ToolServer, identityFields } from "@alpha-agents/tool-server";
import { connectClient, staticResolver, structured } from "@alpha-agents/tool-server/testing";
import type { Hex } from "viem";
import { executorMarketOf, tradeNow } from "./logic.ts";
import type { AgentState, ChainReader, MarketState, Quote } from "./reader.ts";
import { CHAIN_TOOL_INPUTS, CHAIN_TOOLS, IntentOutput, TradableOutput } from "./schema.ts";
import {
  type ChainToolsOptions,
  MemoryCallLog,
  MemoryIntentStore,
  startChainTools,
} from "./server.ts";

const ALICE: AgentIdentity = { chainId: 143143, agentId: 1, tier: "base", leaseId: "lease-alice" };
const BOB: AgentIdentity = { chainId: 143143, agentId: 2, tier: "base", leaseId: "lease-bob" };
const ALICE_TOKEN = "a".repeat(43);
const BOB_TOKEN = "b".repeat(43);
const KEY = "0x00000000000000000000000000000000000000ee" as Hex;
const NOW = 1_790_000_000n;
const PX = 25_000_000_000_000_000n; // 0.025 USDC per WMON
const usdc = (whole: bigint) => whole * 1_000_000n;
const wmonWorth = (e6: bigint) => (e6 * 10n ** 30n) / PX;

/** A reader over fixed state that tests change field by field. */
class FakeReader implements ChainReader {
  readonly chainId = 143143;
  market_: MarketState = {
    chainId: 143143,
    block: 500n,
    timestamp: NOW,
    policy: { ...LAUNCH_EXECUTOR_POLICY },
    policyHash: LAUNCH_POLICY_HASH,
    paused: false,
    wmonBuyable: true,
    monUsd: { priceE18: PX, updatedAt: NOW - 20n, reason: "OK" },
    usdcUsd: { priceE18: 10n ** 18n, updatedAt: NOW - 600n, reason: "OK" },
    pool: { priceE18: PX, reason: "OK" },
    deviationBps: 0n,
    tradableReason: "OK",
    venue: null,
  };
  agents = new Map<number, AgentState>();
  quoteBps = 9_990n; // the venue fills 0.1% under the oracle
  quoteFails = false;
  agentReads: number[] = [];

  constructor() {
    for (const id of [1, 2]) this.agents.set(id, agentState());
  }
  async market() {
    return this.market_;
  }
  async agent(id: number) {
    this.agentReads.push(id);
    return this.agents.get(id) ?? null;
  }
  async quote(sell: "USDC" | "WMON", amountIn: bigint): Promise<Quote> {
    if (this.quoteFails) throw new Error("quoter reverted");
    const implied = sell === "USDC" ? (amountIn * 10n ** 30n) / PX : (amountIn * PX) / 10n ** 30n;
    return { block: 500n, amountOut: (implied * this.quoteBps) / 10_000n };
  }
  tokenOf(asset: "USDC" | "WMON"): Hex {
    return asset === "USDC"
      ? "0x00000000000000000000000000000000000000c1"
      : "0x00000000000000000000000000000000000000c2";
  }
}

function agentState(over: Partial<AgentState> = {}): AgentState {
  return {
    block: 500n,
    timestamp: NOW,
    owner: "0x00000000000000000000000000000000000a11ce",
    ownerEpoch: 0n,
    configEpoch: 0n,
    account: "0x00000000000000000000000000000000000ac001",
    usdc: usdc(70n),
    wmon: wmonWorth(usdc(30n)),
    mode: "NORMAL",
    breaker: { nav: usdc(100n), perUnit: 10n ** 18n, peak: 10n ** 18n, drawdownBps: 0n },
    peak7d: 10n ** 18n,
    grant: { key: KEY, ownerEpoch: 0n, configEpoch: 0n, validUntil: NOW + 86_400n },
    trades: [],
    tradesLeft: 20,
    nextSlotFreesAt: 0n,
    turnoverUsed: 0n,
    venueAllowed: { buy: true, sell: true },
    ...over,
  };
}

const servers: ToolServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(over: Partial<ChainToolsOptions> = {}) {
  const reader = new FakeReader();
  const log = new MemoryCallLog();
  let clock = new Date(Number(NOW) * 1000);
  const intents = new MemoryIntentStore(() => clock);
  const proposed: string[] = [];
  const server = await startChainTools({
    resolve: staticResolver({ [ALICE_TOKEN]: ALICE, [BOB_TOKEN]: BOB }),
    reader,
    log,
    intents,
    sessionKeyOf: async () => KEY,
    onProposed: (_i, r) => proposed.push(r.intentId),
    now: () => clock,
    ...over,
  });
  servers.push(server);
  const alice = await connectClient(server.url, ALICE_TOKEN);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await alice.callTool({ name, arguments: args });
    return { error: r.isError === true, out: structured(r) };
  };
  return {
    server,
    reader,
    log,
    intents,
    proposed,
    alice,
    call,
    tick: (s: number) => (clock = new Date(clock.getTime() + s * 1000)),
  };
}

describe("chain tools server (P2-U5)", () => {
  it("lists the seven tools with output schemas, no identity fields, and every tool is in the registry", async () => {
    const { alice } = await start();
    const { tools } = await alice.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...CHAIN_TOOLS].sort());
    for (const t of tools) {
      expect(t.outputSchema, t.name).toBeDefined();
      expect(t.description?.length, t.name).toBeGreaterThan(40);
    }
    for (const schema of Object.values(CHAIN_TOOL_INPUTS))
      expect(identityFields(schema)).toEqual([]);
    const { TOOL_IDS } = await import("@alpha-agents/domain");
    for (const name of CHAIN_TOOLS) expect(TOOL_IDS).toContain(`chain.${name}@1`);
    await alice.close();
  });

  it("reads the portfolio: balances, values, shares, mode and the breaker", async () => {
    const { call } = await start();
    const { error, out } = await call("get_portfolio");
    expect(error).toBe(false);
    expect(out).toMatchObject({
      account: "0x00000000000000000000000000000000000ac001",
      totalValueUsdc: { amount: "100", amountRaw: "100000000" },
      mode: "NORMAL",
      breaker: { drawdownBps: 0, state: "NORMAL", peakValuePerUnit7d: "1" },
      priceUsedUsdcPerWmon: "0.025",
    });
    expect(out.holdings).toEqual([
      expect.objectContaining({ asset: "USDC", amount: "70", shareBps: 7000 }),
      expect.objectContaining({ asset: "WMON", amount: "1200", valueUsdc: "30", shareBps: 3000 }),
    ]);
  });

  it("says the breaker's view is unknown while its price is unusable, and still gives the 7-day peak", async () => {
    const { reader, call } = await start();
    reader.agents.set(1, agentState({ breaker: null, peak7d: 2n * 10n ** 18n }));
    const { out } = await call("get_portfolio");
    expect(out.breaker).toEqual({
      drawdownBps: null,
      state: "UNKNOWN",
      valuePerUnit: null,
      peakValuePerUnit7d: "2",
    });
  });

  it("reads prices with their age, the pool, the deviation and whether they allow trading", async () => {
    const { reader, call } = await start();
    const ok = await call("get_prices");
    expect(ok.out).toMatchObject({
      monUsd: { price: "0.025", ageSeconds: 20, status: "OK" },
      tradable: true,
      blockedBy: null,
    });
    reader.market_ = { ...reader.market_, tradableReason: "STALE" };
    expect((await call("get_prices")).out).toMatchObject({
      tradable: false,
      blockedBy: "ORACLE_STALE",
    });
    reader.market_ = { ...reader.market_, tradableReason: "POOL_DEVIATION", deviationBps: 250n };
    expect((await call("get_prices")).out).toMatchObject({
      poolDeviationBps: 250,
      blockedBy: "ORACLE_POOL_DEVIATION",
    });
  });

  it("quotes against the oracle and says whether the quote is inside the slippage limit", async () => {
    const { reader, call } = await start();
    const q = await call("get_quote", { sell: "USDC", buy: "WMON", amount: "5" });
    expect(q.out).toMatchObject({
      sell: { asset: "USDC", amount: "5" },
      oracleImpliedOut: { asset: "WMON", amount: "200" },
      slippageBps: 10,
      maxSlippageBps: 50,
      passesSlippageLimit: true,
    });
    reader.quoteBps = 9_900n; // 1% worse than the oracle
    const bad = await call("get_quote", { sell: "WMON", buy: "USDC", amount: "40" });
    expect(bad.out).toMatchObject({ slippageBps: 100, passesSlippageLimit: false });
    const decimals = await call("get_quote", { sell: "USDC", buy: "WMON", amount: "1.0000001" });
    expect(decimals).toMatchObject({ error: true, out: { code: "INVALID_INPUT" } });
  });

  it("reads the limits the Executor leaves room for", async () => {
    const { reader, call } = await start();
    reader.agents.set(1, agentState({ tradesLeft: 18, turnoverUsed: usdc(15n) }));
    const { out } = await call("get_limits");
    expect(out).toMatchObject({
      accountValueUsdc: { amount: "100" },
      maxTradeValueUsdc: { amount: "10" },
      wmonRoomBeforeCapUsdc: { amount: "10" },
      usdcAboveFloor: { amount: "60" },
      tradesLeft24h: 18,
      nextSlotFreesAt: null,
      turnoverLeftUsdc: { amount: "85" },
      sessionGrant: { registered: true, expired: false },
    });
  });

  it("tradable_now: a trade inside every limit is tradable", async () => {
    const { call } = await start();
    const r = TradableOutput.parse(
      (await call("tradable_now", { sell: "USDC", buy: "WMON", amount: "5" })).out,
    );
    expect(r).toMatchObject({ tradable: true, blockers: [] });
  });

  it("tradable_now: a stale price that reads as zero blocks only as ORACLE_STALE, never as an invalid intent", async () => {
    const { reader, call } = await start();
    reader.market_ = {
      ...reader.market_,
      monUsd: { priceE18: 0n, updatedAt: NOW - 400n, reason: "STALE" },
      tradableReason: "STALE",
    };
    const r = TradableOutput.parse(
      (await call("tradable_now", { sell: "USDC", buy: "WMON", amount: "1" })).out,
    );
    expect(r.blockers.map((b) => b.code)).toEqual(["ORACLE_STALE"]);
  });

  it("tradable_now: names every blocker at once, and when each clears", async () => {
    const { reader, call } = await start();
    const ages = Array.from({ length: 20 }, (_, k) => ({
      at: NOW - 3_600n + BigInt(k),
      valueUsdcE6: usdc(1n),
    }));
    reader.market_ = { ...reader.market_, tradableReason: "STALE" };
    reader.agents.set(1, agentState({ trades: ages, tradesLeft: 0 }));
    const r = TradableOutput.parse(
      (await call("tradable_now", { sell: "USDC", buy: "WMON", amount: "50" })).out,
    );
    const codes = r.blockers.map((b) => b.code);
    expect(r.tradable).toBe(false);
    expect(codes).toEqual(expect.arrayContaining(["ORACLE_STALE"]));
    // With the price unusable the value rules cannot be judged, so only what is known is listed.
    expect(codes).not.toContain("TRADE_SIZE_EXCEEDED");
    reader.market_ = { ...reader.market_, tradableReason: "OK" };
    const r2 = TradableOutput.parse(
      (await call("tradable_now", { sell: "USDC", buy: "WMON", amount: "50" })).out,
    );
    const byCode = Object.fromEntries(r2.blockers.map((b) => [b.code, b]));
    expect(Object.keys(byCode)).toEqual(
      expect.arrayContaining(["TRADE_SIZE_EXCEEDED", "DAILY_TRADE_LIMIT", "CONCENTRATION_CAP"]),
    );
    expect(byCode.DAILY_TRADE_LIMIT).toMatchObject({
      clears: "by_waiting",
      clearsAt: new Date(Number(NOW - 3_600n + 86_400n) * 1000).toISOString(),
    });
    expect(byCode.TRADE_SIZE_EXCEEDED).toMatchObject({ clears: "by_changing_the_trade" });
    for (const b of r2.blockers) expect(b.message.length).toBeGreaterThan(10);
  });

  it("tradable_now: reduce-only blocks buys but not sales; paused blocks both; no grant is the owner's to fix", async () => {
    const { reader, call } = await start();
    reader.agents.set(1, agentState({ mode: "REDUCE_ONLY" }));
    const buy = TradableOutput.parse(
      (await call("tradable_now", { sell: "USDC", buy: "WMON", amount: "5" })).out,
    );
    expect(buy.blockers.map((b) => b.code)).toEqual(["REDUCE_ONLY_MODE"]);
    expect(buy.blockers[0]?.clears).toBe("by_the_owner");
    const sale = TradableOutput.parse(
      (await call("tradable_now", { sell: "WMON", buy: "USDC", amount: "40" })).out,
    );
    expect(sale.tradable).toBe(true);
    reader.agents.set(1, agentState({ mode: "PAUSED" }));
    const paused = TradableOutput.parse(
      (await call("tradable_now", { sell: "WMON", buy: "USDC", amount: "40" })).out,
    );
    expect(paused.blockers.map((b) => b.code)).toEqual(["PAUSED"]);
    reader.agents.set(1, agentState({ grant: null }));
    const unarmed = TradableOutput.parse(
      (await call("tradable_now", { sell: "USDC", buy: "WMON", amount: "5" })).out,
    );
    expect(unarmed.blockers).toEqual([
      expect.objectContaining({ code: "SESSION_UNKNOWN", clears: "by_the_owner" }),
    ]);
    reader.agents.set(
      1,
      agentState({ grant: { key: KEY, ownerEpoch: 0n, configEpoch: 0n, validUntil: NOW - 1n } }),
    );
    const expired = TradableOutput.parse(
      (await call("tradable_now", { sell: "USDC", buy: "WMON", amount: "5" })).out,
    );
    expect(expired.blockers.map((b) => b.code)).toEqual(["SESSION_EXPIRED"]);
  });

  it("tradable_now: a quote under the oracle floor is SLIPPAGE_TOO_HIGH, and no quote is SIMULATION_FAILED", async () => {
    const { reader, call } = await start();
    reader.quoteBps = 9_940n;
    const r = TradableOutput.parse(
      (await call("tradable_now", { sell: "USDC", buy: "WMON", amount: "5" })).out,
    );
    expect(r.blockers.map((b) => b.code)).toEqual(["SLIPPAGE_TOO_HIGH"]);
    reader.quoteFails = true;
    const r2 = TradableOutput.parse(
      (await call("tradable_now", { sell: "USDC", buy: "WMON", amount: "5" })).out,
    );
    expect(r2.blockers.map((b) => b.code)).toEqual(["SIMULATION_FAILED"]);
  });

  it("the pre-check's first reason is the Executor's own, for each limit it can break", async () => {
    const reader = new FakeReader();
    const cases: [Partial<AgentState>, "USDC" | "WMON", bigint][] = [
      [{}, "USDC", usdc(11n)], // over 10%
      [{ mode: "REDUCE_ONLY" }, "USDC", usdc(5n)],
      [{ usdc: usdc(1n) }, "USDC", usdc(5n)], // more than held
      [{ wmon: wmonWorth(usdc(39n)) }, "USDC", usdc(5n)], // past the 40% cap
    ];
    for (const [over, sell, amount] of cases) {
      const a = agentState(over);
      const m = reader.market_;
      const pre = executorPreCheck(tradeNow(sell, amount, m), executorMarketOf(sell, a, m));
      const { blockersFor } = await import("./logic.ts");
      const all = blockersFor(sell, amount, a, m, { block: 1n, amountOut: 10n ** 30n }, KEY);
      expect(all[0]?.code, Object.keys(over).join(",") || "size").toBe(pre);
      expect(REJECTION_CODES).toContain(all[0]?.code);
    }
  });

  it("propose_swap: a passing swap becomes one intent awaiting approval, with no calldata", async () => {
    const { call, proposed } = await start();
    const args = {
      sell: "USDC",
      buy: "WMON",
      amount: "5",
      reason: "Buy a little WMON under the band.",
    };
    const first = IntentOutput.parse((await call("propose_swap", args)).out);
    expect(first).toMatchObject({
      status: "awaiting_approval",
      reasonCodes: [],
      duplicate: false,
      txHash: null,
    });
    expect(first.intentId).toMatch(/^intent-/);
    const text = JSON.stringify(first);
    for (const f of FORBIDDEN_INTENT_FIELDS) expect(text).not.toContain(`"${f}"`);
    expect(text).not.toMatch(/0x[0-9a-f]{8,}/i);
    // The same proposal again in this run is the same intent.
    const again = IntentOutput.parse((await call("propose_swap", args)).out);
    expect(again).toMatchObject({ intentId: first.intentId, duplicate: true });
    // A client request ID names a separate proposal.
    const named = IntentOutput.parse(
      (await call("propose_swap", { ...args, clientRequestId: "dca-1" })).out,
    );
    expect(named.intentId).not.toBe(first.intentId);
    expect(proposed).toEqual([first.intentId, named.intentId]);
  });

  it("propose_swap: a breaking swap returns every reason code and is never pending", async () => {
    const { reader, call, intents } = await start();
    reader.agents.set(1, agentState({ mode: "REDUCE_ONLY" }));
    const r = IntentOutput.parse(
      (await call("propose_swap", { sell: "USDC", buy: "WMON", amount: "20", reason: "big buy" }))
        .out,
    );
    expect(r.status).toBe("rejected");
    expect(r.reasonCodes).toEqual(["REDUCE_ONLY_MODE", "TRADE_SIZE_EXCEEDED", "CONCENTRATION_CAP"]);
    expect(intents.records.filter((x) => x.status === "awaiting_approval")).toHaveLength(0);
  });

  it("propose_swap: at most three intents wait at once, and a waiting intent expires", async () => {
    const { call, tick } = await start();
    const propose = (n: number) =>
      call("propose_swap", {
        sell: "USDC",
        buy: "WMON",
        amount: "1",
        reason: "dca",
        clientRequestId: `c${n}`,
      });
    for (const n of [1, 2, 3])
      expect((await propose(n)).out).toMatchObject({ status: "awaiting_approval" });
    expect(await propose(4)).toMatchObject({ error: true, out: { code: "RATE_LIMITED" } });
    const first = IntentOutput.parse((await propose(1)).out);
    tick(1_801);
    expect((await call("get_intent_status", { intentId: first.intentId })).out).toMatchObject({
      status: "expired",
    });
    expect((await propose(5)).out).toMatchObject({ status: "awaiting_approval" });
  });

  it("get_intent_status: an agent sees only its own intents", async () => {
    const { server, call } = await start();
    const mine = IntentOutput.parse(
      (await call("propose_swap", { sell: "USDC", buy: "WMON", amount: "1", reason: "x" })).out,
    );
    expect((await call("get_intent_status", { intentId: mine.intentId })).out).toMatchObject({
      intentId: mine.intentId,
    });
    const bob = await connectClient(server.url, BOB_TOKEN);
    const r = await bob.callTool({
      name: "get_intent_status",
      arguments: { intentId: mine.intentId },
    });
    expect(structured(r)).toMatchObject({ code: "INTENT_NOT_FOUND" });
    await bob.close();
  });

  it("identity comes only from the token: a forged agent header reads nothing of another agent", async () => {
    const { server, reader } = await start();
    const bob = await connectClient(server.url, BOB_TOKEN, {
      extra: { "x-agent-id": "1", "x-alpha-agent": "1" },
    });
    await bob.callTool({ name: "get_portfolio", arguments: {} });
    expect(reader.agentReads).toEqual([2]);
    // An identity field in the input is rejected, not used.
    const r = await bob.callTool({ name: "get_portfolio", arguments: { agentId: 1 } });
    expect(structured(r)).toMatchObject({ code: "INVALID_INPUT" });
    await bob.close();
    await expect(connectClient(server.url, "c".repeat(43))).rejects.toThrow();
  });

  it("answers UPSTREAM_UNAVAILABLE where the trading contracts are not deployed", async () => {
    const { call } = await start({ reader: null });
    expect(await call("get_prices")).toMatchObject({
      error: true,
      out: { code: "UPSTREAM_UNAVAILABLE", retryable: false },
    });
  });

  it("logs every call and rate limits the reads of one run", async () => {
    const log = new MemoryCallLog(3);
    const { call } = await start({ log });
    for (let i = 0; i < 3; i++) expect((await call("get_prices")).error).toBe(false);
    expect(await call("get_prices")).toMatchObject({ error: true, out: { code: "RATE_LIMITED" } });
    expect(log.calls.map((c) => c.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "refused",
    ]);
    expect(log.calls[0]?.summary).toMatchObject({ monUsd: "0.025", tradable: true });
  });
});
