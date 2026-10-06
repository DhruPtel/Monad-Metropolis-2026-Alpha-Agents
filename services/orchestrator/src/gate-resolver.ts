import { TIER_IDS } from "@alpha-agents/domain";
import type { CreditService } from "./credits/service.ts";
import type { GateCredentials } from "./gate.ts";
import type { Provisioner } from "./provisioner.ts";
import type { Store } from "./store.ts";

/**
 * The gate's token lookup (D-203): an active, unexpired lease of a provisioned
 * agent with a key, plus whether the agent's credits are exhausted (D-209).
 */
export function gateResolver(
  store: Store,
  provisioner: Provisioner,
  credits: CreditService | null,
): (tokenHash: string) => Promise<GateCredentials | null> {
  return async (hash) => {
    const lease = await store.leaseByTokenHash(hash);
    if (!lease) return null;
    const runtime = await store.runtime(lease);
    const virtualKey = runtime ? provisioner.virtualKey(runtime) : null;
    if (!runtime || !virtualKey) return null;
    const creditsExhausted = credits ? (await credits.creditsOf(lease.agentId)).restricted : false;
    return {
      lease,
      virtualKey,
      tier: TIER_IDS[runtime.tier - 1] ?? "unknown",
      creditsExhausted,
    };
  };
}
