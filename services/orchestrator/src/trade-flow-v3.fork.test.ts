import { randomBytes, randomUUID } from "node:crypto";
import {
  ViemChainReader,
  ViemChainReaderV3,
  contractsFor,
  contractsForV3,
  resolveToken,
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
import { addressEntry, executorV3SwapGasLimit } from "@alpha-agents/domain";
import { ERC20_ABI, LocalKeyProvider, Signer, ViemChainClient } from "@alpha-agents/signer";
import { TradeStore, approveByOwner, confirmArming } from "@alpha-agents/trading";
import { type Hex, bytesToHex, createPublicClient, http, isAddressEqual } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TradeFlow, swapGasCost } from "./trade-flow.ts";

/**
 * F-U5 on a fork of its own (D-200, port 8558) with the real stack and the
 * fund agent's set: the owner opens a PersonalAccountV3, funds it with three
 * tokens, registers the grant on Executor v3 and approves the first trade; the
 * trade flow sends a one-hop swap and a two-hop swap through the real signer,
 * Executor v3 and the registered pools, with the route's gas limit, and
 * settles each only after the signer reconciled every token the route
 * touched; a proposal over the limits is refused with its reason, nothing is
 * sent, and why-not-traded names it; and an agent with only a v2 account on
 * the same stack still trades through the v2 Executor (D-367). Skips without
 * MONAD_RPC_URL or Postgres (as in CI).
 */
const PORT = 8558;
const upstream = testForkUpstream();
const dbUp = await databaseAvailable();
const SLOW = 900_000;
const CHAIN = 143143;
const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c" as Hex;
const book = (id: Parameters<typeof addressEntry>[1]) => addressEntry("local", id).address as Hex;

