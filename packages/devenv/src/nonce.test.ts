import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { LOCAL_FORK_CHAIN_ID } from "@alpha-agents/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotLocalForkError } from "./guard.ts";
import { accountNonceReport, alignAccountNonce, dropQueuedTransactions } from "./nonce.ts";
import { rpc, toHex } from "./rpc.ts";

/**
 * The stuck-transaction tools (P2-U1 step 0) against a throwaway anvil of
 * their own: not a fork (no upstream), but on the local fork's chain ID so the
 * guard accepts it. The playtest fork on 8545 is never touched.
 */
const PORT = 8572;
const URL = `http://127.0.0.1:${PORT}`;
// Anvil's public development account 0: unlocked on a fresh anvil.
const FROM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const haveAnvil = spawnSync("anvil", ["--version"]).status === 0;

/** Sends a transfer with a chosen nonce through the unlocked account; returns its hash. */
const send = async (nonce: number) =>
  (await rpc(URL, "eth_sendTransaction", [
    {
      from: FROM,
      to: "0x000000000000000000000000000000000000dEaD",
      value: "0x1",
      nonce: toHex(nonce),
    },
  ])) as string;

describe.skipIf(!haveAnvil)("stuck transactions on the fork", { timeout: 30_000 }, () => {
  let anvil: ChildProcess;

  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", String(LOCAL_FORK_CHAIN_ID)], {
      stdio: "ignore",
    });
    for (let i = 0; i < 50; i += 1) {
      if (await rpc(URL, "eth_chainId").catch(() => null)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the throwaway anvil did not start");
  });
  afterAll(() => {
    anvil?.kill("SIGTERM");
  });

  it("reports a wallet's nonces ahead of the fork as queued, with the nonce to align to", async () => {
    const hash = await send(3);
    await send(4);
    const r = await accountNonceReport(FROM, URL);
    expect(r.forkNonce).toBe(0);
    expect(r.queued.map((q) => q.nonce)).toEqual([3, 4]);
    expect(r.queued[0]?.hash).toBe(hash);
    expect(r.suggestedNonce).toBe(5);
  });

  it("drops the queued transactions", async () => {
    const r = await dropQueuedTransactions(FROM, URL);
    expect(r.queued).toEqual([]);
    expect(r.suggestedNonce).toBeNull();
  });

  it("aligns the nonce so the wallet's next transaction mines, and never moves it back", async () => {
    await send(7);
    const aligned = await alignAccountNonce(FROM, 8, URL);
    expect(aligned).toMatchObject({ forkNonce: 8, queued: [] });
    // The wallet's next send, numbered from its own history, now mines.
    const hash = await send(8);
    await rpc(URL, "evm_mine");
    const receipt = (await rpc(URL, "eth_getTransactionReceipt", [hash])) as { status?: string };
    expect(receipt.status).toBe("0x1");
    await expect(alignAccountNonce(FROM, 2, URL)).rejects.toThrow(/only moves forward/);
    await expect(alignAccountNonce(FROM, -1, URL)).rejects.toThrow(/whole number/);
  });

  it("refuses anything that is not the local fork, and a malformed address", async () => {
    await expect(accountNonceReport(FROM, "http://10.0.0.1:8545")).rejects.toBeInstanceOf(
      NotLocalForkError,
    );
    await expect(dropQueuedTransactions("0x12", URL)).rejects.toThrow(/not an account address/);
  });
});
