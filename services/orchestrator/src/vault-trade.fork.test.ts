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
  advanceTime,
  createTestVault,
  depositTestVault,
  refreshLocalFeeds,
  registerTestVaultGrant,
  revertToSnapshot,
  sendAs,
  setMonBalance,
  setTestVaultDepositsOpen,
  startTestFork,
  takeSnapshot,
  testForkUpstream,
} from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import { ERC20_ABI, LocalKeyProvider, Signer, ViemChainClient } from "@alpha-agents/signer";
import {
  TradeStore,
  VAULT_GRANT_NO_EXPIRY,
  approveByOwner,
  confirmArming,
} from "@alpha-agents/trading";
import {
  type Address,
  type Hex,
  bytesToHex,
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddressEqual,
  parseAbi,
} from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TradeFlow, swapGasCost } from "./trade-flow.ts";

/**
 * P7-U2 on a fork of its own (port 8566): the owner creates the agent's
 * StrategyVaultV3 through AccountFactoryV3, seeds it, opens deposits, and
 * two wallets deposit; the owner registers the vault grant (no expiry) on
 * Executor v3 and the platform records the arming for the vault; the trade
 * flow sends a one-hop and a two-hop swap for the vault through the real
 * signer, Executor v3 and the registered pools, exactly as for a personal
 * account, and the chain reader shows the vault as the agent's account; then
 * one depositor leaves in USDC after the lockup, the other in kind across
 * every held token, and the leader leaves in kind with the oracle, the
 * registry, the factory, the Executor and AgentNFT all replaced by reverting
 * code (the mid-phase playtest of BUILD_PLAN 4.0.1 "Playtest 7-mid").
 * Skips without MONAD_RPC_URL or Postgres (as in CI).
 */
const PORT = 8566;
const upstream = testForkUpstream();
const dbUp = await databaseAvailable();
const SLOW = 900_000;
const CHAIN = 143143;
const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c" as Hex;
const book = (id: Parameters<typeof addressEntry>[1]) => addressEntry("local", id).address as Hex;
/** PUSH1 0 PUSH1 0 REVERT: every call to it reverts. */
const REVERTING_CODE = "0x60006000fd";
const VAULT_ABI = parseAbi([
  "function redeem(uint256 shares, address receiver, uint256 minAssetsOut, uint64 deadline) returns (uint256)",
  "function redeemInKind(uint256 shares, address receiver)",
  "function sharesOf(address who) view returns (uint256)",
  "function freeShares(address who) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function leaderShares() view returns (uint256)",
  "function navUsdc() view returns (uint256)",
  "function heldTokens() view returns (address[])",
  "function inKindAmounts(uint256 shares) view returns (address[] tokens, uint256[] amounts)",
  "function lockup() view returns (uint64)",
  "function isVault() view returns (bool)",
  "function effectiveMode() view returns (uint8)",
]);

