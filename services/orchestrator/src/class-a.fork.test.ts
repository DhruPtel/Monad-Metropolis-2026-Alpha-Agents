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
  sendAs,
  setMonBalance,
  startTestFork,
  takeSnapshot,
  testForkUpstream,
} from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import { ERC20_ABI, LocalKeyProvider, Signer, ViemChainClient } from "@alpha-agents/signer";
import { TradeStore, approveByOwner, confirmArming } from "@alpha-agents/trading";
import {
  type Hex,
  bytesToHex,
  createPublicClient,
  encodeFunctionData,
  http,
  isAddressEqual,
  parseAbi,
  zeroAddress,
} from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Attestor, type PriceSource, attestorKeyFrom, localAttestorKey } from "./attestor.ts";
import { fixedSource, poolQuoteSource } from "./attestor-sources.ts";
import { withAttestedPrices } from "./attested-reader.ts";
import { Registrar, localScreenerKey, viemScreenerChain } from "./tokens/registrar.ts";
import type { PoolRow, ScreenRecord, TokenStore } from "./tokens/store.ts";
import { TradeFlow, swapGasCost } from "./trade-flow.ts";

/**
 * Class A live, on a fork of its own (F-U12, port 8565): the attestation
 * verifier set in the TokenRegistry through its own timelock on the fork's
 * clock; GHO, a real class A token with a hookless Uniswap v4 pool against
 * USDC, registered in the screened lane by the registrar on the screener key
 * after a passing screen, with its pool; the owner's onchain opt-in; a buy
 * through Executor v3 with the attestor's price (the pool quoted both ways
 * and a second source agreeing), within the 1% class A slippage limit; the
 * 15% class A position cap on cost basis, holding with the right price and
 * with a wrong one; a price below the market refused as slippage; the
 * attestor refusing to sign when its sources disagree, so nothing is sent;
 * and a refused re-screen moving the token to sell-only, after which the
 * account can sell it and not buy it. Skips without MONAD_RPC_URL or
 * Postgres (as in CI).
 */
const PORT = 8565;
const upstream = testForkUpstream();
const dbUp = await databaseAvailable();
const SLOW = 900_000;
const CHAIN = 143143;
const E18 = 10n ** 18n;
/** GHO on Monad: class A (no Chainlink feed), a 3.9M USD hookless v4 pool against USDC, fee 100, tick spacing 1. */
const GHO = "0xfc421ad3c883bf9e7c4f42de845c4e4405799e73" as Hex;
const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c" as Hex;
const book = (id: Parameters<typeof addressEntry>[1]) => addressEntry("local", id).address as Hex;
const ACCOUNT_ABI = parseAbi(["function setScreenedOptIn(bool optIn)"]);

const screenRecord = (verdict: "passed" | "refused"): ScreenRecord => ({
  screenId: `screen-${verdict}`,
  chainId: CHAIN,
  address: GHO,
  verdict,
  checks: [],
  route: null,
  forkBlock: 1,
  requestedBy: "fork test",
  durationMs: 1,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString(),
});

