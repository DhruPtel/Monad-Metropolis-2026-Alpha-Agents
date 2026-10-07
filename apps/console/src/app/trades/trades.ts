import {
  REJECTION_CODES,
  type RejectionCode,
  SIGNER_REASON_CODES,
  type SignerReasonCode,
  TRANSACTION_STATES,
  type TransactionState,
} from "@alpha-agents/domain";

/**
 * The Trades panel's data (P2-U4 item 12): what the orchestrator's signer and
 * the fork report, shaped for the page. Pure functions, so they are tested
 * without a browser.
 */
export interface TradingSnapshotView {
  readonly agentId: string;
  readonly owner: string;
  readonly ownerEpoch: string;
  readonly account: string | null;
  readonly grant: { readonly key: string; readonly validUntil: string } | null;
  readonly usdcE6: string;
  readonly wmonWei: string;
  readonly blockNumber: string;
}

export interface TransactionView {
  readonly txId: string;
  /** The outbox kind; absent from rows read before P2-U5, which were all swaps. */
  readonly kind?: "executor_swap" | "usdc_refund" | "usdc_settlement";
  readonly status: string;
  readonly reasonCode: string | null;
  readonly reason: string | null;
  readonly txHash: string | null;
  readonly nonce: number | null;
  readonly blockNumber: number | null;
  readonly intent: Record<string, unknown> | null;
  readonly amountOut: string | null;
  readonly balances: {
    readonly tokenIn: { readonly before: string; readonly after: string };
    readonly tokenOut: { readonly before: string; readonly after: string };
  } | null;
  readonly ledgerEntryId: string | null;
  readonly history: readonly { status: string; at: string; detail?: string }[];
  readonly createdAt: string;
}

export interface LedgerEntryView {
  readonly entryId: string;
  readonly kind: string;
  readonly lines: readonly { account: string; asset: string; amount: string }[];
}

export interface TradesView {
  readonly signerOn: boolean;
  readonly snapshot: TradingSnapshotView | null;
  /** Why the fork could not be read; the outbox still shows. */
  readonly forkError: string | null;
  readonly sessionKey: string | null;
  readonly transactions: readonly TransactionView[];
  readonly ledger: Readonly<Record<string, LedgerEntryView>>;
}

export const USDC_ADDRESS_HINT = "USDC";

export const isTransactionState = (s: string): s is TransactionState =>
  (TRANSACTION_STATES as readonly string[]).includes(s);

/** A code the design system can render, or null for one it cannot. */
export function knownReason(code: string | null): RejectionCode | SignerReasonCode | null {
  if (!code) return null;
  if ((REJECTION_CODES as readonly string[]).includes(code)) return code as RejectionCode;
  if ((SIGNER_REASON_CODES as readonly string[]).includes(code)) return code as SignerReasonCode;
  return null;
}

/** Whether the panel should keep polling: something is still between accepted and an outcome. */
export const inFlight = (txs: readonly TransactionView[]): boolean =>
  txs.some(
    (t) =>
      ["accepted", "signed", "submitted", "unknown"].includes(t.status) ||
      (t.status === "confirmed" && !t.reasonCode),
  );

/** What the transaction asks for: a swap's direction, or a credit transfer's purpose (D-261). */
export function describeSwap(t: TransactionView, usdc: string): string {
  const i = t.intent;
  if (t.kind === "usdc_refund") return "Refund credits to the owner";
  if (t.kind === "usdc_settlement") return "Settle credits to the treasury";
  if (!i) return "Not a swap";
  const buying = String(i.tokenIn).toLowerCase() === usdc.toLowerCase();
  return buying ? "Buy WMON with USDC" : "Sell WMON for USDC";
}

/** The amount the transaction moves and its token: a swap's input, or a transfer's USDC. */
export function amountOf(
  t: TransactionView,
  usdc: string,
): { value: bigint; token: string } | null {
  const i = t.intent;
  if (!i) return null;
  if (t.kind === "usdc_refund" || t.kind === "usdc_settlement")
    return typeof i.amount === "string" ? { value: BigInt(i.amount), token: usdc } : null;
  return i.amountIn === undefined
    ? null
    : { value: BigInt(String(i.amountIn)), token: String(i.tokenIn) };
}

/** Which of the setup steps are done, in order: account, funded, grant for the signer's key. */
export function setupSteps(v: TradesView) {
  const s = v.snapshot;
  const grantMatches =
    s?.grant != null &&
    v.sessionKey != null &&
    s.grant.key.toLowerCase() === v.sessionKey.toLowerCase();
  return {
    account: s?.account != null,
    funded: s != null && BigInt(s.usdcE6) > 0n,
    grant: grantMatches,
  };
}
