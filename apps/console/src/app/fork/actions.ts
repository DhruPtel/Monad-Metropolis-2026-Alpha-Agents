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

// Each state-changing devenv function runs assertLocalFork before it touches the node.

export async function readClock(): Promise<ActionResult<ForkClock>> {
  return attempt(() => forkClock());
}

export async function snapshotAction(): Promise<ActionResult<{ id: string; clock: ForkClock }>> {
  return attempt(async () => {
    const id = await takeSnapshot();
    return { id, clock: await forkClock() };
  });
}

export async function revertAction(id: string): Promise<ActionResult<ForkClock>> {
  return attempt(async () => {
    if (!(await revertToSnapshot(id))) throw new Error("Anvil no longer has that snapshot.");
    return forkClock();
  });
}

export async function mineAction(blocks: number): Promise<ActionResult<ForkClock>> {
  return attempt(() => mineBlocks(blocks));
}

export async function advanceTimeAction(seconds: number): Promise<ActionResult<ForkClock>> {
  return attempt(() => advanceTime(seconds));
}

export async function resetAction(): Promise<ActionResult<ForkClock>> {
  return attempt(() => resetToBlock(readForkConfig().blockNumber));
}

/** P2-U1 step 0: the fork's nonce and queued transactions for one account. */
export async function nonceReportAction(
  address: string,
): Promise<ActionResult<AccountNonceReport>> {
  return attempt(() => accountNonceReport(address.trim()));
}

/** P2-U1 step 0: drop every transaction anvil holds for the account. */
export async function dropQueuedAction(address: string): Promise<ActionResult<AccountNonceReport>> {
  return attempt(() => dropQueuedTransactions(address.trim()));
}

/** P2-U1 step 0: move the account's fork nonce forward to the one its wallet sends next. */
export async function alignNonceAction(
  address: string,
  nonce: number,
): Promise<ActionResult<AccountNonceReport>> {
  return attempt(() => alignAccountNonce(address.trim(), nonce));
}
