import type {
  AgentStateV3,
  ChainReader,
  ChainReaderV3,
  MarketStateV3,
  PoolInfoV3,
  RouteQuoteV3,
} from "@alpha-agents/chain-tools";
import { candidateRoutes } from "@alpha-agents/chain-tools";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { DEFAULT_GOAL_INPUT } from "@alpha-agents/domain";
import {
  TARGET_PORTFOLIO_ID,
  type TargetPortfolioParams,
  executorV3,
  translateGoal,
} from "@alpha-agents/policy";
import { DecisionStore, GoalStore, PlanStore, TradeStore } from "@alpha-agents/trading";
import { type Hex, getAddress } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type RunnerFacts, templateRunnerEntry } from "./narrator.ts";
import { TemplateRunner } from "./runner.ts";
import { Store } from "./store.ts";
import { CHAIN } from "./testing.ts";
import { PgIntentStore } from "./tools/chain-store.ts";

/**
 * The template runner on a target portfolio (F-U6, D-344), against Postgres
 * with the real stores and a fake fund agent's set the tests change field by
 * field: the first leg buys the most underweight position as a v3 intent
 * with its route, the next waits for it, a token the registry moved to
 * sell-only is sold first over two hops, a stale screen and a paused
 * Executor hold with their reasons, and the narrator gets the position.
 * No model is called anywhere.
 */
const dbUp = await databaseAvailable();
const NOW = 1_790_000_000n;
const E18 = 10n ** 18n;
const PX = 25_000_000_000_000_000n;
const PX_WBTC = 100_000n * E18;
const OWNER = getAddress("0x00000000000000000000000000000000000a11ce");
const KEY = getAddress("0x00000000000000000000000000000000000000ee");
const USDC = "0x00000000000000000000000000000000000000c1" as Hex;
const WMON = "0x00000000000000000000000000000000000000c2" as Hex;
const WBTC = "0x00000000000000000000000000000000000000c3" as Hex;
const EXECUTOR_V3 = getAddress("0x3443dbBd29E19CF17853732C260C6abDb6dC0658");
const ACCOUNT_V3 = "0x00000000000000000000000000000000000ac003" as Hex;

class FakeChainV3 implements ChainReaderV3 {
  readonly chainId = CHAIN;
  readonly executorAddress = EXECUTOR_V3;
  timestamp = NOW;
  paused = false;
  wbtcStatus: "BUYABLE" | "SELL_ONLY" | "FROZEN" = "BUYABLE";
  quoteBps = 9_990n;
  holdings: Record<string, bigint> = { [USDC]: 100_000_000n };

