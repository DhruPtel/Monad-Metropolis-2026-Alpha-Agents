import { randomBytes, randomUUID } from "node:crypto";
import { ViemChainReader, contractsFor } from "@alpha-agents/chain-tools";
import type { Db } from "@alpha-agents/db";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import {
  type TestFork,
  advanceTime,
  revertToSnapshot,
  setMonBalance,
  startTestFork,
  takeSnapshot,
  testForkUpstream,
} from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import {
  ERC20_ABI,
  EXECUTOR_ABI,
  LocalKeyProvider,
  Signer,
  ViemChainClient,
} from "@alpha-agents/signer";
import { TradeStore, approveByOwner, confirmArming } from "@alpha-agents/trading";
import { type Hex, bytesToHex, createPublicClient, http, parseAbi } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TradeFlow, swapGasCost } from "./trade-flow.ts";

/**
 * P2-U6 on a fork of its own (D-200, port 8556) with the real stack: the
 * owner registers the grant, approves the first trade, and the trade flow
 * sends it through the real signer, the Executor and the Uniswap v4 MON/USDC
 * pool and settles it only after the signer reconciled it; later proposals
 * go through on their own; arming ends on the real chain's expiry, sale,
 * configuration change and revoke; a proposal over the limits and one with no
 * gas MON are refused at submission with their reasons, and nothing is sent.
 * Skips without MONAD_RPC_URL or Postgres (as in CI).
 */
const PORT = 8556;
const upstream = testForkUpstream();
const dbUp = await databaseAvailable();
const SLOW = 600_000;
const CHAIN = 143143;
const OWNER_ABI = parseAbi([
  "function bumpConfigEpoch(uint256 agentId)",
  "function revokeSession(uint256 agentId)",
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function approve(address to, uint256 tokenId)",
  "function setEscrow(address escrow)",
  "function owner() view returns (address)",
]);

const book = (id: Parameters<typeof addressEntry>[1]) => addressEntry("local", id).address as Hex;

