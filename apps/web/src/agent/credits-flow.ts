import type { Hex } from "viem";
import {
  type WalletStep,
  type WalletTxDeps,
  type WalletTxProgress,
  runWalletSteps,
} from "./wallet-tx";

/**
 * Add credits from the app (Phase 2 tuning): one wallet transaction sends USDC
 * from the connected wallet to the agent's funding address, through the
 * shared step flow (network guard, the wallet's own provider, the receipt on
 * the app's network), and then the platform's crediting is followed until the
 * deposit shows in the agent's credits, held part included. The sender is
 * recorded as the contributor by the index, as for any transfer in (D-242).
 * Pure: the app passes the steps in, so tests drive every state.
 */

export interface CreditTotals {
  readonly credits: bigint;
  readonly held: bigint;
}

export interface CreditsFlowDeps<C> extends WalletTxDeps<C> {
  /** The agent's credits and held USDC as the platform has credited them. */
  readonly readCredits: () => Promise<CreditTotals>;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long to follow the crediting; it happens within seconds of the receipt. */
  readonly creditTimeoutMs?: number;
  readonly pollMs?: number;
}

export interface CreditsProgress extends WalletTxProgress {
  /** Set once credited: how much became credits and how much is held above the cap. */
  readonly credited?: bigint;
  readonly held?: bigint;
}

export async function runAddCredits<C>(
  deps: CreditsFlowDeps<C>,
  step: WalletStep<C>,
  amount: bigint,
  report: (p: CreditsProgress) => void,
): Promise<CreditsProgress> {
  const finish = (p: CreditsProgress) => {
    report(p);
    return p;
  };
  const before = await deps.readCredits().catch(() => null);
  const sent = await runWalletSteps(deps, [step], report);
  // Declined, failed or sent elsewhere: the step flow already reported it.
  if (sent.state !== "confirmed") return sent;
  if (!before)
    return finish({
      ...sent,
      message: "Sent. Your credits update as soon as the platform credits it.",
    });
  const hash = sent.hash as Hex | undefined;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (deps.creditTimeoutMs ?? 120_000);
  report({ state: "confirming", ...(hash ? { hash } : {}), message: "crediting" });
  while (Date.now() < deadline) {
    const now = await deps.readCredits().catch(() => null);
    if (now) {
      const credited = now.credits - before.credits;
      const held = now.held - before.held;
      if (credited + held >= amount)
        return finish({ state: "confirmed", ...(hash ? { hash } : {}), credited, held });
    }
    await sleep(deps.pollMs ?? 2_000);
  }
  return finish({
    state: "confirmed",
    ...(hash ? { hash } : {}),
    message: "Sent. The platform has not credited it yet; it shows here as soon as it does.",
  });
}

/** One line for the owner about adding credits. */
export function creditsText(p: CreditsProgress, usdc: (v: bigint) => string): string | null {
  if (p.state === "confirming" && p.message === "crediting")
    return "Sent. Waiting for the platform to credit it.";
  if (p.state !== "confirmed") return null;
  if (p.credited === undefined) return p.message ?? "Sent.";
  if (p.held && p.held > 0n)
    return `Credited ${usdc(p.credited)} USDC. ${usdc(p.held)} USDC above the cap is held for you, not lost.`;
  return `Credited ${usdc(p.credited)} USDC.`;
}