describe.skipIf(upstream === null || !dbUp)(
  "the v3 trade flow on a real fork of the fund agent's set",
  { timeout: SLOW },
  () => {
    let fork: TestFork;
    let t: TestDatabase;
    let db: Db;
    let agentId: number;
    let account: Hex;
    let owner: Hex;
    let v2AgentId: number;
    let v2Account: Hex;
    let v2Owner: Hex;
    let key: Hex;
    let keyV2: Hex;
    let signer: Signer;
    let trades: TradeStore;
    let reader: ViemChainReader;
    let readerV3: ViemChainReaderV3;
    let snapshot: string;
    let topUp = true;
    const previousPort = process.env.LOCAL_FORK_PORT;
    const seed = bytesToHex(randomBytes(32));
    const client = () => createPublicClient({ transport: http(fork.url) });
    const executor = book("executor");
    const executorV3 = book("executor_v3");

    const flow = () =>
      new TradeFlow({
        chainId: CHAIN,
        store: trades,
        reader,
        readerV3,
        signer,
        gas: {
          balance: (address) => client().getBalance({ address }),
          swapCost: async (gas) => {
            const block = await client().getBlock();
            return swapGasCost(block.baseFeePerGas ?? 0n, 0n, gas);
          },
          ...(topUp
            ? { topUp: (address: Hex, wei: bigint) => setMonBalance(address, wei, fork.url) }
            : {}),
        },
        finalizedBlock: async () => null,
        log: () => undefined,
      });

    const balance = (token: Hex, of: Hex = account) =>
      client().readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [of],
      });

    /** The owner registers the grant on Executor v3 and the platform records the arming for the v3 set. */
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

    async function armV2() {
      await registerTestSessionGrant(fork.url, v2AgentId, v2Owner, keyV2, 30);
      const r = await confirmArming(trades, await reader.agent(v2AgentId), {
        chainId: CHAIN,
        agentId: v2AgentId,
        owner: v2Owner,
        fundingAddress: keyV2,
      });
      if (!r.ok) throw new Error(r.message);
      return r.record;
    }

    /** A v3 proposal as propose_swap stores a passing one: both tokens, the quoted route, the chain's epochs. */
    async function proposeV3(sellRef: string, buyRef: string, amountIn: bigint) {
      const [m, a] = await Promise.all([readerV3.market(), readerV3.agent(agentId)]);
      if (!a) throw new Error("no agent");
      const sell = resolveToken(m, sellRef);
      const buy = resolveToken(m, buyRef);
      const quote = await readerV3.bestRoute(sell.token, buy.token, amountIn, {
        optedIn: a.screenedOptIn,
        intoUsdc: isAddressEqual(buy.token, m.usdc),
        sellsScreened: sell.lane === "SCREENED",
      });
      const id = `intent-${randomUUID()}`;
      await db
        .insertInto("platform.intents")
        .values({
          intent_id: id,
          chain_id: CHAIN,
          agent_id: agentId,
          lease_id: "fork-lease",
          kind: "swap",
          account: account.toLowerCase(),
          custody: "v3",
          sell: sell.symbol,
          buy: buy.symbol,
          sell_token: sell.token.toLowerCase(),
          buy_token: buy.token.toLowerCase(),
          route: JSON.stringify(quote?.route.map((p) => p.poolId) ?? []),
          amount_in: amountIn.toString(),
          reason: "fork test",
          idempotency_key: id,
          status: "awaiting_approval",
          reason_codes: "[]",
          checks: JSON.stringify({
            custody: "v3",
            sellDecimals: sell.decimals,
            buyDecimals: buy.decimals,
            hops: quote?.route.length ?? 0,
          }),
          owner_epoch: String(a.ownerEpoch),
          config_epoch: String(a.configEpoch),
          expires_at: new Date(Date.now() + 1_800_000),
        })
        .execute();
      return { id, hops: quote?.route.length ?? 0, sell, buy };
    }

    async function proposeV2(amountIn: bigint) {
      const a = await reader.agent(v2AgentId);
      const id = `intent-${randomUUID()}`;
      await db
        .insertInto("platform.intents")
        .values({
          intent_id: id,
          chain_id: CHAIN,
          agent_id: v2AgentId,
          lease_id: "fork-lease",
          kind: "swap",
          account: v2Account.toLowerCase(),
          sell: "USDC",
          buy: "WMON",
          amount_in: amountIn.toString(),
          reason: "fork test",
          idempotency_key: id,
          status: "awaiting_approval",
          reason_codes: "[]",
          checks: "{}",
          owner_epoch: String(a?.ownerEpoch ?? 0n),
          config_epoch: String(a?.configEpoch ?? 0n),
          expires_at: new Date(Date.now() + 1_800_000),
        })
        .execute();
      return id;
    }

    /** Runs the trade flow and the signer until the intent stops moving. */
    async function run(f: TradeFlow, id: number, intentId: string) {
      for (let i = 0; i < 80; i++) {
        await f.tick();
        await signer.tick();
        const s = (await trades.intent(CHAIN, id, intentId))?.status;
        if (s === "reconciled" || s === "rejected" || s === "failed" || s === "expired") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      return trades.intent(CHAIN, id, intentId);
    }

    const outboxRow = (txId: string) =>
      db
        .selectFrom("platform.signer_outbox")
        .selectAll()
        .where("tx_id", "=", txId)
        .executeTakeFirstOrThrow();

    beforeAll(async () => {
      process.env.LOCAL_FORK_PORT = String(PORT);
      fork = await startTestFork({ port: PORT });
      t = await createTestDatabase("trade_flow_v3_fork");
      db = t.db;
      trades = new TradeStore(db);
      const { deployAccountFactoryLocal } = await import("../../../scripts/lib/account-factory.js");
      const { deployFundLocal } = await import("../../../scripts/lib/fund.js");
      const { deployExecutorV3Local } = await import("../../../scripts/lib/executor-v3.js");
      const custody = await import("../../../scripts/lib/custody.js");
      await deployAccountFactoryLocal({ quiet: true });
      const fund = await deployFundLocal({ quiet: true, skipScreens: true });
      await deployExecutorV3Local({ quiet: true, tokenRegistry: fund.tokenRegistry });
      await refreshLocalFeeds(fork.url);
      owner = custody.testOwner(6) as Hex;
      agentId = Number(await custody.ownersAgent(book("agent_nft"), owner));
      account = (await createTestPersonalAccountV3(fork.url, agentId, owner)) as Hex;
      await fundTestPersonalAccountV3(fork.url, agentId, owner, [
        { token: book("usdc"), usdcE6: 40_000_000n },
        { token: book("wmon"), usdcE6: 25_000_000n },
        { token: WBTC, usdcE6: 20_000_000n },
      ]);
      v2Owner = custody.testOwner(7) as Hex;
      v2AgentId = Number(await custody.ownersAgent(book("agent_nft"), v2Owner));
      ({ account: v2Account } = (await custody.ensureAccount(
        book("account_factory"),
        BigInt(v2AgentId),
        v2Owner,
      )) as { account: Hex });
      await custody.depositUsdc(v2Account, v2Owner, 60_000_000n);
      signer = new Signer({
        db,
        environment: "local",
        chain: new ViemChainClient({ chainId: CHAIN, primaryUrl: fork.url }),
        keys: new LocalKeyProvider(seed),
        executor,
        executorV3,
        assets: { [book("usdc").toLowerCase()]: "USDC", [book("wmon").toLowerCase()]: "WMON" },
        log: () => undefined,
        topUpGas: (address, wei) => setMonBalance(address, wei, fork.url),
      });
      await signer.start();
      key = await signer.createKey(agentId);
      keyV2 = await signer.createKey(v2AgentId);
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
    }, SLOW);

    afterAll(async () => {
      await t?.drop();
      await fork?.stop();
      if (previousPort === undefined) delete process.env.LOCAL_FORK_PORT;
      else process.env.LOCAL_FORK_PORT = previousPort;
    }, SLOW);

    beforeEach(async () => {
      snapshot = await takeSnapshot(fork.url);
      topUp = true;
      await refreshLocalFeeds(fork.url);
    });
    afterEach(async () => {
      await revertToSnapshot(snapshot, fork.url);
      for (const table of ["platform.intents", "platform.arming", "platform.ledger_lines"] as const)
        await db.deleteFrom(table).execute();
      await db.deleteFrom("platform.ledger_entries").execute();
      // The signer realigns its nonce to the fork's after a revert (it does after a reset).
      await db.deleteFrom("platform.signer_outbox").execute();
    });

    it("settles a one-hop and a two-hop swap through Executor v3 after reconciling every token the route touched", async () => {
      expect(await readerV3.custodyPath(agentId)).toBe("v3");
      const f = flow();
      // One hop: USDC for WMON on a registered pool, armed by the owner's first approval.
      const first = await proposeV3("USDC", "WMON", 5_000_000n);
      expect(first.hops).toBe(1);
      await f.tick();
      expect((await trades.intent(CHAIN, agentId, first.id))?.status).toBe("awaiting_approval");
      const record = await armV3();
      expect(record).toMatchObject({ status: "awaiting_first_trade", custody: "v3" });
      expect(record.executor?.toLowerCase()).toBe(executorV3.toLowerCase());
      const approved = await approveByOwner(trades, CHAIN, agentId, first.id);
      expect(approved).toMatchObject({ ok: true, armed: { status: "armed" } });
      const usdcBefore = await balance(book("usdc"));
      const wmonBefore = await balance(book("wmon"));
      const done = await run(f, agentId, first.id);
      expect(done?.status).toBe("reconciled");
      expect(done?.custody).toBe("v3");
      expect(done?.amountOut).toBeGreaterThan(0n);
      expect(done?.amountOut).toBeGreaterThanOrEqual(done?.minAmountOut ?? 0n);
      expect(await balance(book("usdc"))).toBe(usdcBefore - 5_000_000n);
      expect(await balance(book("wmon"))).toBe(wmonBefore + (done?.amountOut ?? 0n));
      const tx = await outboxRow(done?.txId ?? "");
      expect(tx).toMatchObject({ status: "reconciled", tx_hash: done?.txHash });
      // The signed transaction carried the route's gas limit: one hop, three tokens held after.
      expect(BigInt(tx.gas_limit ?? "0")).toBe(executorV3SwapGasLimit(1, 3));
      expect(String((tx.request as { to?: string }).to).toLowerCase()).toBe(
        executorV3.toLowerCase(),
      );
      const balances = (tx.balances ?? {}) as Record<string, { before: string; after: string }>;
      expect(Object.keys(balances).sort()).toEqual(
        [book("usdc").toLowerCase(), book("wmon").toLowerCase()].sort(),
      );
      expect(tx.ledger_entry_id).not.toBeNull();
      const lines = await db
        .selectFrom("platform.ledger_lines")
        .select(["account", "asset", "amount"])
        .where("entry_id", "=", tx.ledger_entry_id ?? "")
        .execute();
      expect(lines).toEqual(
        expect.arrayContaining([
          { account: "personal_account", asset: "USDC", amount: "-5000000" },
          { account: "personal_account", asset: "WMON", amount: String(done?.amountOut) },
        ]),
      );

      // Two hops: USDC for WBTC through MON, chosen by the quotes, sent on its own now the agent is armed.
      await refreshLocalFeeds(fork.url);
      const second = await proposeV3("USDC", "WBTC", 5_000_000n);
      expect(second.hops).toBe(2);
      const wbtcBefore = await balance(WBTC);
      const wmonMid = await balance(book("wmon"));
      const auto = await run(f, agentId, second.id);
      expect(auto).toMatchObject({ status: "reconciled", approvedBy: "auto", custody: "v3" });
      expect(auto?.route).toHaveLength(2);
      expect(await balance(WBTC)).toBe(wbtcBefore + (auto?.amountOut ?? 0n));
      // The route crossed WMON (or native MON) without leaving any of it in the account.
      expect(await balance(book("wmon"))).toBe(wmonMid);
      const tx2 = await outboxRow(auto?.txId ?? "");
      expect(BigInt(tx2.gas_limit ?? "0")).toBe(executorV3SwapGasLimit(2, 3));
      const balances2 = (tx2.balances ?? {}) as Record<string, { before: string; after: string }>;
      expect(Object.keys(balances2)).toHaveLength(3);
      expect(balances2[WBTC]).toEqual({
        before: wbtcBefore.toString(),
        after: (wbtcBefore + (auto?.amountOut ?? 0n)).toString(),
      });
      expect(balances2[book("wmon").toLowerCase()]?.before).toBe(
        balances2[book("wmon").toLowerCase()]?.after,
      );
      expect(tx2.ledger_entry_id).not.toBeNull();
      const lines2 = await db
        .selectFrom("platform.ledger_lines")
        .select(["account", "asset", "amount"])
        .where("entry_id", "=", tx2.ledger_entry_id ?? "")
        .execute();
      // WBTC has no asset ID in the signer's map, so the ledger names it by address.
      expect(lines2).toEqual(
        expect.arrayContaining([
          { account: "personal_account", asset: "USDC", amount: "-5000000" },
          { account: "personal_account", asset: WBTC, amount: String(auto?.amountOut) },
        ]),
      );
    });

    it("refuses at submission a v3 proposal over the limits and one with no MON for gas, sends nothing, and why-not-traded names both", async () => {
      await armV3();
      const [r] = await trades.openArmings(CHAIN);
      if (r) await trades.markArmed(r.armingId, "first");
      const big = await proposeV3("USDC", "WBTC", 20_000_000n); // over 12% of the 85 USDC account
      const blocked = await run(flow(), agentId, big.id);
      expect(blocked?.status).toBe("rejected");
      expect(blocked?.reasonCodes).toContain("TRADE_SIZE_EXCEEDED");
      topUp = false;
      await setMonBalance(key, 0n, fork.url);
      const dry = await proposeV3("USDC", "WMON", 1_000_000n);
      const noGas = await run(flow(), agentId, dry.id);
      expect(noGas?.reasonCodes).toEqual(["GAS_UNFUNDED"]);
      const sent = await db.selectFrom("platform.signer_outbox").select("tx_id").execute();
      expect(sent).toHaveLength(0);
      const why = await trades.whyNotTraded(CHAIN, agentId);
      expect(why.reasons.map((x) => x.code)).toEqual(
        expect.arrayContaining(["TRADE_SIZE_EXCEEDED", "GAS_UNFUNDED"]),
      );
    });

    it("keeps an agent with only a v2 account trading through the v2 Executor on the same stack (D-367)", async () => {
      expect(await readerV3.custodyPath(v2AgentId)).toBe("v2");
      const f = flow();
      const id = await proposeV2(5_000_000n);
      const record = await armV2();
      expect(record).toMatchObject({
        status: "awaiting_first_trade",
        custody: "v2",
        executor: null,
      });
      expect(await approveByOwner(trades, CHAIN, v2AgentId, id)).toMatchObject({ ok: true });
      const wmonBefore = await balance(book("wmon"), v2Account);
      const done = await run(f, v2AgentId, id);
      expect(done).toMatchObject({ status: "reconciled", custody: "v2" });
      expect(await balance(book("wmon"), v2Account)).toBe(wmonBefore + (done?.amountOut ?? 0n));
      const tx = await outboxRow(done?.txId ?? "");
      expect(String((tx.request as { to?: string }).to).toLowerCase()).toBe(executor.toLowerCase());
    });
  },
);
