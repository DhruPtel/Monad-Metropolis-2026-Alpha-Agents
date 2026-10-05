import { describe, expect, it } from "vitest";
import type { Rpc } from "./network-check";
import {
  ReceiptTimeoutError,
  SentElsewhereError,
  waitForReceiptOnAppNetwork,
} from "./receipt-watch";

const HASH = `0x${"8b".repeat(32)}` as const;
const APP = "Monad (local fork)";

/** A fake clock that sleep advances, so waits take no real time. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

/** An RPC with a given receipt (or none) and given block hashes by number. */
function rpc(receipt: object | null, blocks: Record<string, string> = {}): Rpc {
  return async (method, params) => {
    if (method === "eth_getTransactionReceipt") return receipt;
    if (method === "eth_getBlockByNumber") {
      const hash = blocks[String(params[0])];
      return hash ? { hash } : null;
    }
    throw new Error(`unexpected ${method}`);
  };
}

describe("waitForReceiptOnAppNetwork", () => {
  it("resolves once the app's RPC has the receipt", async () => {
    let calls = 0;
    const app: Rpc = async (method) =>
      method === "eth_getTransactionReceipt" && ++calls >= 3 ? { status: "0x1" } : null;
    await expect(
      waitForReceiptOnAppNetwork({
        hash: HASH,
        app,
        wallet: rpc(null),
        appNetwork: APP,
        ...clock(),
      }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it("names a send to another chain at once when the block hashes differ (L-53)", async () => {
    // The wallet's network (Monad mainnet) has the receipt in its block 0x69b2a08;
    // the app's network has a block at that number with another hash.
    const wallet = rpc({ blockNumber: "0x69b2a08", blockHash: "0xaaaa" });
    const app = rpc(null, { "0x69b2a08": "0xf0f0" });
    const c = clock();
    const error = await waitForReceiptOnAppNetwork({
      hash: HASH,
      app,
      wallet,
      appNetwork: APP,
      ...c,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SentElsewhereError);
    expect((error as Error).message).toContain(
      "Your wallet sent the transaction to a different network than this app reads",
    );
    expect((error as Error).message).toContain("Nothing happened on Monad (local fork)");
    expect(c.now()).toBe(0);
  });

  it("names a send to another chain after the grace period when the app lacks the block", async () => {
    // The local fork's head is far below mainnet's, so it has no such block.
    const wallet = rpc({ blockNumber: "0x69b2a08", blockHash: "0xaaaa" });
    const c = clock();
    const error = await waitForReceiptOnAppNetwork({
      hash: HASH,
      app: rpc(null),
      wallet,
      appNetwork: APP,
      graceMs: 10_000,
      pollMs: 500,
      ...c,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SentElsewhereError);
    expect(c.now()).toBe(10_000);
  });

  it("does not misreport an app RPC that is only a little behind", async () => {
    // The wallet's RPC sees the receipt first; the app's gets it 2 s later.
    const c = clock();
    const app: Rpc = async (method) =>
      method === "eth_getTransactionReceipt" && c.now() >= 2_000 ? { status: "0x1" } : null;
    const wallet = rpc({ blockNumber: "0x10", blockHash: "0xcccc" });
    await expect(
      waitForReceiptOnAppNetwork({
        hash: HASH,
        app,
        wallet,
        appNetwork: APP,
        graceMs: 10_000,
        ...c,
      }),
    ).resolves.toBeUndefined();
  });

  it("times out when neither network has the transaction", async () => {
    const c = clock();
    const error = await waitForReceiptOnAppNetwork({
      hash: HASH,
      app: rpc(null),
      wallet: rpc(null),
      appNetwork: APP,
      timeoutMs: 120_000,
      ...c,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReceiptTimeoutError);
    expect((error as Error).message).toBe(
      "Monad (local fork) has not seen the transaction after 120 seconds.",
    );
  });
});
