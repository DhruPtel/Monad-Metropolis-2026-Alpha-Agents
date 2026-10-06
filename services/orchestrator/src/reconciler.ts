import type { OrchestratorQueue } from "./queue.ts";
import type { Store } from "./store.ts";

/**
 * Listens to indexed events by reconciling the indexer's agents projection
 * with the runtimes (D-202): every AgentRevealed the indexer applies makes an
 * agent revealed, and a reorg that rolls one back makes it unrevealed or gone.
 * Each pass enqueues a provision job for every revealed agent without a ready
 * runtime and a deprovision job for every runtime whose agent is gone. Because
 * it compares state rather than counting events, a repeated event or a
 * restarted orchestrator enqueues the same deterministic job IDs again.
 */
export interface ReconcileResult {
  readonly provision: number;
  readonly deprovision: number;
}

export async function reconcileOnce(
  store: Store,
  queue: Pick<OrchestratorQueue, "add">,
  chainId: number,
): Promise<ReconcileResult> {
  const provision = await store.agentsToProvision(chainId);
  for (const ref of provision) await queue.add({ kind: "provision", ref });
  const deprovision = await store.runtimesToDeprovision(chainId);
  for (const ref of deprovision)
    await queue.add({ kind: "deprovision", ref, reason: "agent no longer revealed in the index" });
  return { provision: provision.length, deprovision: deprovision.length };
}
