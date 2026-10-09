import { randomBytes } from "node:crypto";
import { ViemChainReader, contractsFor } from "@alpha-agents/chain-tools";
import type { Db } from "@alpha-agents/db";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import {
  type TestFork,
  setMonBalance,
  startTestFork,
  testForkUpstream,
} from "@alpha-agents/devenv";
import { DEFAULT_GOAL_INPUT, addressEntry } from "@alpha-agents/domain";
import { translateGoal } from "@alpha-agents/policy";
import {
  EXECUTOR_ABI,
  ERC20_ABI,
  LocalKeyProvider,
  Signer,
  ViemChainClient,
} from "@alpha-agents/signer";
import {
  DecisionStore,
  GoalStore,
  PlanStore,
  TradeStore,
  approveByOwner,
  confirmArming,
} from "@alpha-agents/trading";
import { type Hex, bytesToHex, createPublicClient, http } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TemplateRunner } from "./runner.ts";
import { Store } from "./store.ts";
import { PgIntentStore } from "./tools/chain-store.ts";
import { TradeFlow, swapGasCost } from "./trade-flow.ts";

/**
 * P3-U3 on a fork of its own (port 8564, never the playtest fork on 8545)
 * with the real stack: an armed account at 0% WMON gets a rebalance_bands@1
 * plan for 20%; the owner's approval of the runner's first leg arms it; the
 * runner trades toward the target in sequential legs no larger than the
 * per-trade cap, each through the trade flow, the signer, the Executor and
 * the real Uniswap v4 MON/USDC pool, each settled before the next; then it
 * holds IN_BAND. Volatility is fixed (the brake has its own tests); every
 * other input is the fork's. Skips without MONAD_RPC_URL or Postgres.
 */
const PORT = 8564;
const upstream = testForkUpstream();
const dbUp = await databaseAvailable();
const SLOW = 600_000;
const CHAIN = 143143;
const book = (id: Parameters<typeof addressEntry>[1]) => addressEntry("local", id).address as Hex;