describe.skipIf(upstream === null || !dbUp)(
  "class A trading on a real fork: the verifier, the screened lane, the opt-in, the caps",
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
    let trades: TradeStore;
    let reader: ViemChainReader;
    let readerV3: ViemChainReaderV3;
    let verifier: Hex;
    let tokenRegistry: Hex;
    let protocolRegistry: Hex;
    let snapshot: string;
    const previousPort = process.env.LOCAL_FORK_PORT;
    const seed = bytesToHex(randomBytes(32));
    const client = () => createPublicClient({ transport: http(fork.url) });
    const executor = book("executor");
    const executorV3 = book("executor_v3");
    const mirrored: string[] = [];
    /** The attestor's clock is the fork's: its latest block, plus the wall clock since. */
    const clock = { offsetMs: 0 };
    const syncClock = async () => {
      const block = await client().getBlock();
      clock.offsetMs = Number(block.timestamp) * 1000 - Date.now();
    };
    const now = () => new Date(Date.now() + clock.offsetMs);

    const attestorWith = (sources: PriceSource[]) =>
      new Attestor({
        chainId: CHAIN,
        verifier: async () => verifier,
        key: attestorKeyFrom(localAttestorKey()),
        sources,
        now,
        log: () => undefined,
      });
    const fixed = (name: string, priceE18: bigint) => fixedSource(name, { [GHO]: priceE18 });

    const flow = (attestor: Attestor | null) =>
      new TradeFlow({
        chainId: CHAIN,
        store: trades,
        reader,
        // The flow reads the market with the attestor's prices laid over it, as the orchestrator does.
        readerV3: attestor ? withAttestedPrices(readerV3, attestor) : readerV3,
        signer,
        gas: {
          balance: (address) => client().getBalance({ address }),
          swapCost: async (gas) => {
            const block = await client().getBlock();
            return swapGasCost(block.baseFeePerGas ?? 0n, 0n, gas);
          },
          topUp: (address: Hex, wei: bigint) => setMonBalance(address, wei, fork.url),
        },
        finalizedBlock: async () => null,
        ...(attestor ? { attestor } : {}),
        log: () => undefined,
      });

    const balance = (token: Hex, of: Hex = account) =>
      client().readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [of],
      });

    const registrar = () =>
      new Registrar({
        chainId: CHAIN,
        store: {
          setRegistry: async (
            _c: number,
            a: string,
            lane: string | null,
            status: string | null,
          ) => {
            mirrored.push(`${a.toLowerCase()} ${lane} ${status}`);
          },
        } as unknown as TokenStore,
        chain: viemScreenerChain({
          rpcUrl: fork.url,
          chainId: CHAIN,
          privateKey: localScreenerKey(),
          tokenRegistry,
          protocolRegistry,
        }),
        reader: readerV3,
        log: () => undefined,
      });

    /** GHO's pool as discovery records it: a hookless v4 pool against USDC. */
    const ghoPool = (): PoolRow => ({
      poolId: zeroAddress,
      dex: "uniswap_v4",
      token0: book("usdc"),
      token1: GHO,
      fee: 100,
      tickSpacing: 1,
      hooks: null,
      routable: true,
      routeNote: "Hookless Uniswap v4 pool, fee 100, tick spacing 1",
      liquidityUsd: 3_900_000,
      volume24hUsd: 0,
      createdAt: null,
      firstSeenAt: new Date().toISOString(),
    });

    const ghoOnChain = async () => {
      const m = await readerV3.market();
      return m.tokens.find((x) => isAddressEqual(x.token, GHO)) ?? null;
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

    /** A v3 proposal as propose_swap stores a passing one: both tokens, the quoted route, the chain's epochs. */
    async function propose(sellRef: string, buyRef: string, amountIn: bigint) {
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
      return { id, hops: quote?.route.length ?? 0 };
    }

    /** Runs the trade flow and the signer until the intent stops moving, the clock following the fork. */
    async function run(f: TradeFlow, intentId: string) {
      for (let i = 0; i < 80; i++) {
        await syncClock();
        await f.tick();
        await signer.tick();
        const s = (await trades.intent(CHAIN, agentId, intentId))?.status;
        if (s === "reconciled" || s === "rejected" || s === "failed" || s === "expired") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      return trades.intent(CHAIN, agentId, intentId);
    }

    /** A buy of USDC for GHO, approved and run to its end; or as the flow refused it before approval. */
    async function buy(f: TradeFlow, usdcE6: bigint) {
      const p = await propose("USDC", "GHO", usdcE6);
      await f.tick();
      // A refusal before approval (the flow's own checks) comes back as the intent, like any other.
      await approveByOwner(trades, CHAIN, agentId, p.id);
      return run(f, p.id);
    }

    beforeAll(async () => {
      process.env.LOCAL_FORK_PORT = String(PORT);
      fork = await startTestFork({ port: PORT });
      t = await createTestDatabase("class_a_fork");
      db = t.db;
      trades = new TradeStore(db);
      const { deployAccountFactoryLocal } = await import("../../../scripts/lib/account-factory.js");
      const { deployFundLocal } = await import("../../../scripts/lib/fund.js");
      const { deployExecutorV3Local } = await import("../../../scripts/lib/executor-v3.js");
      const { deployAttestationVerifierLocal } = await import("../../../scripts/lib/attestor.js");
      const custody = await import("../../../scripts/lib/custody.js");
      await deployAccountFactoryLocal({ quiet: true });
      const fund = await deployFundLocal({ quiet: true, skipScreens: true });
      tokenRegistry = fund.tokenRegistry;
      // Executor v3 binds its own ProtocolRegistryV3 (the address book's), with its route adapter
      // active from construction (D-363); the fund deploy's own registry is not the one trades use.
      const exec = await deployExecutorV3Local({ quiet: true, tokenRegistry: fund.tokenRegistry });
      protocolRegistry = exec.protocolRegistry as Hex;
      expect(protocolRegistry.toLowerCase()).toBe(book("protocol_registry_v3").toLowerCase());
      // The verifier, set through the registry's own timelock, driven on the fork's clock (9 days).
      const v = await deployAttestationVerifierLocal({
        url: fork.url,
        tokenRegistry: fund.tokenRegistry,
        quiet: true,
      });
      verifier = v.verifier as Hex;
      expect(v.set).toBe(true);
      await refreshLocalFeeds(fork.url);
      owner = custody.testOwner(6) as Hex;
      agentId = Number(await custody.ownersAgent(book("agent_nft"), owner));
      account = (await createTestPersonalAccountV3(fork.url, agentId, owner)) as Hex;
      await fundTestPersonalAccountV3(fork.url, agentId, owner, [
        { token: book("usdc"), usdcE6: 40_000_000n },
        { token: book("wmon"), usdcE6: 25_000_000n },
        { token: WBTC, usdcE6: 20_000_000n },
      ]);
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
      await syncClock();
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
      await syncClock();
    });
    afterEach(async () => {
      await revertToSnapshot(snapshot, fork.url);
      for (const table of ["platform.intents", "platform.arming", "platform.ledger_lines"] as const)
        await db.deleteFrom(table).execute();
      await db.deleteFrom("platform.ledger_entries").execute();
      await db.deleteFrom("platform.signer_outbox").execute();
    });

    it("sets the verifier through the timelock, registers GHO in the screened lane after its screen, and records the owner's opt-in", async () => {
      const m = await readerV3.market();
      expect(m.verifier?.toLowerCase()).toBe(verifier.toLowerCase());
      expect(m.attestorSet).toBe(true);
      // Not registered yet: nothing to buy.
      expect(await ghoOnChain()).toBeNull();
      const actions = await registrar().afterScreen(GHO, screenRecord("passed"), [ghoPool()]);
      expect(actions.map((a) => a.action)).toEqual(["ADD_SCREENED", "ADD_POOL"]);
      const gho = await ghoOnChain();
      expect(gho).toMatchObject({ lane: "SCREENED", status: "BUYABLE", priceClass: "A" });
      expect(mirrored).toContain(`${GHO} screened listed`);
      // A later passing screen is recorded; nothing changes.
      expect(
        (await registrar().afterScreen(GHO, screenRecord("passed"), [ghoPool()])).map(
          (a) => a.action,
        ),
      ).toEqual(["RECORD_SCREEN"]);
      // The owner's onchain opt-in, from their own address.
      expect((await readerV3.agent(agentId))?.screenedOptIn).toBe(false);
      await sendAs(
        fork.url,
        owner,
        account,
        encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "setScreenedOptIn", args: [true] }),
      );
      expect((await readerV3.agent(agentId))?.screenedOptIn).toBe(true);
      // The attestor prices GHO from the pool both ways and an agreeing second source.
      const att = await attestorWith([poolQuoteSource(readerV3), fixed("fixed", E18)]).attest(GHO);
      expect(att.ok).toBe(true);
      if (att.ok) {
        expect(att.sources.map((s) => s.name).sort()).toEqual(["fixed", "pool"]);
        // A stablecoin: the pool's own price is within 5% of 1 USD.
        expect(att.priceE18).toBeGreaterThan((E18 * 95n) / 100n);
        expect(att.priceE18).toBeLessThan((E18 * 105n) / 100n);
      }
    });

    it("buys a class A token through Executor v3 with an attested price within 1%, and the 15% cap on cost basis refuses the next buy", async () => {
      await registrar().afterScreen(GHO, screenRecord("passed"), [ghoPool()]);
      await sendAs(
        fork.url,
        owner,
        account,
        encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "setScreenedOptIn", args: [true] }),
      );
      const f = flow(attestorWith([poolQuoteSource(readerV3), fixed("fixed", E18)]));
      // 8 USDC: under the 10% trade limit of an account worth about 85 USDC.
      const first = await propose("USDC", "GHO", 8_000_000n);
      expect(first.hops).toBe(1);
      await f.tick();
      await armV3();
      const approved = await approveByOwner(trades, CHAIN, agentId, first.id);
      expect(approved).toMatchObject({ ok: true });
      const usdcBefore = await balance(book("usdc"));
      const done = await run(f, first.id);
      expect(done?.status).toBe("reconciled");
      expect(done?.amountOut).toBeGreaterThan(0n);
      expect(await balance(book("usdc"))).toBe(usdcBefore - 8_000_000n);
      const held = await balance(GHO);
      expect(held).toBe(done?.amountOut ?? 0n);
      // Within 1% of the attested price: 8 USDC bought at least 7.92 GHO at about 1 USD each.
      expect(held).toBeGreaterThan((99n * E18 * 8n) / 100n);
      // The account's basis is about 85 USDC; 15% is 12.75, so 5 more USDC of GHO (13) is over the cap.
      const over = await buy(f, 5_000_000n);
      expect(over?.status).not.toBe("reconciled");
      expect(await balance(GHO)).toBe(held);
      expect(JSON.stringify([over?.reasonCodes, over?.blockers])).toMatch(/CLASS_A_POSITION_CAP/);
      // 4 more (12 of 12.75) fills: the cap counts basis, not the number of trades; 1 more (13) does not.
      const within = await buy(f, 4_000_000n);
      expect(within?.status).toBe("reconciled");
      const more = await balance(GHO);
      expect(more).toBeGreaterThan(held);
      const last = await buy(f, 1_000_000n);
      expect(last?.status).not.toBe("reconciled");
      expect(await balance(GHO)).toBe(more);
    });

    it("holds the caps with a wrong attested price, refuses a price below the market as slippage, and refuses to sign when sources disagree", async () => {
      await registrar().afterScreen(GHO, screenRecord("passed"), [ghoPool()]);
      await sendAs(
        fork.url,
        owner,
        account,
        encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "setScreenedOptIn", args: [true] }),
      );
      // Two sources agreeing on a price 1.5% above the market: within the oracle's 2% deviation
      // limit, so the chain cannot tell; the cap is on the USDC spent, so the oversize buy is still
      // refused and a buy within the cap fills.
      const high = flow(
        attestorWith([fixed("a", (E18 * 1015n) / 1000n), fixed("b", (E18 * 1015n) / 1000n)]),
      );
      const first = await propose("USDC", "GHO", 8_000_000n);
      await high.tick();
      await armV3();
      expect(await approveByOwner(trades, CHAIN, agentId, first.id)).toMatchObject({ ok: true });
      expect((await run(high, first.id))?.status).toBe("reconciled");
      const held = await balance(GHO);
      expect(held).toBeGreaterThan(0n);
      const over = await buy(high, 5_000_000n);
      expect(over?.status).not.toBe("reconciled");
      expect(await balance(GHO)).toBe(held);
      expect(JSON.stringify([over?.reasonCodes, over?.blockers])).toMatch(/CLASS_A_POSITION_CAP/);
      // A price 1.5% below the market: the pool gives 1.5% less than the attested value, over the 1% limit.
      const low = flow(
        attestorWith([fixed("a", (E18 * 985n) / 1000n), fixed("b", (E18 * 985n) / 1000n)]),
      );
      const cheap = await buy(low, 1_000_000n);
      expect(cheap?.status).not.toBe("reconciled");
      expect(await balance(GHO)).toBe(held);
      expect(JSON.stringify([cheap?.reasonCodes, cheap?.blockers])).toMatch(/SLIPPAGE/);
      // Twice the market: beyond the oracle's deviation limit, refused before anything is sent.
      const twice = flow(attestorWith([fixed("a", 2n * E18), fixed("b", 2n * E18)]));
      const wild = await buy(twice, 1_000_000n);
      expect(wild?.status).not.toBe("reconciled");
      expect(JSON.stringify([wild?.reasonCodes, wild?.blockers])).toMatch(/ORACLE_POOL_DEVIATION/);
      expect(await balance(GHO)).toBe(held);
      // Sources 10% apart: the attestor refuses, the flow refuses the trade, nothing is sent.
      const split = attestorWith([fixed("a", E18), fixed("b", (E18 * 110n) / 100n)]);
      const refused = await split.attest(GHO);
      expect(refused).toMatchObject({ ok: false, reason: "SOURCES_DISAGREE" });
      const unsigned = await buy(flow(split), 1_000_000n);
      expect(unsigned?.status).toBe("rejected");
      expect(JSON.stringify([unsigned?.reasonCodes, unsigned?.blockers])).toMatch(
        /ATTESTOR_UNAVAILABLE|ATTESTATION_REQUIRED/,
      );
      expect(await balance(GHO)).toBe(held);
      // Without an attestor at all, a class A trade waits too.
      const none = await buy(flow(null), 1_000_000n);
      expect(none?.status).toBe("rejected");
      expect(JSON.stringify([none?.reasonCodes, none?.blockers])).toMatch(
        /ATTESTOR_UNAVAILABLE|ATTESTATION_REQUIRED/,
      );
    });

    it("moves a token to sell-only on a refused re-screen: the account sells it and no longer buys it", async () => {
      await registrar().afterScreen(GHO, screenRecord("passed"), [ghoPool()]);
      await sendAs(
        fork.url,
        owner,
        account,
        encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "setScreenedOptIn", args: [true] }),
      );
      const f = flow(attestorWith([poolQuoteSource(readerV3), fixed("fixed", E18)]));
      const first = await propose("USDC", "GHO", 5_000_000n);
      await f.tick();
      await armV3();
      expect(await approveByOwner(trades, CHAIN, agentId, first.id)).toMatchObject({ ok: true });
      expect((await run(f, first.id))?.status).toBe("reconciled");
      const held = await balance(GHO);
      expect(held).toBeGreaterThan(0n);
      // The re-screen fails: sell-only at once, by the screener, no timelock.
      const actions = await registrar().afterScreen(GHO, screenRecord("refused"), []);
      expect(actions.map((a) => a.action)).toEqual(["SELL_ONLY"]);
      expect(await ghoOnChain()).toMatchObject({ lane: "SCREENED", status: "SELL_ONLY" });
      expect(mirrored).toContain(`${GHO} screened sell_only`);
      // A buy is refused; a sale of the whole position goes through.
      const blocked = await buy(f, 1_000_000n);
      expect(blocked?.status).not.toBe("reconciled");
      expect(await balance(GHO)).toBe(held);
      const sale = await propose("GHO", "USDC", held);
      await f.tick();
      const sold = await run(f, sale.id);
      expect(sold?.status).toBe("reconciled");
      expect(await balance(GHO)).toBe(0n);
    });
  },
);