describe.skipIf(upstream === null || !dbUp)(
  "a vault trading through Executor v3 on a real fork, and its exits",
  { timeout: SLOW },
  () => {
    let fork: TestFork;
    let t: TestDatabase;
    let db: Db;
    let agentId: number;
    let vault: Hex;
    let owner: Hex;
    let alice: Hex;
    let bob: Hex;
    let key: Hex;
    let signer: Signer;
    let trades: TradeStore;
    let reader: ViemChainReader;
    let readerV3: ViemChainReaderV3;
    let snapshot: string;
    const previousPort = process.env.LOCAL_FORK_PORT;
    const seed = bytesToHex(randomBytes(32));
    const client = () => createPublicClient({ transport: http(fork.url) });
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
          topUp: (address: Hex, wei: bigint) => setMonBalance(address, wei, fork.url),
        },
        finalizedBlock: async () => null,
        log: () => undefined,
      });

    const balance = (token: Hex, of: Hex = vault) =>
      client().readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [of],
      });
    const vaultRead = <T>(functionName: string, args: unknown[] = []) =>
      client().readContract({
        address: vault,
        abi: VAULT_ABI,
        functionName,
        args,
      } as never) as Promise<T>;
    const shares = (who: Hex) => vaultRead<bigint>("sharesOf", [who]);

    async function armVault() {
      await registerTestVaultGrant(fork.url, agentId, owner, key);
      const view = await readerV3.agent(agentId);
      expect(view?.isVault).toBe(true);
      expect(view?.grant?.validUntil).toBe(VAULT_GRANT_NO_EXPIRY);
      const r = await confirmArming(trades, view, {
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

    /** A proposal for the vault as propose_swap stores a passing one, with the vault as the account. */
    async function propose(sellRef: string, buyRef: string, amountIn: bigint) {
      const [m, a] = await Promise.all([readerV3.market(), readerV3.agent(agentId)]);
      if (!a?.account) throw new Error("no agent account");
      expect(isAddressEqual(a.account, vault)).toBe(true);
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
          account: a.account.toLowerCase(),
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

    async function run(f: TradeFlow, intentId: string) {
      for (let i = 0; i < 80; i++) {
        await f.tick();
        await signer.tick();
        const s = (await trades.intent(CHAIN, agentId, intentId))?.status;
        if (s === "reconciled" || s === "rejected" || s === "failed" || s === "expired") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      return trades.intent(CHAIN, agentId, intentId);
    }

    beforeAll(async () => {
      process.env.LOCAL_FORK_PORT = String(PORT);
      fork = await startTestFork({ port: PORT });
      t = await createTestDatabase("vault_trade_fork");
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
      // Anvil's printed addresses carry no EIP-55 checksum viem accepts (L-20): recompute it.
      owner = getAddress(custody.testOwner(6).toLowerCase());
      alice = getAddress(custody.testOwner(7).toLowerCase());
      bob = getAddress(custody.testOwner(8).toLowerCase());
      agentId = Number(await custody.ownersAgent(book("agent_nft"), owner));
      // The owner's vault: the leader's 20 USDC seed, deposits opened, 30 USDC from each depositor.
      vault = (await createTestVault(fork.url, agentId, owner)) as Hex;
      await depositTestVault(fork.url, agentId, owner, 20_000_000n);
      await setTestVaultDepositsOpen(fork.url, agentId, owner, true);
      await depositTestVault(fork.url, agentId, alice, 30_000_000n);
      await depositTestVault(fork.url, agentId, bob, 30_000_000n);
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
      for (const table of ["platform.intents", "platform.arming", "platform.ledger_lines"] as const)
        await db.deleteFrom(table).execute();
      await db.deleteFrom("platform.ledger_entries").execute();
      await db.deleteFrom("platform.signer_outbox").execute();
    });

    it("reads the vault as the agent's account, with the leader's stake and both depositors' shares", async () => {
      expect(await vaultRead<boolean>("isVault")).toBe(true);
      const a = await readerV3.agent(agentId);
      expect(a?.account?.toLowerCase()).toBe(vault.toLowerCase());
      expect(a?.isVault).toBe(true);
      expect(a?.vault?.toLowerCase()).toBe(vault.toLowerCase());
      expect(a?.personalAccount).toBeNull();
      expect(a?.mode).toBe("NORMAL");
      expect(a?.holdings.map((h) => h.token.toLowerCase())).toEqual([book("usdc").toLowerCase()]);
      expect(await vaultRead<bigint>("navUsdc")).toBe(80_000_000n);
      expect(await vaultRead<bigint>("leaderShares")).toBe(20_000_000_000_000_000_000n);
      expect(await shares(alice)).toBeGreaterThan(0n);
      expect(await shares(bob)).toBeGreaterThan(0n);
      expect(await vaultRead<bigint>("lockup")).toBe(86_400n);
      // Still locked: the default day has not passed.
      expect(await vaultRead<bigint>("freeShares", [alice])).toBe(0n);
    });

    it("trades for the vault through Executor v3 under the no-expiry grant, one hop and two, like a personal account", async () => {
      const f = flow();
      const first = await propose("USDC", "WMON", 5_000_000n);
      expect(first.hops).toBe(1);
      const record = await armVault();
      expect(record).toMatchObject({ status: "awaiting_first_trade", custody: "v3" });
      expect(record.validUntil).toBe(VAULT_GRANT_NO_EXPIRY);
      expect(record.executor?.toLowerCase()).toBe(executorV3.toLowerCase());
      const approved = await approveByOwner(trades, CHAIN, agentId, first.id);
      expect(approved).toMatchObject({ ok: true, armed: { status: "armed" } });
      const usdcBefore = await balance(book("usdc"));
      const supplyBefore = await vaultRead<bigint>("totalSupply");
      const done = await run(f, first.id);
      expect(done?.status).toBe("reconciled");
      expect(done?.custody).toBe("v3");
      expect(await balance(book("usdc"))).toBe(usdcBefore - 5_000_000n);
      expect(await balance(book("wmon"))).toBe(done?.amountOut ?? 0n);
      expect(await vaultRead<bigint>("totalSupply")).toBe(supplyBefore);
      const tx = await db
        .selectFrom("platform.signer_outbox")
        .selectAll()
        .where("tx_id", "=", done?.txId ?? "")
        .executeTakeFirstOrThrow();
      expect(tx).toMatchObject({ status: "reconciled" });
      expect(String((tx.request as { to?: string }).to).toLowerCase()).toBe(
        executorV3.toLowerCase(),
      );
      // Two hops, sent on its own now the agent is armed: USDC to WBTC through MON.
      await refreshLocalFeeds(fork.url);
      const second = await propose("USDC", "WBTC", 5_000_000n);
      expect(second.hops).toBe(2);
      const auto = await run(f, second.id);
      expect(auto).toMatchObject({ status: "reconciled", approvedBy: "auto", custody: "v3" });
      expect(await balance(WBTC)).toBe(auto?.amountOut ?? 0n);
      const held = await vaultRead<Hex[]>("heldTokens");
      expect(held.map((h) => h.toLowerCase()).sort()).toEqual(
        [book("usdc"), book("wmon"), WBTC].map((x) => x.toLowerCase()).sort(),
      );
      // The reader's view follows: three holdings, the vault still the account.
      const a = await readerV3.agent(agentId);
      expect(a?.holdings).toHaveLength(3);
      expect(a?.isVault).toBe(true);
    });

    it("lets one depositor leave in USDC after the lockup and the other in kind, then the leader with every other contract reverting", async () => {
      await armVault();
      const [r] = await trades.openArmings(CHAIN);
      if (r) await trades.markArmed(r.armingId, "first");
      const f = flow();
      const buyWmon = await propose("USDC", "WMON", 6_000_000n);
      expect((await run(f, buyWmon.id))?.status).toBe("reconciled");
      await refreshLocalFeeds(fork.url);
      const buyWbtc = await propose("USDC", "WBTC", 6_000_000n);
      expect((await run(f, buyWbtc.id))?.status).toBe("reconciled");
      // The lockup passes; the feeds are refreshed on the fork's new clock.
      await advanceTime(86_400 + 60, fork.url);
      await refreshLocalFeeds(fork.url);
      const aliceShares = await shares(alice);
      expect(await vaultRead<bigint>("freeShares", [alice])).toBe(aliceShares);
      // Alice: the USDC path, from USDC above the 10% floor.
      const nav = await vaultRead<bigint>("navUsdc");
      const aliceUsdcBefore = await balance(book("usdc"), alice);
      const block = await client().getBlock();
      await sendAs(
        fork.url,
        alice as Address,
        vault as Address,
        encodeFunctionData({
          abi: VAULT_ABI,
          functionName: "redeem",
          args: [aliceShares, alice, 0n, block.timestamp + 600n],
        }),
      );
      const alicePaid = (await balance(book("usdc"), alice)) - aliceUsdcBefore;
      expect(alicePaid).toBeGreaterThan(29_000_000n);
      expect(alicePaid).toBeLessThan(30_000_000n);
      expect(await shares(alice)).toBe(0n);
      expect(await vaultRead<bigint>("navUsdc")).toBe(nav - alicePaid);
      // Bob: in kind, the floor of his slice of USDC, WMON and WBTC.
      const bobShares = await shares(bob);
      const [tokens, amounts] = await vaultRead<[Hex[], bigint[]]>("inKindAmounts", [bobShares]);
      const before = await Promise.all(tokens.map((tk) => balance(tk, bob)));
      await sendAs(
        fork.url,
        bob as Address,
        vault as Address,
        encodeFunctionData({
          abi: VAULT_ABI,
          functionName: "redeemInKind",
          args: [bobShares, bob],
        }),
      );
      for (let k = 0; k < tokens.length; k++) {
        expect((await balance(tokens[k] as Hex, bob)) - (before[k] as bigint)).toBe(amounts[k]);
        expect(amounts[k]).toBeGreaterThan(0n);
      }
      expect(await shares(bob)).toBe(0n);
      // The leader, last, with the platform gone: every other contract reverts.
      for (const id of [
        "oracle_adapter_v3",
        "token_registry_v3",
        "account_factory_v3",
        "executor_v3",
        "agent_nft",
      ] as const)
        await client().request({
          method: "anvil_setCode" as never,
          params: [book(id), REVERTING_CODE] as never,
        });
      await expect(vaultRead<bigint>("navUsdc")).rejects.toThrow();
      const leaderShares = await vaultRead<bigint>("leaderShares");
      const [leaderTokens, leaderAmounts] = await vaultRead<[Hex[], bigint[]]>("inKindAmounts", [
        leaderShares,
      ]);
      const leaderBefore = await Promise.all(leaderTokens.map((tk) => balance(tk, owner)));
      await sendAs(
        fork.url,
        owner as Address,
        vault as Address,
        encodeFunctionData({
          abi: VAULT_ABI,
          functionName: "redeemInKind",
          args: [leaderShares, owner],
        }),
      );
      for (let k = 0; k < leaderTokens.length; k++) {
        expect((await balance(leaderTokens[k] as Hex, owner)) - (leaderBefore[k] as bigint)).toBe(
          leaderAmounts[k],
        );
      }
      expect(await vaultRead<bigint>("totalSupply")).toBe(0n);
      for (const tk of leaderTokens) expect(await balance(tk)).toBe(0n);
    });
  },
);
