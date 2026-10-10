import { randomBytes } from "node:crypto";
import {
  ViemChainReader,
  ViemChainReaderV3,
  contractsFor,
  contractsForV3,
} from "@alpha-agents/chain-tools";
import type { Db } from "@alpha-agents/db";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import {
  type TestFork,
  createTestPersonalAccountV3,
  fundTestPersonalAccountV3,
  refreshLocalFeeds,
  registerTestSessionGrant,
  revertToSnapshot,
  setMonBalance,
  startTestFork,
  takeSnapshot,
  testForkUpstream,
} from "@alpha-agents/devenv";
import { DEFAULT_GOAL_INPUT, addressEntry } from "@alpha-agents/domain";
import {
  TARGET_PORTFOLIO_ID,
  type TargetPortfolioParams,
  translateGoal,
} from "@alpha-agents/policy";
import { ERC20_ABI, LocalKeyProvider, Signer, ViemChainClient } from "@alpha-agents/signer";
import {
  DecisionStore,
  GoalStore,
  PlanStore,
  TradeStore,
  approveByOwner,
  confirmArming,
} from "@alpha-agents/trading";
import { type Hex, bytesToHex, createPublicClient, http, parseAbi } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TemplateRunner } from "./runner.ts";
import { Store } from "./store.ts";
import { PgIntentStore } from "./tools/chain-store.ts";
import { TradeFlow, swapGasCost } from "./trade-flow.ts";

/**
 * F-U6 on a fork of its own (D-200, port 8559) with the real stack and the
 * fund agent's set: the owner opens a PersonalAccountV3 with 90 USDC, sets a
 * target portfolio (WMON 20%, WBTC 20%, cash 60%) and arms the agent on
 * Executor v3; the runner then makes one capped leg a minute, each a v3
 * intent through the trade flow, the real signer, Executor v3 and the
 * registered pools, until every position sits inside its band; then the
 * guardian moves WBTC to sell-only and the runner sells it first. No model
 * is called anywhere. Skips without MONAD_RPC_URL or Postgres (as in CI).
 */
const PORT = 8559;
const upstream = testForkUpstream();
const dbUp = await databaseAvailable();
const SLOW = 900_000;
const CHAIN = 143143;
const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c" as Hex;
const GUARDIAN = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as Hex;
const REGISTRY_ABI = parseAbi(["function setSellOnly(address token)"]);
const book = (id: Parameters<typeof addressEntry>[1]) => addressEntry("local", id).address as Hex;

