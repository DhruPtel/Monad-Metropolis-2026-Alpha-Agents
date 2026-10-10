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

/** A registered token as the fork lists it (F-U5). */
export interface RegisteredTokenView {
  readonly symbol: string;
  readonly token: string;
  readonly decimals: number;
  readonly lane: "NONE" | "CORE" | "SCREENED";
  readonly status: "NONE" | "BUYABLE" | "SELL_ONLY" | "FROZEN";
  readonly priceClass: "NONE" | "F" | "A";
}

export interface HoldingView {
  readonly token: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly balanceRaw: string;
  readonly freeRaw: string;
  readonly costBasisE6: string;
}

/** The agent on the fund agent's v3 set: its account, Executor v3 grant and every held token (F-U5). */
export interface TradingSnapshotV3View {
  readonly agentId: string;
  readonly owner: string;
  readonly ownerEpoch: string;
  readonly account: string | null;
  readonly v2Account: string | null;
  readonly grant: { readonly key: string; readonly validUntil: string } | null;
  readonly holdings: readonly HoldingView[];
  readonly navE6: string | null;
  readonly mode: number;
  readonly screenedOptIn: boolean;
  readonly personalCapE6: string;
  readonly blockNumber: string;
}

/** The account's balances before and after, as the signer reconciled them: v2 by side, v3 by token (lowercase address). */
export type BalancesView =
  | {
      readonly tokenIn: { readonly before: string; readonly after: string };
      readonly tokenOut: { readonly before: string; readonly after: string };
    }
  | Readonly<Record<string, { readonly before: string; readonly after: string }>>;

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
  readonly balances: BalancesView | null;
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
  /** F-U5 (D-367): the custody set serving the agent, and Executor v3's address when on it. */
  readonly custody: "v2" | "v3" | null;
  readonly executorV3: string | null;
  readonly snapshotV3: TradingSnapshotV3View | null;
  readonly tokens: readonly RegisteredTokenView[];
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

/** Symbols and decimals by lowercase address: the registry's tokens, the held ones, and USDC and WMON. */
export type SymbolBook = Readonly<Record<string, { symbol: string; decimals: number }>>;

export function symbolBook(
  v: Pick<TradesView, "tokens" | "snapshotV3">,
  usdc: string,
  wmon: string | null = null,
): SymbolBook {
  const book: Record<string, { symbol: string; decimals: number }> = {
    [usdc.toLowerCase()]: { symbol: "USDC", decimals: 6 },
  };
  if (wmon) book[wmon.toLowerCase()] = { symbol: "WMON", decimals: 18 };
  for (const t of v.tokens)
    book[t.token.toLowerCase()] = { symbol: t.symbol, decimals: t.decimals };
  for (const h of v.snapshotV3?.holdings ?? [])
    book[h.token.toLowerCase()] = { symbol: h.symbol, decimals: h.decimals };
  return book;
}

/** Whether the transaction is a swap on the fund agent's v3 set: its intent is schema 2 and names a route. */
export const isV3Swap = (t: TransactionView): boolean => Number(t.intent?.schemaVersion) === 2;

/**
 * A token's symbol and decimals: from the book, else USDC by address, else
 * WMON for a v2 swap (the only other token there), else the address's start
 * for a v3 token the fork has not named.
 */
export function tokenOf(token: unknown, usdc: string, book: SymbolBook = {}, v3 = false) {
  const key = String(token).toLowerCase();
  if (book[key]) return book[key];
  if (key === usdc.toLowerCase()) return { symbol: "USDC", decimals: 6 };
  return v3
    ? { symbol: `${key.slice(0, 6)}..${key.slice(-4)}`, decimals: 18 }
    : { symbol: "WMON", decimals: 18 };
}

/** What the transaction asks for: a swap's direction, or a credit transfer's purpose (D-261); a v3 swap names both tokens and its hops. */
export function describeSwap(t: TransactionView, usdc: string, book: SymbolBook = {}): string {
  const i = t.intent;
  if (t.kind === "usdc_refund") return "Refund credits to the owner";
  if (t.kind === "usdc_settlement") return "Settle credits to the treasury";
  if (!i) return "Not a swap";
  if (Number(i.schemaVersion) === 2) {
    const hops = Array.isArray(i.route) ? i.route.length : 0;
    return `Swap ${tokenOf(i.tokenIn, usdc, book, true).symbol} for ${tokenOf(i.tokenOut, usdc, book, true).symbol} over ${hops} hop${hops === 1 ? "" : "s"}`;
  }
  const buying = String(i.tokenIn).toLowerCase() === usdc.toLowerCase();
  return buying ? "Buy WMON with USDC" : "Sell WMON for USDC";
}

/** Every balance change the signer recorded for the transaction, one row per token, the sold token first. */
export function balanceRows(
  t: TransactionView,
  usdc: string,
  book: SymbolBook = {},
): { token: string; symbol: string; decimals: number; before: bigint; after: bigint }[] {
  const b = t.balances;
  const i = t.intent;
  if (!b || !i) return [];
  const v3 = isV3Swap(t);
  const row = (token: string, x: { before: string; after: string }) => ({
    token,
    ...tokenOf(token, usdc, book, v3),
    before: BigInt(x.before),
    after: BigInt(x.after),
  });
  if ("tokenIn" in b && "tokenOut" in b && typeof b.tokenIn === "object" && "before" in b.tokenIn) {
    const v2 = b as {
      tokenIn: { before: string; after: string };
      tokenOut: { before: string; after: string };
    };
    return [row(String(i.tokenIn), v2.tokenIn), row(String(i.tokenOut), v2.tokenOut)];
  }
  const byToken = b as Readonly<Record<string, { before: string; after: string }>>;
  const order = [String(i.tokenIn).toLowerCase(), String(i.tokenOut).toLowerCase()];
  const keys = Object.keys(byToken).sort((x, y) => {
    const ix = order.indexOf(x);
    const iy = order.indexOf(y);
    return (ix === -1 ? 2 : ix) - (iy === -1 ? 2 : iy);
  });
  return keys.map((k) => row(k, byToken[k] as { before: string; after: string }));
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

/** The v3 setup steps: a fund account, something deposited, a grant on Executor v3 for the signer's key. */
export function setupStepsV3(v: Pick<TradesView, "snapshotV3" | "sessionKey">) {
  const s = v.snapshotV3;
  const grantMatches =
    s?.grant != null &&
    v.sessionKey != null &&
    s.grant.key.toLowerCase() === v.sessionKey.toLowerCase();
  return {
    account: s?.account != null,
    funded: s != null && s.holdings.some((h) => BigInt(h.balanceRaw) > 0n),
    grant: grantMatches,
  };
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