  private pool(id: string, a: Hex, b: Hex, venue: PoolInfoV3["venue"], fee: number): PoolInfoV3 {
    return {
      poolId: `0x${id.padStart(64, "0")}` as Hex,
      venue,
      tokenA: a,
      tokenB: b,
      currency0: a,
      currency1: b,
      fee,
      tickSpacing: 60,
      pool: `0x${id.padStart(40, "0")}` as Hex,
      lane: "CORE",
      status: "ACTIVE",
      codeIntact: true,
      pricedToken: b,
      deviationBps: 0n,
      priceReason: "OK",
    };
  }
  async market(): Promise<MarketStateV3> {
    const token = (t: Hex, symbol: string, decimals: number, status = "BUYABLE" as const) => ({
      token: t,
      symbol,
      decimals,
      lane: "CORE" as const,
      status: status as "BUYABLE" | "SELL_ONLY" | "FROZEN",
      priceClass: "F" as const,
      maxPositionBps: 4_000,
    });
    return {
      chainId: CHAIN,
      block: 500n,
      timestamp: this.timestamp,
      policy: { ...executorV3.LAUNCH_POLICY },
      policyHash: executorV3.LAUNCH_POLICY_HASH,
      paused: this.paused,
      adapterAllowed: true,
      attestorSet: false,
      usdc: USDC,
      wmon: WMON,
      tokens: [
        token(USDC, "USDC", 6),
        token(WMON, "WMON", 18),
        { ...token(WBTC, "WBTC", 8), status: this.wbtcStatus },
      ],
      prices: {
        [USDC]: { priceE18: E18, updatedAt: this.timestamp, reason: "OK" },
        [WMON]: { priceE18: PX, updatedAt: this.timestamp - 20n, reason: "OK" },
        [WBTC]: { priceE18: PX_WBTC, updatedAt: this.timestamp - 60n, reason: "OK" },
      },
      pools: [
        this.pool("1", USDC, WMON, "UNISWAP_V3", 3_000),
        this.pool("2", WMON, WBTC, "PANCAKESWAP_V3", 500),
      ],
    };
  }
  async agent(): Promise<AgentStateV3> {
    const dec: Record<string, number> = { [USDC]: 6, [WMON]: 18, [WBTC]: 8 };
    const px: Record<string, bigint> = { [USDC]: E18, [WMON]: PX, [WBTC]: PX_WBTC };
    const holdings = Object.entries(this.holdings)
      .filter(([, b]) => b > 0n)
      .map(([t, balance]) => ({
        token: t as Hex,
        decimals: dec[t] ?? 18,
        balance,
        free: balance,
        costBasis: (balance * (px[t] ?? E18)) / 10n ** BigInt((dec[t] ?? 18) + 12),
        lastPriceE18: px[t] ?? E18,
        lastPricedAt: this.timestamp,
      }));
    const nav = holdings.reduce((s, h) => s + h.costBasis, 0n);
    return {
      block: 500n,
      timestamp: this.timestamp,
      owner: OWNER,
      ownerEpoch: 1n,
      configEpoch: 0n,
      account: ACCOUNT_V3,
      v2Account: null,
      mode: "NORMAL",
      screenedOptIn: false,
      holdings,
      values: { nav, capped: nav, totalBasis: nav, classABasis: 0n },
      breaker: { nav, perUnit: E18, peak: E18, drawdownBps: 0n },
      grant: { key: KEY, ownerEpoch: 1n, configEpoch: 0n, validUntil: NOW + 20n * 86_400n },
      trades: [],
      tradesLeft: 20,
      nextSlotFreesAt: 0n,
      turnoverUsed: 0n,
    };
  }
  async custodyPath() {
    return "v3" as const;
  }
  private async along(
    route: readonly PoolInfoV3[],
    tokenIn: Hex,
    amountIn: bigint,
  ): Promise<RouteQuoteV3> {
    const m = await this.market();
    const px = (t: Hex) => (t === USDC ? E18 : (m.prices[t]?.priceE18 ?? 0n));
    const dec = (t: Hex) => m.tokens.find((x) => x.token === t)?.decimals ?? 18;
    const hops: RouteQuoteV3["hops"][number][] = [];
    let at = tokenIn;
    let amount = amountIn;
    for (const p of route) {
      const out = at === p.tokenA ? p.tokenB : p.tokenA;
      const implied =
        (((amount * px(at)) / 10n ** BigInt(dec(at))) * 10n ** BigInt(dec(out))) / px(out);
      const got = (implied * this.quoteBps) / 10_000n;
      hops.push({ poolId: p.poolId, tokenIn: at, tokenOut: out, amountIn: amount, amountOut: got });
      at = out;
      amount = got;
    }
    return { block: 500n, route, hops, amountOut: amount, candidates: 1 };
  }
  async bestRoute(
    tokenIn: Hex,
    tokenOut: Hex,
    amountIn: bigint,
    rules: { optedIn: boolean; intoUsdc: boolean; sellsScreened: boolean },
  ) {
    const [route] = candidateRoutes(await this.market(), tokenIn, tokenOut, rules);
    return route ? this.along(route, tokenIn, amountIn) : null;
  }
  async quoteRoute(route: readonly Hex[], tokenIn: Hex, amountIn: bigint) {
    const m = await this.market();
    return this.along(
      route.map((id) => m.pools.find((p) => p.poolId === id) as PoolInfoV3),
      tokenIn,
      amountIn,
    );
  }
}

const PLAN: TargetPortfolioParams = {
  positions: [
    {
      token: WMON,
      targetWeightBps: 3_000,
      bandBps: 300,
      thesisId: "t-wmon",
      exit: { killCriterion: "MON loses its staking yield", recheckAt: "2026-11-01T00:00:00.000Z" },
    },
    {
      token: WBTC,
      targetWeightBps: 2_000,
      bandBps: 300,
      thesisId: "t-wbtc",
      exit: {
        killCriterion: "The bridge's reserves fall short",
        recheckAt: "2026-11-01T00:00:00.000Z",
      },
    },
  ],
  cashTargetBps: 5_000,
  minTradeUsdcE6: 500_000n,
  volatilityBrakeBps: 20_000,
  costHurdleBps: 40,
  maxLegBps: 1_000,
};

