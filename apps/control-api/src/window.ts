import type { AccountReadJson } from "@alpha-agents/trading";

/**
 * The portfolio window's live reading (F-U11): the account as the
 * orchestrator reads it now, through `ORCHESTRATOR_URL` like the activation
 * sweep. Null when the agent has no account or the chain tools are not
 * configured there; the route then shows the latest snapshot, dated as such.
 */
export interface WindowDeps {
  readonly account: (agentId: number) => Promise<AccountReadJson | null>;
}

export function orchestratorWindow(orchestratorUrl: string): WindowDeps {
  return {
    async account(agentId) {
      const res = await fetch(`${orchestratorUrl}/v1/agents/${agentId}/account`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404 || res.status === 503) return null;
      if (!res.ok) throw new Error(`the orchestrator answered ${res.status}`);
      return (await res.json()) as AccountReadJson;
    },
  };
}
