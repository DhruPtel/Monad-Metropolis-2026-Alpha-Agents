import { type Hex, decodeEventLog, isAddressEqual } from "viem";
import {
  EXECUTOR_ABI,
  EXECUTOR_V3_ABI,
  type SwapIntentArgs,
  type SwapIntentV3Args,
} from "./abi.ts";
import type { ChainClient, Receipt } from "./chain.ts";

/**
 * Reconciliation (P2-U4 item 8): a confirmed swap is settled in the ledger
 * only when the Executor's IntentExecuted event for this action and the
 * account's own balance changes across the block agree. Anything else is
 * flagged and left for a person: the ledger never records a trade the chain
 * does not show. The comparison is per block, so another transfer to the
 * same account in the same block is flagged too, which is the safe side.
 */
export interface ExecutedEvent {
  readonly actionId: Hex;
  readonly account: Hex;
  readonly agentId: bigint;
  readonly tokenIn: Hex;
  readonly tokenOut: Hex;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly oraclePriceE18: bigint;
  readonly navBefore: bigint;
  readonly navAfter: bigint;
}

export interface BalanceDeltas {
  readonly tokenIn: { readonly before: string; readonly after: string };
  readonly tokenOut: { readonly before: string; readonly after: string };
}

export type Reconciliation =
  | { readonly ok: true; readonly event: ExecutedEvent; readonly balances: BalanceDeltas }
  | { readonly ok: false; readonly reason: string; readonly balances: BalanceDeltas | null };

/** The IntentExecuted event for this action, from the Executor, if the receipt has one. */
export function executedEvent(
  receipt: Receipt,
  executor: Hex,
  actionId: Hex,
): ExecutedEvent | null {
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, executor)) continue;
    try {
      const d = decodeEventLog({
        abi: EXECUTOR_ABI,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
      if (d.eventName !== "IntentExecuted") continue;
      if (d.args.actionId.toLowerCase() !== actionId.toLowerCase()) continue;
      return d.args as ExecutedEvent;
    } catch {
      // another event
    }
  }
  return null;
}

export async function reconcileSwap(
  chain: ChainClient,
  receipt: Receipt,
  executor: Hex,
  intent: SwapIntentArgs,
): Promise<Reconciliation> {
  const block = receipt.blockNumber;
  const [inBefore, inAfter, outBefore, outAfter] = await Promise.all([
    chain.tokenBalance(intent.tokenIn, intent.account, block - 1n),
    chain.tokenBalance(intent.tokenIn, intent.account, block),
    chain.tokenBalance(intent.tokenOut, intent.account, block - 1n),
    chain.tokenBalance(intent.tokenOut, intent.account, block),
  ]);
  const balances: BalanceDeltas = {
    tokenIn: { before: inBefore.toString(), after: inAfter.toString() },
    tokenOut: { before: outBefore.toString(), after: outAfter.toString() },
  };
  const fail = (reason: string): Reconciliation => ({ ok: false, reason, balances });

  const event = executedEvent(receipt, executor, intent.actionId);
  if (!event) return fail("the receipt has no IntentExecuted event for this action");
  if (!isAddressEqual(event.account, intent.account))
    return fail("the event names another account");
  if (event.agentId !== intent.agentId) return fail("the event names another agent");
  if (
    !isAddressEqual(event.tokenIn, intent.tokenIn) ||
    !isAddressEqual(event.tokenOut, intent.tokenOut)
  )
    return fail("the event's tokens differ from the intent's");
  if (event.amountIn !== intent.amountIn)
    return fail(`the event spent ${event.amountIn}, the intent ${intent.amountIn}`);
  if (event.amountOut < intent.minAmountOut)
    return fail(`the event received ${event.amountOut}, below the minimum ${intent.minAmountOut}`);
  const spent = inBefore - inAfter;
  const received = outAfter - outBefore;
  if (spent !== event.amountIn)
    return fail(`the account's balance fell by ${spent}, the event says ${event.amountIn}`);
  if (received !== event.amountOut)
    return fail(`the account's balance rose by ${received}, the event says ${event.amountOut}`);
  return { ok: true, event, balances };
}

// ---- Executor v3 (F-U5) ----

/** Executor v3's IntentExecuted record: each side priced on its own, the route hashed. */
export interface ExecutedEventV3 {
  readonly actionId: Hex;
  readonly account: Hex;
  readonly agentId: bigint;
  readonly tokenIn: Hex;
  readonly tokenOut: Hex;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly priceInE18: bigint;
  readonly priceOutE18: bigint;
  readonly navBefore: bigint;
  readonly navAfter: bigint;
  readonly routeHash: Hex;
}