describe.skipIf(upstream === null || !dbUp)(
  "the template runner on a real fork",
  { timeout: SLOW },
  () => {
    let fork: TestFork;
    let t: TestDatabase;
    let db: Db;
    let agentId: number;
    let account: Hex;
    let owner: Hex;
    let key: Hex;
    let signer: Signer;
    let reader: ViemChainReader;
    let send: (from: Hex, request: unknown) => Promise<unknown>;
    let useFreshFeeds: () => Promise<unknown>;
    const previousPort = process.env.LOCAL_FORK_PORT;
    const seed = bytesToHex(randomBytes(32));
    const client = () => createPublicClient({ transport: http(fork.url) });

    beforeAll(async () => {
      process.env.LOCAL_FORK_PORT = String(PORT);
      fork = await startTestFork({ port: PORT });
      t = await createTestDatabase("runner_fork");
      db = t.db;
      const { deployAccountFactoryLocal } = await import("../../../scripts/lib/account-factory.js");
      const custody = await import("../../../scripts/lib/custody.js");
      const oracle = await import("../../../scripts/lib/oracle.js");
      ({ send } = (await import("../../../scripts/lib/agent-reveal.js")) as never);
      ({ useFreshFeeds } = oracle as never);
      await deployAccountFactoryLocal({ quiet: true });
      await useFreshFeeds();
      owner = custody.testOwner(6) as Hex;
      agentId = Number(await custody.ownersAgent(book("agent_nft"), owner));
      ({ account } = (await custody.ensureAccount(
        book("account_factory"),
        BigInt(agentId),
        owner,
      )) as {
        account: Hex;
      });
      await custody.depositUsdc(account, owner, 100_000_000n);
      signer = new Signer({
        db,
        environment: "local",
        chain: new ViemChainClient({ chainId: CHAIN, primaryUrl: fork.url }),
        keys: new LocalKeyProvider(seed),
        executor: book("executor"),
        assets: { [book("usdc").toLowerCase()]: "USDC", [book("wmon").toLowerCase()]: "WMON" },
        log: () => undefined,
        topUpGas: (address, wei) => setMonBalance(address, wei, fork.url),
      });
      await signer.start();
      key = await signer.createKey(agentId);
      const c = contractsFor("local");
      if (!c.ok) throw new Error(`missing ${c.missing.join(", ")}`);
      reader = new ViemChainReader({
        chainId: CHAIN,
        rpcUrl: fork.url,
        contracts: c.contracts,
        cacheMs: 0,
      });
    }, SLOW);

    afterAll(async () => {
      await t?.drop();
      await fork?.stop();
      if (previousPort === undefined) delete process.env.LOCAL_FORK_PORT;
      else process.env.LOCAL_FORK_PORT = previousPort;
    }, SLOW);

    it("rebalances 0% to 20% WMON in capped legs that settle on the real pool, then holds IN_BAND", async () => {
      const trades = new TradeStore(db);
      const goals = new GoalStore(db);
      const plans = new PlanStore(db);
      const decisions = new DecisionStore(db);
      const store = new Store(db);
      const a0 = await reader.agent(agentId);
      if (!a0) throw new Error("no agent");
      const translated = translateGoal(DEFAULT_GOAL_INPUT);
      if (!translated.ok) throw new Error("goal");
      await goals.save({
        chainId: CHAIN,
        agentId,
        ownerEpoch: a0.ownerEpoch,
        savedBy: owner,
        config: translated.config,
      });
      const plan = await plans.set({
        chainId: CHAIN,
        agentId,
        params: translated.config.template.params,
        setBy: "console",
      });
      expect(plan.params).toMatchObject({
        targetWmonBps: 2_000,
        bandHalfWidthBps: 500,
        maxLegBps: 1_000,
      });

      // The owner's grant to the funding address; arming waits for the first approval.
      const now = (await client().getBlock()).timestamp;
      await send(owner, {
        address: book("executor"),
        abi: EXECUTOR_ABI,
        functionName: "registerSession",
        args: [BigInt(agentId), key, now + 30n * 86_400n],
      });
      const armed = await confirmArming(trades, await reader.agent(agentId), {
        chainId: CHAIN,
        agentId,
        owner,
        fundingAddress: key,
      });
      if (!armed.ok) throw new Error(armed.message);

      const runner = new TemplateRunner({
        chainId: CHAIN,
        reader,
        plans,
        decisions,
        goals,
        trades,
        intents: new PgIntentStore(store),
        sessionKeyOf: async () => key,
        volatility24hPct: async () => 60,
        gas: null,
        log: () => undefined,
      });
      const flow = new TradeFlow({
        chainId: CHAIN,
        store: trades,
        reader,
        signer,
        gas: {
          balance: (address) => client().getBalance({ address }),
          swapCost: async () => swapGasCost((await client().getBlock()).baseFeePerGas ?? 0n, 0n),
          topUp: (address: Hex, wei: bigint) => setMonBalance(address, wei, fork.url),
        },
        finalizedBlock: async () => null,
        log: () => undefined,
      });
      const balanceOf = (token: Hex) =>
        client().readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account],
        });

      const legs: { amountIn: bigint; valueUsdcE6: bigint; navUsdcE6: bigint }[] = [];
      let final = null as Awaited<ReturnType<TemplateRunner["tick"]>>[number] | null;
      for (let round = 0; round < 6; round += 1) {
        await useFreshFeeds();
        const [d] = await runner.tick();
        if (!d) throw new Error("the runner made no decision");
        if (d.outcome === "hold") {
          final = d;
          break;
        }
        expect(d.leg?.sell).toBe("USDC");
        const nav = BigInt(String(d.facts.totalValueUsdcE6));
        legs.push({
          amountIn: BigInt(d.leg?.amountIn ?? 0),
          valueUsdcE6: BigInt(d.leg?.valueUsdcE6 ?? 0),
          navUsdcE6: nav,
        });
        const intentId = d.intentId ?? "";
        const intent = await trades.intent(CHAIN, agentId, intentId);
        expect(intent).toMatchObject({ source: "template", strategyEpoch: plan.strategyEpoch });
        // The owner approves the runner's first leg, which arms the agent; later legs go on their own.
        if (round === 0)
          expect(await approveByOwner(trades, CHAIN, agentId, intentId)).toMatchObject({
            ok: true,
          });
        // While the leg is on its way the runner waits.
        expect((await runner.tick())[0]).toMatchObject({ code: "LEG_PENDING" });
        for (let i = 0; i < 80; i += 1) {
          await flow.tick();
          await signer.tick();
          const s = (await trades.intent(CHAIN, agentId, intentId))?.status;
          if (s === "reconciled" || s === "failed" || s === "rejected" || s === "expired") break;
          await new Promise((r) => setTimeout(r, 200));
        }
        const done = await trades.intent(CHAIN, agentId, intentId);
        expect(done, `leg ${round}: ${done?.failure ?? ""}`).toMatchObject({
          status: "reconciled",
          approvedBy: round === 0 ? "owner" : "auto",
        });
      }

      if (process.env.RUNNER_FORK_REPORT)
        console.info(
          JSON.stringify({
            legs: legs.map((l) => ({
              usdcIn: l.amountIn.toString(),
              navUsdcE6: l.navUsdcE6.toString(),
            })),
            final: { code: final?.code, wmonShareBps: final?.facts.wmonShareBps },
          }),
        );
      // Sequential legs, each within the per-trade cap (10% of the account's value).
      expect(legs.length).toBeGreaterThanOrEqual(2);
      for (const l of legs)
        expect(l.valueUsdcE6 * 10_000n).toBeLessThanOrEqual(l.navUsdcE6 * 1_000n);
      expect(final).toMatchObject({ outcome: "hold", code: "IN_BAND" });
      const share = Number(final?.facts.wmonShareBps);
      expect(share).toBeGreaterThanOrEqual(1_500);
      expect(share).toBeLessThanOrEqual(2_500);
      // The account really holds the WMON the legs bought.
      expect(await balanceOf(book("wmon"))).toBeGreaterThan(0n);
      expect(await balanceOf(book("usdc"))).toBe(
        100_000_000n - legs.reduce((s, l) => s + l.amountIn, 0n),
      );
      // Every leg executed on chain and settled; no model, no sandbox lease.
      const rows = await db
        .selectFrom("platform.intents")
        .selectAll()
        .where("agent_id", "=", agentId)
        .execute();
      expect(
        rows.every((r) => r.source === "template" && r.lease_id.startsWith("template-runner:")),
      ).toBe(true);
      expect(await db.selectFrom("platform.sandbox_leases").selectAll().execute()).toEqual([]);
    });
  },
);
