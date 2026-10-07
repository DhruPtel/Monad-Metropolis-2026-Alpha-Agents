import type { Address, Hex } from "viem";
import type { Rpc } from "./network-check";

/**
 * Stuck transactions on the local fork (P2-U1 step 0).
 *
 * A wallet numbers its transactions from its own history. After the local
 * fork is reset, the fork's count for the account starts again from the
 * pinned block, while the wallet still remembers the old fork's transactions,
 * so it sends with a nonce higher than the fork expects. Anvil keeps such a
 * transaction in its queue forever, and the mint waits on a receipt that never
 * comes. This compares the transaction's nonce (and anything queued for the
 * account in anvil's txpool) with the fork's account nonce, and names the fix.
 *
 * Local fork only: on a real network a nonce ahead of the confirmed count is
 * normal while earlier transactions are pending, so callers pass `localFork`.
 */
export interface NonceReport {
  /** The fork's next nonce for the account (its confirmed transaction count). */
  readonly forkNonce: number;
  /** Nonces anvil holds in its queue for the account, lowest first. */
  readonly queued: readonly number[];
  /** The nonce of the transaction asked about, when the fork has seen it. */
  readonly txNonce?: number;
}

export interface StuckNonce {
  /** The nonce the wallet used: the transaction's, or the lowest queued one. */
  readonly walletNonce: number;
  readonly forkNonce: number;
  readonly queuedCount: number;
}

/** What to do about it, for the wallets this app supports. */
export const STUCK_NONCE_FIX =
  "Reset your wallet's activity for the Monad (local fork) network: in MetaMask, select that network, then Settings, Advanced, Clear activity tab data (newer versions call it Clear activity and nonce data); in OKX Wallet, clear the pending transactions for that network. Then try again. On the local stack the dev console's Fork page can also drop the queued transactions or align the account's nonce.";

export class StuckNonceError extends Error {
  readonly stuck: StuckNonce;

  constructor(stuck: StuckNonce) {
    super(
      `Your wallet sent this transaction with nonce ${stuck.walletNonce}, but the local fork expects nonce ${stuck.forkNonce}, so the fork is holding it and it will never confirm. This happens after the local fork is reset while your wallet remembers the old fork's transactions. ${STUCK_NONCE_FIX}`,
    );
    this.name = "StuckNonceError";
    this.stuck = stuck;
  }
}

const toNumber = (v: unknown): number | undefined => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) return undefined;
  const n = Number.parseInt(v, 16);
  return Number.isSafeInteger(n) ? n : undefined;
};

/**
 * Reads the fork's nonce for `address`, the nonces anvil has queued for it,
 * and, given a hash, that transaction's nonce. A node without the txpool
 * methods (any real network) reports nothing queued.
 */
export async function readNonceReport(
  app: Rpc,
  address: Address,
  hash?: Hex,
): Promise<NonceReport> {
  const forkNonce = toNumber(await app("eth_getTransactionCount", [address, "latest"]));
  if (forkNonce === undefined) throw new Error("the app's RPC returned no nonce");
  const pool = (await app("txpool_content", []).catch(() => null)) as {
    queued?: Record<string, Record<string, unknown>>;
  } | null;
  const mine = Object.entries(pool?.queued ?? {}).find(
    ([from]) => from.toLowerCase() === address.toLowerCase(),
  )?.[1];
  const queued = Object.keys(mine ?? {})
    .map((k) => Number(k))
    .filter((n) => Number.isSafeInteger(n))
    .sort((a, b) => a - b);
  let txNonce: number | undefined;
  if (hash) {
    const tx = (await app("eth_getTransactionByHash", [hash]).catch(() => null)) as {
      nonce?: unknown;
      blockNumber?: unknown;
    } | null;
    // A mined transaction is never stuck.
    if (tx && !tx.blockNumber) txNonce = toNumber(tx.nonce);
  }
  return { forkNonce, queued, ...(txNonce === undefined ? {} : { txNonce }) };
}

/** The gap, when the wallet is ahead of the fork; null when nothing is stuck. */
export function stuckNonce(r: NonceReport): StuckNonce | null {
  const ahead = r.queued.filter((n) => n > r.forkNonce);
  if (r.txNonce !== undefined && r.txNonce > r.forkNonce)
    return {
      walletNonce: r.txNonce,
      forkNonce: r.forkNonce,
      queuedCount: Math.max(ahead.length, 1),
    };
  const lowest = ahead[0];
  if (lowest === undefined) return null;
  return { walletNonce: lowest, forkNonce: r.forkNonce, queuedCount: ahead.length };
}
