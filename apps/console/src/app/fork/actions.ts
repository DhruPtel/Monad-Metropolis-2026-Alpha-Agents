"use server";

import {
  type ForkClock,
  advanceTime,
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
