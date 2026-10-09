import { TIER_IDS } from "@alpha-agents/domain";
import type { CreditService } from "./credits/service.ts";
import type { CycleStore } from "./cycle/store.ts";
import type { GateCredentials } from "./gate.ts";
import type { Provisioner } from "./provisioner.ts";
import type { Store } from "./store.ts";

/**
 * The gate's token lookup (D-203): an active, unexpired lease of a provisioned
 * agent with a key, plus whether the agent's credits are exhausted (D-209),
 * and, inside a research cycle, the stage the lease runs with its caps and
 * what it has used (P3-U4).
 */
export function gateResolver(
  store: Store,
  provisioner: Provisioner,
  credits: CreditService | null,
  cycles: CycleStore | null = null,
): (tokenHash: string) => Promise<GateCredentials | null> {
  return async (hash) => {
    const lease = await store.leaseByTokenHash(hash);
    if (!lease) return null;
    const runtime = await store.runtime(lease);
    const virtualKey = runtime ? provisioner.virtualKey(runtime) : null;
    if (!runtime || !virtualKey) return null;
    const creditsExhausted = credits ? (await credits.creditsOf(lease.agentId)).restricted : false;
    const run = cycles ? await cycles.currentStage(lease.leaseId) : null;
    return {
      lease,
      virtualKey,
      tier: TIER_IDS[runtime.tier - 1] ?? "unknown",
      creditsExhausted,
      stage: run && cycles ? await cycles.gateStage(run) : null,
    };
  };
}
