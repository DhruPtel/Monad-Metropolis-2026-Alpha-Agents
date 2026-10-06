import { formatAmount } from "@alpha-agents/domain";
import type { ChargeItem, FundingView, WalletState } from "@alpha-agents/ui";
import type { AgentSummaryJson, RefundJson, RunStatus } from "@/api/client";
import type { AgentsStatus } from "./use-agents";

/**
 * The My Agents page's rules (P1-U9, D-218), as pure functions so every state
 * is tested without a browser: which page state to show, what an owner may do
 * now and why not, and the plain words for each result.
 */
export type PageState =
  | "logged-out"
  | "connecting"
  | "wrong-chain"
  | "not-deployed"
  | "loading"
  | "error"
  | "empty"
  | "agents";

export function myAgentsPageState(
  wallet: { readonly state: WalletState; readonly ready: boolean },
  owned: { readonly status: AgentsStatus; readonly count: number },
): PageState {
  if (!wallet.ready) {
    if (wallet.state === "wrong-chain") return "wrong-chain";
    if (wallet.state === "connecting") return "connecting";
    return "logged-out";
  }
  if (owned.status === "not-deployed") return "not-deployed";
  if (owned.status === "loading") return "loading";
  if (owned.status === "error" && owned.count === 0) return "error";
  return owned.count === 0 ? "empty" : "agents";
}

const usdc = (e6: bigint, digits = 4) => formatAmount(e6, 6, { maxFractionDigits: digits });

/** The summary's amounts as bigints, in the design system's shapes. */
export interface SummaryView {
  readonly runStatus: RunStatus;
  readonly funding: FundingView | null;
  readonly spendable: bigint;
  readonly held: bigint;
  readonly spent24h: bigint;
  readonly charges: readonly ChargeItem[];
  readonly latestScan: AgentSummaryJson["latestScan"];
  readonly scanMinimum: bigint;
  readonly scanEstimate: { readonly low: bigint; readonly high: bigint };
  readonly ownerEpoch: bigint;
}

export function summaryView(s: AgentSummaryJson): SummaryView {
  const spendable = BigInt(s.credits?.spendableUsdcE6 ?? "0");
  const held = BigInt(s.credits?.heldUsdcE6 ?? "0");
  return {
    runStatus: s.runStatus,
    funding: s.credits
      ? { fundingAddress: s.credits.fundingAddress, spendableUsdcE6: spendable, heldUsdcE6: held }
      : null,
    spendable,
    held,
    spent24h: BigInt(s.spent24hUsdcE6),
    charges: s.charges.map((c) => ({ ...c, amountUsdcE6: BigInt(c.amountUsdcE6) })),
    latestScan: s.latestScan,
    scanMinimum: BigInt(s.scan.minimumUsdcE6),
    scanEstimate: {
      low: BigInt(s.scan.estimateUsdcE6.low),
      high: BigInt(s.scan.estimateUsdcE6.high),
    },
    ownerEpoch: BigInt(s.ownerEpoch),
  };
}

/** Whether a Scan is queued or running now. */
export const scanOpen = (v: SummaryView): boolean =>
  v.latestScan?.status === "queued" || v.latestScan?.status === "running";

export type Availability =
  { readonly enabled: true } | { readonly enabled: false; readonly reason: string };

/** Whether the owner can run a Scan now, and if not, why, in plain words. */
export function scanAvailability(v: SummaryView): Availability {
  if (v.runStatus === "awaiting_reveal")
    return { enabled: false, reason: "Scans start once the agent is revealed and set up." };
  if (v.runStatus === "provisioning" || v.runStatus === "failed" || v.runStatus === "stopped")
    return { enabled: false, reason: "Scans start once the agent is set up." };
  if (scanOpen(v)) return { enabled: false, reason: "A Scan is already queued or running." };
  if (v.spendable < v.scanMinimum)
    return {
      enabled: false,
      reason: `A Scan needs at least ${usdc(v.scanMinimum, 2)} USDC of credits. Add USDC to the funding address.`,
    };
  return { enabled: true };
}

/** Whether the owner can ask for a refund: only with something to return. */
export function refundAvailability(v: SummaryView): Availability {
  if (v.spendable + v.held === 0n)
    return { enabled: false, reason: "There are no credits to refund." };
  return { enabled: true };
}

/** A-31's estimate in words, for the Scan confirmation. */
export const scanCostText = (v: SummaryView): string => {
  const two = (e6: bigint) => formatAmount(e6, 6, { maxFractionDigits: 2, minFractionDigits: 2 });
  return `about ${two(v.scanEstimate.low)} to ${two(v.scanEstimate.high)} USDC`;
};

/** What is being refunded, for the refund confirmation. */
export const refundAmountText = (v: SummaryView): string =>
  v.held > 0n
    ? `${usdc(v.spendable)} USDC of credits and ${usdc(v.held)} USDC held above the cap`
    : `${usdc(v.spendable)} USDC of credits`;

const STOP_WORDS: Readonly<Record<string, string>> = {
  COMPLETED: "completed",
  BILLING: "stopped: its credits ran out",
  DEADLINE: "stopped at its time limit",
  NO_STAGE_RECORD: "ended without a result",
  FAILED: "failed",
};

/** The latest Scan in one line, or null before the first. */
export function scanStatusText(v: SummaryView): string | null {
  const s = v.latestScan;
  if (!s) return null;
  if (s.status === "queued") return "Scan queued: it starts within a few seconds.";
  if (s.status === "running") return "Scan running: the agent is researching now.";
  const when = (s.finishedAt ?? s.createdAt).slice(11, 16);
  const outcome = s.stopReason
    ? (STOP_WORDS[s.stopReason] ?? "ended")
    : s.status === "succeeded"
      ? "completed"
      : "failed";
  return `Last Scan ${outcome} at ${when} UTC.`;
}

/** A finished refund in plain words; null while it is still on its way. */
export function refundOutcomeText(
  r: RefundJson,
): { readonly ok: boolean; readonly text: string } | null {
  if (r.status === "sent") {
    const total = BigInt(r.creditsUsdcE6 ?? "0") + BigInt(r.heldUsdcE6 ?? "0");
    return { ok: true, text: `Refunded ${usdc(total)} USDC to your wallet.` };
  }
  if (r.status === "refused")
    return { ok: false, text: `The refund was refused${r.reason ? `: ${r.reason}` : "."}` };
  if (r.status === "failed")
    return { ok: false, text: `The refund failed${r.reason ? `: ${r.reason}` : "."} Try again.` };
  return null;
}