describe.skipIf(upstream === null || !dbUp)(
  "the runner on a target portfolio, on a real fork of the fund agent's set",
  { timeout: SLOW },
  () => {
    let fork: TestFork;
    let t: TestDatabase;
    let db: Db;
    let store: Store;
    let agentId: number;
    let account: Hex;
    let owner: Hex;
    let key: Hex;
    let signer: Signer;
    let trades: TradeStore;
    let plans: PlanStore;
    let decisions: DecisionStore;
    let goals: GoalStore;
    let reader: ViemChainReader;
    let readerV3: ViemChainReaderV3;
    let snapshot: string;
    let send: (from: Hex, request: unknown) => Promise<unknown>;
    let impersonate: (address: Hex) => Promise<void>;
    const previousPort = process.env.LOCAL_FORK_PORT;
    const seed = bytesToHex(randomBytes(32));
    const client = () => createPublicClient({ transport: http(fork.url) });
    const executorV3 = book("executor_v3");

    const gas = {
      balance: (address: Hex) => client().getBalance({ address }),
      swapCost: async (g?: bigint) => {
        const block = await client().getBlock();
        return swapGasCost(block.baseFeePerGas ?? 0n, 0n, g);
      },
      topUp: (address: Hex, wei: bigint) => setMonBalance(address, wei, fork.url),
    };
    const flow = () =>
      new TradeFlow({
        chainId: CHAIN,
        store: trades,
        reader,
        readerV3,
        signer,
        gas,
        finalizedBlock: async () => null,
        log: () => undefined,
      });
    const runner = () =>
      new TemplateRunner({
        chainId: CHAIN,
        reader,
        readerV3,
        plans,
        decisions,
        goals,
        trades,
        intents: new PgIntentStore(store),
        sessionKeyOf: (id) => signer.createKey(id),
        volatility24hPct: async () => 110,
        volatilityOf: null,
        // The platform's screens are not running here: the Test and the runner leave the question open.
        screenFresh: async () => null,
        gas,
        narrator: null,
        log: () => undefined,
      });

    const balance = (token: Hex) =>
      client().readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account],
      });

    const PLAN: TargetPortfolioParams = {
      positions: [
        {
          token: book("wmon").toLowerCase() as Hex,
          targetWeightBps: 2_000,
          bandBps: 300,
          thesisId: "t-wmon",
          exit: {
            killCriterion: "MON's staking yield collapses",
            recheckAt: "2026-11-01T00:00:00.000Z",
          },
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
      cashTargetBps: 6_000,
      minTradeUsdcE6: 500_000n,
      volatilityBrakeBps: 20_000,
      costHurdleBps: 100,
      maxLegBps: 1_000,
    };

    async function armV3() {
      await registerTestSessionGrant(fork.url, agentId, owner, key, 30, executorV3);
      const r = await confirmArming(trades, await readerV3.agent(agentId), {
        chainId: CHAIN,
        agentId,
        owner,
        fundingAddress: key,
        custody: "v3",
        executor: executorV3,
      });
      if (!r.ok) throw new Error(r.message);
      return r.record;
    }

    /** One runner tick, then the trade flow and the signer until the leg it proposed stops moving. */
    async function step() {
      const [d] = await runner().tick();
      if (!d) throw new Error("no decision");
      if (d.outcome !== "leg" || !d.intentId) return d;
      const f = flow();
      for (let i = 0; i < 80; i++) {
        await f.tick();
        await signer.tick();
        const s = (await trades.intent(CHAIN, agentId, d.intentId))?.status;
        if (s === "reconciled" || s === "rejected" || s === "failed" || s === "expired") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      return d;
    }

    beforeAll(async () => {
      process.env.LOCAL_FORK_PORT = String(PORT);
      fork = await startTestFork({ port: PORT });
      t = await createTestDatabase("runner_v2_fork");
      db = t.db;
      store = new Store(db);
      trades = new TradeStore(db);
      plans = new PlanStore(db);
      decisions = new DecisionStore(db);
      goals = new GoalStore(db);
      const { deployAccountFactoryLocal } = await import("../../../scripts/lib/account-factory.js");
      const { deployFundLocal } = await import("../../../scripts/lib/fund.js");
      const { deployExecutorV3Local } = await import("../../../scripts/lib/executor-v3.js");
      const custody = await import("../../../scripts/lib/custody.js");
      ({ send, impersonate } = (await import("../../../scripts/lib/agent-reveal.js")) as never);
      await deployAccountFactoryLocal({ quiet: true });
      const fund = await deployFundLocal({ quiet: true, skipScreens: true });
      await deployExecutorV3Local({ quiet: true, tokenRegistry: fund.tokenRegistry });
      await refreshLocalFeeds(fork.url);
      owner = custody.testOwner(6) as Hex;
      agentId = Number(await custody.ownersAgent(book("agent_nft"), owner));
      account = (await createTestPersonalAccountV3(fork.url, agentId, owner)) as Hex;
      await fundTestPersonalAccountV3(fork.url, agentId, owner, [
        { token: book("usdc"), usdcE6: 90_000_000n },
      ]);
      signer = new Signer({
        db,
        environment: "local",
        chain: new ViemChainClient({ chainId: CHAIN, primaryUrl: fork.url }),
        keys: new LocalKeyProvider(seed),
        executor: book("executor"),
        executorV3,
        assets: { [book("usdc").toLowerCase()]: "USDC", [book("wmon").toLowerCase()]: "WMON" },
        log: () => undefined,
        topUpGas: (address, wei) => setMonBalance(address, wei, fork.url),
      });
      await signer.start();
      key = await signer.createKey(agentId);
      const c = contractsFor("local");
      if (!c.ok) throw new Error(`missing ${c.missing.join(", ")}`);
      const c3 = contractsForV3("local");
      if (!c3.ok) throw new Error(`missing ${c3.missing.join(", ")}`);
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
      const g = translateGoal(DEFAULT_GOAL_INPUT);
      if (!g.ok) throw new Error("goal");
      await goals.save({
        chainId: CHAIN,
        agentId,
        ownerEpoch: 0n,
        savedBy: owner,
        config: g.config,
      });
    }, SLOW);

    afterAll(async () => {
      await t?.drop();
      await fork?.stop();
      if (previousPort === undefined) delete process.env.LOCAL_FORK_PORT;
      else process.env.LOCAL_FORK_PORT = previousPort;
    }, SLOW);

    beforeEach(async () => {
      snapshot = await takeSnapshot(fork.url);
      await refreshLocalFeeds(fork.url);
    });
    afterEach(async () => {
      await revertToSnapshot(snapshot, fork.url);
      for (const table of [
        "platform.intents",
        "platform.arming",
        "platform.runner_decisions",
        "platform.strategy_params",
        "platform.ledger_lines",
      ] as const)
        await db.deleteFrom(table).execute();
      await db.deleteFrom("platform.ledger_entries").execute();
      await db.deleteFrom("platform.signer_outbox").execute();
      // The plan bumped the epoch; the goal's state row goes back to READY for the next test.
      await db
        .updateTable("platform.agent_states")
        .set({ state: "READY" })
        .where("agent_id", "=", agentId)
        .execute();
    });

    it("reaches a two-position target through Executor v3, one capped leg at a time, then sits in band; then sells a token moved to sell-only first", async () => {
      await plans.set({
        chainId: CHAIN,
        agentId,
        template: TARGET_PORTFOLIO_ID,
        params: PLAN,
        setBy: "console",
      });
      const record = await armV3();
      expect(record.custody).toBe("v3");
      const usdc = book("usdc");
      const wmon = book("wmon");
      // The first leg waits for the owner's approval, which arms the agent (P2-U6), then legs run on their own.
      const first = await runner().tick();
      expect(first[0]).toMatchObject({ outcome: "leg", leg: { sell: "USDC", buy: "WMON" } });
      const approved = await approveByOwner(trades, CHAIN, agentId, first[0]?.intentId ?? "");
      expect(approved).toMatchObject({ ok: true });
      const f = flow();
      for (let i = 0; i < 80; i++) {
        await f.tick();
        await signer.tick();
        const s = (await trades.intent(CHAIN, agentId, first[0]?.intentId ?? ""))?.status;
        if (s === "reconciled" || s === "rejected" || s === "failed") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect((await trades.intent(CHAIN, agentId, first[0]?.intentId ?? ""))?.status).toBe(
        "reconciled",
      );
      // Each leg is at most 10% of the account (the plan's cap under the 12% hard limit).
      const legs: { sell: string; buy: string; valueUsdcE6: bigint }[] = [];
      let last = first[0];
      for (let i = 0; i < 12 && last?.code !== "IN_BAND"; i++) {
        last = await step();
        if (last.outcome === "leg" && last.leg)
          legs.push({
            sell: last.leg.sell,
            buy: last.leg.buy,
            valueUsdcE6: BigInt(last.leg.valueUsdcE6),
          });
      }
      expect(last?.code).toBe("IN_BAND");
      expect(legs.length).toBeGreaterThanOrEqual(2);
      for (const l of legs) expect(l.valueUsdcE6).toBeLessThanOrEqual(9_950_000n);
      expect(legs.every((l) => l.sell === "USDC")).toBe(true);
      expect(new Set(legs.map((l) => l.buy))).toEqual(new Set(["WMON", "WBTC"]));
      // Every leg settled as a v3 intent with its route through Executor v3.
      const settled = (await trades.intents(CHAIN, agentId, 50)).filter(
        (i) => i.source === "template",
      );
      expect(settled.every((i) => i.status === "reconciled" && i.custody === "v3")).toBe(true);
      expect(settled.some((i) => (i.route?.length ?? 0) === 2)).toBe(true);
      const positions = last?.facts.positions as { symbol: string; shareBps: number }[];
      for (const p of positions) {
        expect(Math.abs(p.shareBps - 2_000), p.symbol).toBeLessThanOrEqual(300);
      }
      expect(await balance(WBTC)).toBeGreaterThan(0n);
      expect(await balance(wmon)).toBeGreaterThan(0n);
      const cashBefore = await balance(usdc);

      // The guardian moves WBTC to sell-only: the runner sells it ahead of anything else.
      await impersonate(GUARDIAN);
      await setMonBalance(GUARDIAN, 10n ** 18n, fork.url);
      await send(GUARDIAN, {
        address: book("token_registry_v3"),
        abi: REGISTRY_ABI,
        functionName: "setSellOnly",
        args: [WBTC],
      });
      const exit = await step();
      expect(exit).toMatchObject({ outcome: "leg", leg: { sell: "WBTC", buy: "USDC" } });
      const sold = await trades.intent(CHAIN, agentId, exit.intentId ?? "");
      expect(sold?.status).toBe("reconciled");
      expect(await balance(usdc)).toBeGreaterThan(cashBefore);
      const why = await trades.whyNotTraded(CHAIN, agentId);
      expect(why).toBeTruthy();
    });
  },
);
