"use server";

import {
  type AccountNonceReport,
  type ForkClock,
  accountNonceReport,
  advanceTime,
  alignAccountNonce,
  dropQueuedTransactions,
  forkClock,
  mineBlocks,
  readForkConfig,
  resetToBlock,
  revertToSnapshot,
  takeSnapshot,
} from "@alpha-agents/devenv";
import { type ActionResult, attempt } from "@/lib/action-result";
import { consoleForkUrl } from "@/lib/fork-url";

// Each state-changing devenv function runs assertLocalFork before it touches the node.

export async function readClock(): Promise<ActionResult<ForkClock>> {
  return attempt(() => forkClock(consoleForkUrl()));
}

export async function snapshotAction(): Promise<ActionResult<{ id: string; clock: ForkClock }>> {
  return attempt(async () => {
    const url = consoleForkUrl();
    const id = await takeSnapshot(url);
    return { id, clock: await forkClock(url) };
  });
}

export async function revertAction(id: string): Promise<ActionResult<ForkClock>> {
  return attempt(async () => {
    const url = consoleForkUrl();
    if (!(await revertToSnapshot(id, url))) throw new Error("Anvil no longer has that snapshot.");
    return forkClock(url);
  });
}

export async function mineAction(blocks: number): Promise<ActionResult<ForkClock>> {
  return attempt(() => mineBlocks(blocks, consoleForkUrl()));
}

export async function advanceTimeAction(seconds: number): Promise<ActionResult<ForkClock>> {
  return attempt(() => advanceTime(seconds, consoleForkUrl()));
}

export async function resetAction(): Promise<ActionResult<ForkClock>> {
  return attempt(() => resetToBlock(readForkConfig().blockNumber, consoleForkUrl()));
}

/** P2-U1 step 0: the fork's nonce and queued transactions for one account. */
export async function nonceReportAction(
  address: string,
): Promise<ActionResult<AccountNonceReport>> {
  return attempt(() => accountNonceReport(address.trim(), consoleForkUrl()));
}

/** P2-U1 step 0: drop every transaction anvil holds for the account. */
export async function dropQueuedAction(address: string): Promise<ActionResult<AccountNonceReport>> {
  return attempt(() => dropQueuedTransactions(address.trim(), consoleForkUrl()));
}

/** P2-U1 step 0: move the account's fork nonce forward to the one its wallet sends next. */
export async function alignNonceAction(
  address: string,
  nonce: number,
): Promise<ActionResult<AccountNonceReport>> {
  return attempt(() => alignAccountNonce(address.trim(), nonce, consoleForkUrl()));
}
