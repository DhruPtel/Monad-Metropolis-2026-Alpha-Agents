import { randomBytes } from "node:crypto";
import type { Db } from "@alpha-agents/db";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import {
  type TestFork,
  setMonBalance,
  startTestFork,
  testForkUpstream,
} from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import { type Hex, bytesToHex, createPublicClient, http } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ERC20_ABI, EXECUTOR_ABI } from "./abi.ts";
import { type ChainClient, ViemChainClient } from "./chain.ts";
import { buildTestSwap } from "./dev.ts";
import { LocalKeyProvider } from "./keys.ts";
import { Signer } from "./signer.ts";

/**
 * P2-U4 acceptance on a fork of its own (D-200, port 8552): a swap goes
 * from the signer through the Executor and the real Uniswap v4 MON/USDC pool,
 * and reaches the ledger only once reconciled. Also on the real chain: an
 * Executor refusal, a signer refusal, a timeout resolved by hash without a
 * resend, and nonces across a restart. Skips without MONAD_RPC_URL or
 * Postgres (as in CI).
 */
const PORT = 8552;
const upstream = testForkUpstream();
const dbUp = await databaseAvailable();
const SLOW = 300_000;

const book = (id: Parameters<typeof addressEntry>[1]) => addressEntry("local", id).address as Hex;

