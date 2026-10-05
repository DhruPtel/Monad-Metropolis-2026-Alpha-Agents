import type { Hex } from "viem";
import type { Rpc } from "./network-check";

/**
 * Waits for a sent transaction's receipt on the RPC the app reads, and says
 * plainly when the wallet sent it to another network instead (P1-U11, L-53).
 *
 * The app polls its own RPC. While the receipt is missing there, it also asks
 * the wallet's provider. If the wallet's network has the receipt:
 * - and the app's RPC has a block at that number with another hash, the two
 *   are different chains, and the wait ends at once;
 * - and the app's RPC has no block at that number yet, it may only be behind,
 *   so the wait ends after a grace period.
 */
export class SentElsewhereError extends Error {
  constructor(appNetwork: string) {
    super(
      `Your wallet sent the transaction to a different network than this app reads: your wallet's network has it, ${appNetwork} does not. Nothing happened on ${appNetwork}. Check your wallet's network settings and try again.`,
    );
    this.name = "SentElsewhereError";
  }
}

export class ReceiptTimeoutError extends Error {
  constructor(appNetwork: string, seconds: number) {
    super(`${appNetwork} has not seen the transaction after ${seconds} seconds.`);
    this.name = "ReceiptTimeoutError";
  }
}

export interface ReceiptWatch {
  readonly hash: Hex;
  readonly app: Rpc;
  readonly wallet: Rpc;
  /** The app's network, named for the user. */
  readonly appNetwork: string;
  readonly timeoutMs?: number;
  /** How long a receipt seen only on the wallet's network may wait for the app's. */
  readonly graceMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface RawReceipt {
  readonly blockNumber?: string;
  readonly blockHash?: string;
}

/** Resolves once the app's RPC has the receipt; throws SentElsewhereError or ReceiptTimeoutError. */
export async function waitForReceiptOnAppNetwork(watch: ReceiptWatch): Promise<void> {
  const { hash, app, wallet, appNetwork } = watch;
  const timeoutMs = watch.timeoutMs ?? 120_000;
  const graceMs = watch.graceMs ?? 10_000;
  const pollMs = watch.pollMs ?? 500;
  const now = watch.now ?? Date.now;
  const sleep = watch.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  let seenOnlyByWallet: number | undefined;

  for (;;) {
    // No receipt yet is not a failure (L-10): keep polling.
    if (await app("eth_getTransactionReceipt", [hash]).catch(() => null)) return;

    const elsewhere = (await wallet("eth_getTransactionReceipt", [hash]).catch(
      () => null,
    )) as RawReceipt | null;
    if (elsewhere?.blockNumber) {
      const ours = (await app("eth_getBlockByNumber", [elsewhere.blockNumber, false]).catch(
        () => null,
      )) as { hash?: string } | null;
      if (ours?.hash && ours.hash.toLowerCase() !== elsewhere.blockHash?.toLowerCase()) {
        throw new SentElsewhereError(appNetwork);
      }
      seenOnlyByWallet ??= now();
      if (now() - seenOnlyByWallet >= graceMs) throw new SentElsewhereError(appNetwork);
    }

    if (now() - start >= timeoutMs) {
      throw new ReceiptTimeoutError(appNetwork, Math.round(timeoutMs / 1000));
    }
    await sleep(pollMs);
  }
}
