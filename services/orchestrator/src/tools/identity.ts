import { TIER_IDS } from "@alpha-agents/domain";
import type { IdentityResolver } from "@alpha-agents/tool-server";
import type { Store } from "../store.ts";

/**
 * Identity for the tool servers (D-213): the token's hash must name an active,
 * unexpired lease of a provisioned agent. The lease gives the agent, and the
 * runtime its tier; nothing the sandbox sends can change either.
 */
export function leaseIdentity(store: Store): IdentityResolver {
  return async (tokenHash) => {
    const lease = await store.leaseByTokenHash(tokenHash);
    if (!lease) return null;
    const runtime = await store.runtime(lease);
    if (runtime?.status !== "ready") return null;
    return {
      chainId: lease.chainId,
      agentId: lease.agentId,
      tier: TIER_IDS[runtime.tier - 1] ?? "unknown",
      leaseId: lease.leaseId,
    };
  };
}
