import { type Hex, decodeEventLog, isAddressEqual } from "viem";
import { EXECUTOR_ABI, type SwapIntentArgs } from "./abi.ts";
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