describe.skipIf(upstream === null || !dbUp)(
  "the trade flow on a real fork",
  { timeout: SLOW },
  () => {
    let fork: TestFork;
    let t: TestDatabase;
    let db: Db;
    let agentId: number;
    let account: Hex;
    let owner: Hex;
    let buyer: Hex;
    let key: Hex;
    let signer: Signer;
    let trades: TradeStore;
    let reader: ViemChainReader;
    let snapshot: string;
    let send: (from: Hex, request: unknown) => Promise<unknown>;
    let impersonate: (address: Hex) => Promise<void>;
    let useFreshFeeds: () => Promise<unknown>;
    let topUp = true;
    const previousPort = process.env.LOCAL_FORK_PORT;
    const seed = bytesToHex(randomBytes(32));
    const client = () => createPublicClient({ transport: http(fork.url) });
    const executor = book("executor");

    const flow = () =>
      new TradeFlow({
        chainId: CHAIN,
        store: trades,
        reader,
        signer,
        gas: {
          balance: (address) => client().getBalance({ address }),
          swapCost: async () => {
            const block = await client().getBlock();
            return swapGasCost(block.baseFeePerGas ?? 0n, 0n);
          },
          ...(topUp
            ? { topUp: (address: Hex, wei: bigint) => setMonBalance(address, wei, fork.url) }
            : {}),
        },
        finalizedBlock: async () => null,
        log: () => undefined,
      });

    const balance = (token: Hex) =>
      client().readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account],
      });

    async function registerGrant(days = 30) {
      const now = (await client().getBlock()).timestamp;
      await send(owner, {
        address: executor,
        abi: EXECUTOR_ABI,
        functionName: "registerSession",
        args: [BigInt(agentId), key, now + BigInt(days) * 86_400n],
      });
    }

    async function arm() {
      await registerGrant();
      const r = await confirmArming(trades, await reader.agent(agentId), {
        chainId: CHAIN,
        agentId,
        owner,
        fundingAddress: key,
      });
      if (!r.ok) throw new Error(r.message);
      return r.record;
    }

    /** A proposal as propose_swap stores a passing one, at the chain's current epochs. */
    async function propose(amountIn: bigint, sell: "USDC" | "WMON" = "USDC") {
      const a = await reader.agent(agentId);
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
          sell,
          buy: sell === "USDC" ? "WMON" : "USDC",
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
      t = await createTestDatabase("trade_flow_fork");
      db = t.db;
      trades = new TradeStore(db);
      const { deployAccountFactoryLocal } = await import("../../../scripts/lib/account-factory.js");
      const custody = await import("../../../scripts/lib/custody.js");
      const oracle = await import("../../../scripts/lib/oracle.js");
      ({ send, impersonate } = (await import("../../../scripts/lib/agent-reveal.js")) as never);
      ({ useFreshFeeds } = oracle as never);
      await deployAccountFactoryLocal({ quiet: true });
      await useFreshFeeds();
      owner = custody.testOwner(6) as Hex;
      buyer = custody.testOwner(7) as Hex;
      agentId = Number(await custody.ownersAgent(book("agent_nft"), owner));
      ({ account } = (await custody.ensureAccount(
        book("account_factory"),
        BigInt(agentId),
        owner,
      )) as { account: Hex });
      await custody.depositUsdc(account, owner, 60_000_000n);
      signer = new Signer({
        db,
        environment: "local",
        chain: new ViemChainClient({ chainId: CHAIN, primaryUrl: fork.url }),
        keys: new LocalKeyProvider(seed),
        executor,
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

    beforeEach(async () => {
      snapshot = await takeSnapshot(fork.url);
      topUp = true;
      await useFreshFeeds();
    });
    afterEach(async () => {
      await revertToSnapshot(snapshot, fork.url);
      for (const table of ["platform.intents", "platform.arming", "platform.ledger_lines"] as const)
        await db.deleteFrom(table).execute();
      await db.deleteFrom("platform.ledger_entries").execute();
      // The signer realigns its nonce to the fork's after a revert (it does after a reset).
      await db.deleteFrom("platform.signer_outbox").execute();
    });

    it("arms on the first approval, executes it on the real v4 pool, settles after reconciliation, then trades on its own", async () => {
      const f = flow();
      const first = await propose(5_000_000n);
      // Not armed yet: the proposal waits.
      await f.tick();
      expect((await trades.intent(CHAIN, agentId, first))?.status).toBe("awaiting_approval");
      const record = await arm();
      expect(record.status).toBe("awaiting_first_trade");
      const approved = await approveByOwner(trades, CHAIN, agentId, first);
      expect(approved).toMatchObject({ ok: true, armed: { status: "armed" } });
      const wmonBefore = await balance(book("wmon"));
      const done = await run(f, first);
      expect(done?.status).toBe("reconciled");
      expect(done?.amountOut).toBeGreaterThan(0n);
      expect(done?.amountOut).toBeGreaterThanOrEqual(done?.minAmountOut ?? 0n);
      expect(await balance(book("wmon"))).toBe(wmonBefore + (done?.amountOut ?? 0n));
      const tx = await db
        .selectFrom("platform.signer_outbox")
        .selectAll()
        .where("tx_id", "=", done?.txId ?? "")
        .executeTakeFirstOrThrow();
      expect(tx).toMatchObject({ status: "reconciled", tx_hash: done?.txHash });
      expect(tx.ledger_entry_id).not.toBeNull();
      // Armed: the next proposal is approved and sent with no owner step.
      await useFreshFeeds();
      const second = await propose(3_000_000n);
      const auto = await run(f, second);
      expect(auto).toMatchObject({ status: "reconciled", approvedBy: "auto" });
    });

    it("refuses at submission a proposal over the limits and one with no MON for gas, and sends nothing", async () => {
      await arm();
      const [r] = await trades.openArmings(CHAIN);
      if (r) await trades.markArmed(r.armingId, "first");
      const big = await propose(20_000_000n); // over 10% of the 60 USDC account
      const blocked = await run(flow(), big);
      expect(blocked?.status).toBe("rejected");
      expect(blocked?.reasonCodes).toContain("TRADE_SIZE_EXCEEDED");
      topUp = false;
      await setMonBalance(key, 0n, fork.url);
      const dry = await propose(1_000_000n);
      const noGas = await run(flow(), dry);
      expect(noGas?.reasonCodes).toEqual(["GAS_UNFUNDED"]);
      const sent = await db.selectFrom("platform.signer_outbox").select("tx_id").execute();
      expect(sent).toHaveLength(0);
      const why = await trades.whyNotTraded(CHAIN, agentId);
      expect(why.reasons.map((x) => x.code)).toEqual(
        expect.arrayContaining(["TRADE_SIZE_EXCEEDED", "GAS_UNFUNDED"]),
      );
    });

    it("ends arming on the real chain: a configuration change, a revoke, a sale and expiry", async () => {
      const f = flow();
      const ends: [string, () => Promise<unknown>][] = [
        [
          "config_changed",
          () =>
            send(owner, {
              address: executor,
              abi: OWNER_ABI,
              functionName: "bumpConfigEpoch",
              args: [BigInt(agentId)],
            }),
        ],
        [
          "revoked",
          () =>
            send(owner, {
              address: executor,
              abi: OWNER_ABI,
              functionName: "revokeSession",
              args: [BigInt(agentId)],
            }),
        ],
        [
          "sold",
          async () => {
            // A sale moves the agent through the marketplace escrow only (AgentNFT's _update).
            // Within this snapshot a deployed contract stands in as the escrow.
            const nft = book("agent_nft");
            const escrow = book("account_factory");
            const admin = (await client().readContract({
              address: nft,
              abi: OWNER_ABI,
              functionName: "owner",
            })) as Hex;
            await impersonate(admin);
            await send(admin, {
              address: nft,
              abi: OWNER_ABI,
              functionName: "setEscrow",
              args: [escrow],
            });
            await send(owner, {
              address: nft,
              abi: OWNER_ABI,
              functionName: "approve",
              args: [escrow, BigInt(agentId)],
            });
            await impersonate(escrow);
            await setMonBalance(escrow, 10n ** 18n, fork.url);
            await send(escrow, {
              address: nft,
              abi: OWNER_ABI,
              functionName: "transferFrom",
              args: [owner, buyer, BigInt(agentId)],
            });
          },
        ],
        ["expired", () => advanceTime(31 * 86_400, fork.url)],
      ];
      for (const [reason, change] of ends) {
        const inner = await takeSnapshot(fork.url);
        await arm();
        expect(await f.upkeepArmings()).toEqual([]);
        await change();
        const ended = await f.upkeepArmings();
        expect(
          ended.map((e) => e.endedReason),
          reason,
        ).toEqual([reason]);
        expect(await trades.openArming(CHAIN, agentId)).toBeNull();
        await revertToSnapshot(inner, fork.url);
        await useFreshFeeds();
      }
    });
  },
);
