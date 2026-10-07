import { describe, expect, it } from "vitest";
import type { Rpc } from "./network-check";
import { waitForReceiptOnAppNetwork } from "./receipt-watch";
import { STUCK_NONCE_FIX, StuckNonceError, readNonceReport, stuckNonce } from "./stuck-nonce";

const WALLET = "0x683eE842A16f85e69883F433745263BFe8D55f76" as const;
const HASH = `0x${"8b".repeat(32)}` as const;

/** An app RPC like anvil's: the account's nonce, its txpool queue, and one transaction. */
function fork(o: {
  nonce: number;
  queued?: number[];
  tx?: { nonce: number; mined?: boolean } | null;
  noTxpool?: boolean;
}): Rpc {
  return async (method, params) => {
    if (method === "eth_getTransactionCount") {
      expect(params).toEqual([WALLET, "latest"]);
      return `0x${o.nonce.toString(16)}`;
    }
    if (method === "txpool_content") {
      if (o.noTxpool) throw new Error("the method txpool_content does not exist");
      // anvil keys the queue by checksummed sender, then by decimal nonce.
      const mine = Object.fromEntries((o.queued ?? []).map((n) => [String(n), { hash: HASH }]));
      return { pending: {}, queued: o.queued ? { [WALLET]: mine } : {} };
    }
    if (method === "eth_getTransactionByHash")
      return o.tx
        ? { nonce: `0x${o.tx.nonce.toString(16)}`, blockNumber: o.tx.mined ? "0x10" : null }
        : null;
    if (method === "eth_getTransactionReceipt") return null;
    throw new Error(`unexpected ${method}`);
  };
}

describe("stuck transactions on the local fork (P2-U1 step 0)", () => {
  it("names a transaction sent with a nonce ahead of the fork's", async () => {
    const r = await readNonceReport(
      fork({ nonce: 0, queued: [3], tx: { nonce: 3 } }),
      WALLET,
      HASH,
    );
    expect(r).toEqual({ forkNonce: 0, queued: [3], txNonce: 3 });
    expect(stuckNonce(r)).toEqual({ walletNonce: 3, forkNonce: 0, queuedCount: 1 });
  });

  it("sees queued transactions on page load, before anything is sent", async () => {
    const r = await readNonceReport(fork({ nonce: 2, queued: [7, 5] }), WALLET);
    expect(r.queued).toEqual([5, 7]);
    expect(stuckNonce(r)).toEqual({ walletNonce: 5, forkNonce: 2, queuedCount: 2 });
  });

  it("is not stuck when the nonces agree, the transaction is mined, or nothing is queued", async () => {
    expect(
      stuckNonce(await readNonceReport(fork({ nonce: 3, tx: { nonce: 3 } }), WALLET, HASH)),
    ).toBeNull();
    expect(
      stuckNonce(
        await readNonceReport(fork({ nonce: 0, tx: { nonce: 3, mined: true } }), WALLET, HASH),
      ),
    ).toBeNull();
    expect(stuckNonce(await readNonceReport(fork({ nonce: 4 }), WALLET))).toBeNull();
    // A node without txpool methods (a real network) reports nothing queued.
    expect(
      stuckNonce(await readNonceReport(fork({ nonce: 4, noTxpool: true }), WALLET)),
    ).toBeNull();
  });

  it("says which nonces disagree and how to fix it", () => {
    const e = new StuckNonceError({ walletNonce: 3, forkNonce: 0, queuedCount: 1 });
    expect(e.message).toContain("nonce 3, but the local fork expects nonce 0");
    expect(e.message).toContain("Clear activity tab data");
    expect(e.message).toContain(STUCK_NONCE_FIX);
  });

  it("ends the receipt wait at once with the stuck error instead of waiting two minutes", async () => {
    let t = 0;
    const app = fork({ nonce: 0, queued: [3], tx: { nonce: 3 } });
    const wait = waitForReceiptOnAppNetwork({
      hash: HASH,
      app,
      wallet: async () => null,
      appNetwork: "Monad (local fork)",
      now: () => t,
      sleep: async (ms) => void (t += ms),
      stuckCheck: async () => {
        const gap = stuckNonce(await readNonceReport(app, WALLET, HASH));
        return gap ? new StuckNonceError(gap) : null;
      },
    });
    await expect(wait).rejects.toBeInstanceOf(StuckNonceError);
    expect(t).toBeLessThan(10_000);
  });
});
