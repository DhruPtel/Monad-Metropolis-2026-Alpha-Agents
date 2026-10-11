/**
 * The research loop and the agent terminal (P3-U10), read through the
 * orchestrator like the activation sweep: the owner's Research page and the
 * terminal are served here owner-only, and the orchestrator's loopback API
 * answers what it knows. Every body passes through as the orchestrator
 * built it; the control API adds nothing and keeps nothing.
 */
export interface ResearchDeps {
  readonly read: (agentId: number) => Promise<Record<string, unknown>>;
  readonly terminal: (
    agentId: number,
    cycleId: string | null,
    after: number,
  ) => Promise<Record<string, unknown>>;
  readonly pause: (agentId: number, paused: boolean) => Promise<{ paused: boolean }>;
  /** P4-U2: the Risk Sentinel's view of the agent. */
  readonly sentinel: (agentId: number) => Promise<Record<string, unknown>>;
}

export function orchestratorResearch(orchestratorUrl: string): ResearchDeps {
  const base = (agentId: number) => `${orchestratorUrl}/v1/agents/${agentId}`;
  return {
    async read(agentId) {
      const res = await fetch(`${base(agentId)}/research`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`the orchestrator answered ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    },
    async terminal(agentId, cycleId, after) {
      const q = new URLSearchParams({ after: String(after) });
      if (cycleId) q.set("cycleId", cycleId);
      const res = await fetch(`${base(agentId)}/terminal?${q.toString()}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`the orchestrator answered ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    },
    async sentinel(agentId) {
      const res = await fetch(`${base(agentId)}/sentinel`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`the orchestrator answered ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    },
    async pause(agentId, paused) {
      const res = await fetch(`${base(agentId)}/research/pause`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`the orchestrator answered ${res.status}`);
      return (await res.json()) as { paused: boolean };
    },
  };
}