describe.skipIf(upstream === null || !dbUp)("the signer on a real fork", { timeout: SLOW }, () => {
  let fork: TestFork;
  let t: TestDatabase;
  let db: Db;
  let agentId: number;
  let account: Hex;
  let owner: Hex;
  let send: (from: Hex, request: unknown) => Promise<unknown>;
  const previousPort = process.env.LOCAL_FORK_PORT;
  const seed = bytesToHex(randomBytes(32));
  const logs: string[] = [];

  const usdc = book("usdc");
  const wmon = book("wmon");
  const executor = book("executor");

  const signer = (chain?: ChainClient) =>
    new Signer({
      db,
      environment: "local",
      chain: chain ?? new ViemChainClient({ chainId: 143143, primaryUrl: fork.url }),
      keys: new LocalKeyProvider(seed),
      executor,
      assets: { [usdc.toLowerCase()]: "USDC", [wmon.toLowerCase()]: "WMON" },
      log: (l) => logs.push(l),
      topUpGas: (address, wei) => setMonBalance(address, wei, fork.url),
    });

  const client = () => createPublicClient({ transport: http(fork.url) });
  const balance = (token: Hex) =>
    client().readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account],
    });
  const row = (txId: string) =>
    db
      .selectFrom("platform.signer_outbox")
      .selectAll()
      .where("tx_id", "=", txId)
      .executeTakeFirstOrThrow();

  /** Ticks until the transaction settles one way or the other. */
  async function settle(s: Signer, txId: string) {
    for (let i = 0; i < 60; i++) {
      await s.tick();
      const r = await row(txId);
      if (r.status === "reconciled" || r.status === "failed" || r.reason_code) return r;
      await new Promise((res) => setTimeout(res, 250));
    }
    return row(txId);
  }

  beforeAll(async () => {
    process.env.LOCAL_FORK_PORT = String(PORT);
    fork = await startTestFork({ port: PORT });
    t = await createTestDatabase("signer_fork");
    db = t.db;
    const { deployAccountFactoryLocal } = await import("../../../scripts/lib/account-factory.js");
    const custody = await import("../../../scripts/lib/custody.js");
    const oracle = await import("../../../scripts/lib/oracle.js");
    ({ send } = (await import("../../../scripts/lib/agent-reveal.js")) as never);
    await deployAccountFactoryLocal({ quiet: true });
    await oracle.useFreshFeeds();
    owner = custody.testOwner(6) as Hex;
    agentId = Number(await custody.ownersAgent(book("agent_nft"), owner));
    ({ account } = (await custody.ensureAccount(
      book("account_factory"),
      BigInt(agentId),
      owner,
    )) as {
      account: Hex;
    });
    await custody.depositUsdc(account, owner, 60_000_000n);
  }, SLOW);

  afterAll(async () => {
    await t?.drop();
    await fork?.stop();
    if (previousPort === undefined) delete process.env.LOCAL_FORK_PORT;
    else process.env.LOCAL_FORK_PORT = previousPort;
  }, SLOW);

  it("creates the session key in the signer and the owner registers it as the agent's grant", async () => {
    const s = signer();
    await s.start();
    const key = await s.createKey(agentId);
    const now = (await client().getBlock()).timestamp;
    await send(owner, {
      address: executor,
      abi: EXECUTOR_ABI,
      functionName: "registerSession",
      args: [BigInt(agentId), key, now + 30n * 86_400n],
    });
    const grant = await client().readContract({
      address: executor,
      abi: EXECUTOR_ABI,
      functionName: "sessionOf",
      args: [BigInt(agentId)],
    });
    expect(grant.key).toBe(key);
  });

  it("buys WMON through the signer, the Executor and the real v4 pool, and writes the ledger only once reconciled", async () => {
    const s = signer();
    const [u0, w0] = [await balance(usdc), await balance(wmon)];
    const swap = await buildTestSwap(fork.url, { agentId, direction: "buy", amountIn: 5_000_000n });
    if (swap.kind !== "swap") throw new Error("expected a swap");
    const { txId } = await s.submitSwap(agentId, swap.intent);
    const r = await settle(s, txId);
    expect(r.status).toBe("reconciled");
    expect((r.history as { status: string }[]).map((h) => h.status)).toEqual([
      "accepted",
      "signed",
      "submitted",
      "confirmed",
      "reconciled",
    ]);
    const [u1, w1] = [await balance(usdc), await balance(wmon)];
    expect(u0 - u1).toBe(5_000_000n);
    expect(w1 - w0).toBe(BigInt(r.amount_out ?? "0"));
    expect(w1 - w0 >= swap.intent.minAmountOut).toBe(true);
    const entry = await s.ledgerEntry(r.ledger_entry_id ?? "");
    expect(entry?.kind).toBe("trade");
    expect(entry?.source).toMatchObject({ txHash: r.tx_hash, account });
    expect(entry?.lines).toEqual([
      { account: "personal_account", asset: "USDC", amount: "-5000000" },
      { account: "venue", asset: "USDC", amount: "5000000" },
      { account: "venue", asset: "WMON", amount: `-${w1 - w0}` },
      { account: "personal_account", asset: "WMON", amount: `${w1 - w0}` },
    ]);
    expect(Number(r.gas_used)).toBeLessThan(1_100_000);
  });

  it("sells WMON back the same way", async () => {
    const s = signer();
    const held = await balance(wmon);
    const swap = await buildTestSwap(fork.url, { agentId, direction: "sell", amountIn: held / 2n });
    if (swap.kind !== "swap") throw new Error("expected a swap");
    const r = await settle(s, (await s.submitSwap(agentId, swap.intent)).txId);
    expect(r.status).toBe("reconciled");
    expect(await balance(wmon)).toBe(held - held / 2n);
  });

  it("records the Executor's refusal of a swap that breaks a limit, and sends nothing", async () => {
    const s = signer();
    const key = (await s.keyAddress(agentId)) as Hex;
    const nonceBefore = await client().getTransactionCount({ address: key });
    for (const limit of ["SLIPPAGE_TOO_HIGH", "DEADLINE_TOO_FAR", "TRADE_SIZE_EXCEEDED"] as const) {
      const swap = await buildTestSwap(fork.url, {
        agentId,
        direction: "buy",
        amountIn: 1_000_000n,
        breakLimit: limit,
      });
      if (swap.kind !== "swap") throw new Error("expected a swap");
      const r = await settle(s, (await s.submitSwap(agentId, swap.intent)).txId);
      expect(r).toMatchObject({ status: "failed", reason_code: limit, raw_tx: null });
    }
    expect(await client().getTransactionCount({ address: key })).toBe(nonceBefore);
  });

  it("refuses a non-Executor call and a wrong chain before signing", async () => {
    const s = signer();
    for (const limit of ["TARGET_NOT_ALLOWED", "CHAIN_NOT_PINNED"] as const) {
      const swap = await buildTestSwap(fork.url, {
        agentId,
        direction: "buy",
        amountIn: 1_000_000n,
        breakLimit: limit,
      });
      if (swap.kind !== "request") throw new Error("expected a raw request");
      expect(await s.accept(agentId, swap.request)).toMatchObject({
        status: "failed",
        reasonCode: limit,
      });
    }
  });

  it("resolves a broadcast that timed out by its hash, without sending it again, and keeps nonces across a restart", async () => {
    const real = new ViemChainClient({ chainId: 143143, primaryUrl: fork.url });
    let sends = 0;
    // The node takes the transaction, but the answer never comes back.
    const timingOut: ChainClient = Object.assign(Object.create(real) as ChainClient, {
      sendRaw: async (raw: Hex) => {
        sends++;
        await real.sendRaw(raw);
        return { kind: "unknown" as const, detail: "The request took too long to respond." };
      },
    });
    const s = signer(timingOut);
    const key = (await s.keyAddress(agentId)) as Hex;
    const before = await client().getTransactionCount({ address: key });
    const swap = await buildTestSwap(fork.url, { agentId, direction: "buy", amountIn: 2_000_000n });
    if (swap.kind !== "swap") throw new Error("expected a swap");
    const r = await settle(s, (await s.submitSwap(agentId, swap.intent)).txId);
    // Anvil mines just after it answers, so the first check may find the node still holding it.
    const states = (r.history as { status: string }[]).map((h) => h.status);
    expect(states.slice(0, 3), `${r.reason_code}: ${r.reason}`).toEqual([
      "accepted",
      "signed",
      "unknown",
    ]);
    expect(states.slice(-2)).toEqual(["confirmed", "reconciled"]);
    expect(states).not.toContain("failed");
    expect(sends).toBe(1);
    expect(await client().getTransactionCount({ address: key })).toBe(before + 1);

    // A new signer process continues at the next nonce.
    const restarted = signer();
    const again = await buildTestSwap(fork.url, {
      agentId,
      direction: "buy",
      amountIn: 1_000_000n,
    });
    if (again.kind !== "swap") throw new Error("expected a swap");
    const r2 = await settle(restarted, (await restarted.submitSwap(agentId, again.intent)).txId);
    expect(r2).toMatchObject({ status: "reconciled", nonce: before + 1 });
    expect(await client().getTransactionCount({ address: key })).toBe(before + 2);
    for (const line of logs) expect(line).not.toContain(seed.slice(2));
  });
});
