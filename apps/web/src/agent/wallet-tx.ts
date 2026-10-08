import { type Address, BaseError, type Hex } from "viem";
import { isUserRejection } from "@/auth/session";
import { CUSTODY_REVERT_MESSAGES, custodyRevertName, staleFeedRevertMessage } from "./custody";
import type { NetworkCheck } from "./network-check";
import { ReceiptTimeoutError, SentElsewhereError } from "./receipt-watch";
import { StuckNonceError } from "./stuck-nonce";

/**
 * One owner action as a sequence of wallet transactions (P2-U7): open the
 * account; approve exactly the amount, then deposit; withdraw; claim. The
 * wallet's network is checked once before anything is sent, each step is
 * sent through the connected wallet's own provider and confirmed by its
 * receipt on the app's network, and every outcome is reported: waiting in the
 * wallet, confirming, confirmed, declined, or failed with the contract's
 * reason. Pure: the app passes the steps in, so tests drive every state.
 */

export interface WalletStep<C> {
  /** What the wallet is asked to do, in the owner's words ("Approve 25 USDC"). */
  readonly label: string;
  readonly call: C;
}

export interface WalletTxDeps<C> {
  readonly checkNetwork: () => Promise<NetworkCheck>;
  /** Sends the call from the connected wallet; resolves to the transaction hash. */
  readonly send: (call: C) => Promise<Hex>;
  /** Waits for the receipt on the app's network; resolves to whether it succeeded. */
  readonly waitForReceipt: (hash: Hex) => Promise<"success" | "reverted">;
  /** USDC's address, so a stale-feed refusal names USDC/USD rather than MON/USD (L-145). */
  readonly usdc?: Address | undefined;
}

export type WalletTxState =
  "checking" | "waiting-wallet" | "confirming" | "confirmed" | "rejected" | "failed";

export interface WalletTxProgress {
  readonly state: WalletTxState;
  /** 1-based step, of `steps`. */
  readonly step?: number;
  readonly steps?: number;
  readonly label?: string;
  readonly hash?: Hex;
  readonly message?: string;
}

/** The owner-facing reason for a failed send: the contract's own revert when it has one. */
export function sendFailure(error: unknown, label: string, usdc?: Address): string {
  const stale = staleFeedRevertMessage(error, usdc);
  if (stale) return stale;
  const name = custodyRevertName(error);
  if (name && CUSTODY_REVERT_MESSAGES[name]) return CUSTODY_REVERT_MESSAGES[name];
  if (name) return `${label} was refused by the contract (${name}).`;
  // The wallet's own short reason, so a failure says which check failed (L-55).
  const why =
    error instanceof BaseError
      ? error.shortMessage
      : error instanceof Error
        ? error.message.split("\n")[0]
        : undefined;
  return `The wallet could not send this: ${label.toLowerCase()}${why ? ` (${why})` : ""}.`;
}

export async function runWalletSteps<C>(
  deps: WalletTxDeps<C>,
  steps: readonly WalletStep<C>[],
  report: (p: WalletTxProgress) => void,
): Promise<WalletTxProgress> {
  const finish = (p: WalletTxProgress) => {
    report(p);
    return p;
  };
  report({ state: "checking" });
  const network = await deps.checkNetwork().catch((): NetworkCheck => ({
    ok: false,
    reason: "wallet-unreachable",
    message: "Could not check which network your wallet is on. Try again.",
  }));
  if (!network.ok) return finish({ state: "failed", message: network.message });

  let hash: Hex | undefined;
  for (const [i, s] of steps.entries()) {
    const where = { step: i + 1, steps: steps.length, label: s.label };
    report({ state: "waiting-wallet", ...where });
    try {
      hash = await deps.send(s.call);
    } catch (error) {
      if (isUserRejection(error)) return finish({ state: "rejected", ...where });
      return finish({ state: "failed", ...where, message: sendFailure(error, s.label, deps.usdc) });
    }
    report({ state: "confirming", ...where, hash });
    try {
      const outcome = await deps.waitForReceipt(hash);
      if (outcome === "reverted")
        return finish({
          state: "failed",
          ...where,
          hash,
          message: `${s.label} failed on chain; nothing changed from this step.`,
        });
    } catch (error) {
      if (
        error instanceof SentElsewhereError ||
        error instanceof StuckNonceError ||
        error instanceof ReceiptTimeoutError
      )
        return finish({ state: "failed", ...where, hash, message: error.message });
      return finish({
        state: "failed",
        ...where,
        hash,
        message: `Could not confirm "${s.label}".`,
      });
    }
  }
  return finish({
    state: "confirmed",
    step: steps.length,
    steps: steps.length,
    ...(hash ? { hash } : {}),
  });
}

/** One line for the owner about where an action is. */
export function walletTxText(p: WalletTxProgress): string {
  const of = p.steps && p.steps > 1 ? ` (step ${p.step} of ${p.steps})` : "";
  switch (p.state) {
    case "checking":
      return "Checking your wallet's network.";
    case "waiting-wallet":
      return `Waiting for your wallet: ${p.label ?? "confirm the request"}${of}.`;
    case "confirming":
      return `Sent. Waiting for the network to confirm${of}.`;
    case "confirmed":
      return "Confirmed.";
    case "rejected":
      return "You declined the request in your wallet; nothing was sent.";
    case "failed":
      return p.message ?? "The transaction failed.";
  }
}