describe.skipIf(!dbUp)(
  "the template runner on a target portfolio (needs Postgres)",
  { timeout: 60_000 },
  () => {
    let t: TestDatabase;
    let store: Store;
    let plans: PlanStore;
    let decisions: DecisionStore;
    let goals: GoalStore;
    let trades: TradeStore;
    let chain: FakeChainV3;
    let screens: Record<string, boolean | null>;
    let narrated: { key: string; facts: RunnerFacts }[];

    const v2 = {
      chainId: CHAIN,
      market: async () => {
        throw new Error("the v2 reader is not read on a portfolio plan");
      },
      agent: async () => {
        throw new Error("the v2 reader is not read on a portfolio plan");
      },
      quote: async () => {
        throw new Error("the v2 reader is not read on a portfolio plan");
      },
      tokenOf: () => USDC,
    } as unknown as ChainReader;

    const runner = () =>
      new TemplateRunner({
        chainId: CHAIN,
        reader: v2,
        readerV3: chain,
        plans,
        decisions,
        goals,
        trades,
        intents: new PgIntentStore(store),
        sessionKeyOf: async () => KEY,
        volatility24hPct: async () => 110,
        volatilityOf: async () => null,
        screenFresh: async (token) => screens[token.toLowerCase()] ?? null,
        gas: null,
        narrator: {
          narrateEvent: async (_c, _a, key, facts) => {
            narrated.push({ key, facts });
          },
        },
        log: () => undefined,
      });

    const goal = () => {
      const r = translateGoal(DEFAULT_GOAL_INPUT);
      if (!r.ok) throw new Error("goal");
      return r.config;
    };
    const saveGoal = () =>
      goals.save({ chainId: CHAIN, agentId: 1, ownerEpoch: 1n, savedBy: OWNER, config: goal() });
    const setPlan = (over: Partial<TargetPortfolioParams> = {}) =>
      plans.set({
        chainId: CHAIN,
        agentId: 1,
        template: TARGET_PORTFOLIO_ID,
        params: { ...PLAN, ...over },
        setBy: "console",
      });
    async function arm() {
      const { record } = await trades.startArming({
        chainId: CHAIN,
        agentId: 1,
        owner: OWNER,
        ownerEpoch: 1n,
        configEpoch: 0n,
        sessionKey: KEY,
        validUntil: NOW + 20n * 86_400n,
        custody: "v3",
        executor: EXECUTOR_V3,
      });
      await trades.markArmed(record.armingId, "intent-first");
    }
    const intents = () => trades.intents(CHAIN, 1, 50);
    const setStatus = (id: string, status: string) =>
      t.db
        .updateTable("platform.intents")
        .set({ status: status as never })
        .where("intent_id", "=", id)
        .execute();

    beforeAll(async () => {
      t = await createTestDatabase("orch_runner_v3");
      store = new Store(t.db);
      plans = new PlanStore(t.db);
      decisions = new DecisionStore(t.db);
      goals = new GoalStore(t.db);
      trades = new TradeStore(t.db);
    }, 60_000);
    afterAll(async () => {
      await t?.drop();
    }, 60_000);
    beforeEach(async () => {
      for (const table of [
        "platform.intents",
        "platform.arming",
        "platform.runner_decisions",
        "platform.strategy_params",
        "platform.agent_goals",
        "platform.agent_state_changes",
        "platform.agent_states",
      ] as const)
        await t.db.deleteFrom(table).execute();
      chain = new FakeChainV3();
      screens = { [USDC]: true, [WMON]: true, [WBTC]: true };
      narrated = [];
    });

    it("stores a target portfolio plan with its template, hash and epoch, and reads it back", async () => {
      await saveGoal();
      const plan = await setPlan();
      expect(plan.template).toBe("target_portfolio@1");
      expect(plan.params).toEqual(PLAN);
      expect((await plans.active(CHAIN, 1))?.params).toEqual(PLAN);
      expect((await goals.view(CHAIN, 1, 1n)).state).toBe("RUNNING");
    });

    it("from all cash: buys the most underweight position as a v3 intent with its route, waits for it, then buys the next, then sits in band", async () => {
      await saveGoal();
      const plan = await setPlan();
      await arm();
      const [first] = await runner().tick();
      expect(first).toMatchObject({
        outcome: "leg",
        leg: { sell: "USDC", buy: "WMON", amountIn: "9950000", sellToken: USDC, buyToken: WMON },
        strategyEpoch: plan.strategyEpoch,
      });
      const [i1] = await intents();
      expect(i1).toMatchObject({
        custody: "v3",
        sell: "USDC",
        buy: "WMON",
        // The store keeps addresses checksummed.
        sellToken: getAddress(USDC),
        buyToken: getAddress(WMON),
        amountIn: 9_950_000n,
        source: "template",
        status: "awaiting_approval",
        strategyEpoch: plan.strategyEpoch,
      });
      expect(i1?.route).toHaveLength(1);
      expect(i1?.reason).toContain("WMON");
      // The next tick waits for the leg.
      const [pending] = await runner().tick();
      expect(pending).toMatchObject({ outcome: "hold", code: "LEG_PENDING" });
      // Settled: the account holds the WMON; the next leg is WMON again (still 20 points under).
      await setStatus(i1?.intentId ?? "", "reconciled");
      chain.holdings = { [USDC]: 90_050_000n, [WMON]: (9_950_000n * 10n ** 30n) / PX };
      const [second] = await runner().tick();
      expect(second).toMatchObject({ outcome: "leg", leg: { buy: "WMON" } });
      // Once both positions sit inside their bands the runner holds IN_BAND with every position's share.
      await setStatus((await intents())[0]?.intentId ?? "", "reconciled");
      chain.holdings = {
        [USDC]: 50_000_000n,
        [WMON]: (30_000_000n * 10n ** 30n) / PX,
        [WBTC]: (20_000_000n * 10n ** 20n) / PX_WBTC,
      };
      const [band] = await runner().tick();
      expect(band).toMatchObject({ outcome: "hold", code: "IN_BAND" });
      const positions = band?.facts.positions as { symbol: string; shareBps: number }[];
      expect(positions.map((p) => [p.symbol, p.shareBps])).toEqual([
        ["WMON", 3_000],
        ["WBTC", 2_000],
      ]);
      expect(narrated.map((n) => n.facts.event)).toEqual(["leg", "leg", "in_band"]);
      const entry = templateRunnerEntry(narrated[0]?.facts as RunnerFacts);
      expect(entry).toContain("9.95 USDC for WMON");
      expect(entry).toContain("30% WMON target");
    });

    it("sells a token the registry moved to sell-only first, over two pools, ahead of any buy", async () => {
      await saveGoal();
      await setPlan();
      await arm();
      chain.holdings = { [USDC]: 60_000_000n, [WBTC]: (40_000_000n * 10n ** 20n) / PX_WBTC };
      chain.wbtcStatus = "SELL_ONLY";
      const [d] = await runner().tick();
      expect(d).toMatchObject({
        outcome: "leg",
        leg: { sell: "WBTC", buy: "USDC", position: WBTC },
      });
      const [i] = await intents();
      expect(i?.route).toHaveLength(2);
      expect(i?.reason).toContain("sells WBTC");
      expect(narrated[0]?.facts).toMatchObject({ event: "leg", asset: "WBTC", targetPercent: "0" });
    });

    it("holds with SCREEN_STALE when the position's token has no fresh passing screen, and names it", async () => {
      await saveGoal();
      await setPlan();
      await arm();
      screens[WMON] = false;
      screens[WBTC] = false;
      const [d] = await runner().tick();
      expect(d).toMatchObject({ outcome: "hold", code: "SCREEN_STALE" });
      expect(d?.facts.position).toBe(WMON);
      expect(await intents()).toEqual([]);
      expect(narrated[0]?.facts).toMatchObject({
        event: "hold",
        asset: "WMON",
        reason: { code: "SCREEN_STALE" },
      });
      // The platform not knowing is not a refusal: the buy goes ahead.
      screens[WMON] = null;
      const [again] = await runner().tick();
      expect(again).toMatchObject({ outcome: "leg", leg: { buy: "WMON" } });
    });

    it("holds with the Executor's reason when the pre-check refuses the leg, and proposes nothing", async () => {
      await saveGoal();
      await setPlan();
      await arm();
      chain.paused = true;
      const [d] = await runner().tick();
      expect(d).toMatchObject({ outcome: "hold", code: "PAUSED", codes: ["PAUSED"] });
      expect(await intents()).toEqual([]);
    });

    it("never reads the v2 set on a portfolio plan, and a plan set under an older goal never trades", async () => {
      await saveGoal();
      await setPlan();
      await arm();
      await saveGoal();
      const [d] = await runner().tick();
      expect(d).toMatchObject({ outcome: "hold", code: "STRATEGY_EPOCH_STALE" });
    });
  },
);