/** Every token the trade touched, keyed by its lowercase address: the account's balance before and after. */
export type TokenDeltas = Readonly<
  Record<string, { readonly before: string; readonly after: string }>
>;

export type ReconciliationV3 =
  | { readonly ok: true; readonly event: ExecutedEventV3; readonly balances: TokenDeltas }
  | { readonly ok: false; readonly reason: string; readonly balances: TokenDeltas | null };

/** Executor v3's IntentExecuted event for this action, if the receipt has one. */
export function executedEventV3(
  receipt: Receipt,
  executor: Hex,
  actionId: Hex,
): ExecutedEventV3 | null {
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, executor)) continue;
    try {
      const d = decodeEventLog({
        abi: EXECUTOR_V3_ABI,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
      if (d.eventName !== "IntentExecuted") continue;
      if (d.args.actionId.toLowerCase() !== actionId.toLowerCase()) continue;
      const r = d.args.record;
      return {
        actionId: d.args.actionId,
        account: d.args.account,
        agentId: d.args.agentId,
        tokenIn: r.tokenIn,
        tokenOut: r.tokenOut,
        amountIn: r.amountIn,
        amountOut: r.amountOut,
        priceInE18: r.priceInE18,
        priceOutE18: r.priceOutE18,
        navBefore: r.navBefore,
        navAfter: r.navAfter,
        routeHash: r.routeHash,
      };
    } catch {
      // another event
    }
  }
  return null;
}

/**
 * Reconciliation across many tokens (F-U5): a v3 swap is settled only when
 * Executor v3's event for this action and the account's balance changes of
 * every token the route touched agree. The token sold must have fallen by
 * exactly the event's `amountIn`, the token bought risen by exactly its
 * `amountOut`, and every token between them (the route's hops pay the
 * account nothing in them) must not have moved at all. `routeTokens` is every
 * token the route crosses, the two ends included or not.
 */
export async function reconcileSwapV3(
  chain: ChainClient,
  receipt: Receipt,
  executor: Hex,
  intent: SwapIntentV3Args,
  routeTokens: readonly Hex[],
): Promise<ReconciliationV3> {
  const block = receipt.blockNumber;
  const tokens: Hex[] = [];
  for (const t of [intent.tokenIn, intent.tokenOut, ...routeTokens])
    if (!tokens.some((x) => isAddressEqual(x, t))) tokens.push(t);
  const reads = await Promise.all(
    tokens.map(async (t) => {
      const [before, after] = await Promise.all([
        chain.tokenBalance(t, intent.account, block - 1n),
        chain.tokenBalance(t, intent.account, block),
      ]);
      return [t.toLowerCase(), { before, after }] as const;
    }),
  );
  const balances: TokenDeltas = Object.fromEntries(
    reads.map(([t, b]) => [t, { before: b.before.toString(), after: b.after.toString() }]),
  );
  const fail = (reason: string): ReconciliationV3 => ({ ok: false, reason, balances });
  const event = executedEventV3(receipt, executor, intent.actionId);
  if (!event) return fail("the receipt has no IntentExecuted event for this action");
  if (!isAddressEqual(event.account, intent.account))
    return fail("the event names another account");
  if (event.agentId !== intent.agentId) return fail("the event names another agent");
  if (
    !isAddressEqual(event.tokenIn, intent.tokenIn) ||
    !isAddressEqual(event.tokenOut, intent.tokenOut)
  )
    return fail("the event's tokens differ from the intent's");
  if (event.amountIn !== intent.amountIn)
    return fail(`the event spent ${event.amountIn}, the intent ${intent.amountIn}`);
  if (event.amountOut < intent.minAmountOut)
    return fail(`the event received ${event.amountOut}, below the minimum ${intent.minAmountOut}`);
  for (const [t, b] of reads) {
    const delta = b.after - b.before;
    if (t === intent.tokenIn.toLowerCase()) {
      if (-delta !== event.amountIn)
        return fail(
          `the account's balance of ${t} fell by ${-delta}, the event says ${event.amountIn}`,
        );
    } else if (t === intent.tokenOut.toLowerCase()) {
      if (delta !== event.amountOut)
        return fail(
          `the account's balance of ${t} rose by ${delta}, the event says ${event.amountOut}`,
        );
    } else if (delta !== 0n) {
      return fail(
        `the account's balance of ${t}, a token between the route's ends, moved by ${delta}`,
      );
    }
  }
  return { ok: true, event, balances };
}
