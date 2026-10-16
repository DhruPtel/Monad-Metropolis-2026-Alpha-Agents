/**
 * 2026-10-13: the owner's Research now. The control API checks the owner and
 * asks the orchestrator (`ORCHESTRATOR_URL`) for the full research cycle the
 * operator route runs; the orchestrator applies the demo's spending guard and
 * the credit check, and names why it refuses.
 */
export type ResearchRunStartJson =
  | { readonly ok: true; readonly cycleId: string }
  | {
      readonly ok: false;
      readonly error: string;
      readonly message: string;
      /** 2026-10-16: with credits_short, the credits above the reserve and a run's ceiling. */
      readonly availableUsdcE6?: string;
      readonly neededUsdcE6?: string;
    };

export interface ResearchRunDeps {
  readonly start: (agentId: number) => Promise<ResearchRunStartJson>;
}

/** The orchestrator's route over HTTP, for main.ts. */
export function orchestratorResearchRun(orchestratorUrl: string): ResearchRunDeps {
  return {
    async start(agentId) {
      const res = await fetch(`${orchestratorUrl}/v1/agents/${agentId}/research-run`, {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 202) return { ok: true, cycleId: String(body.cycleId) };
      if (res.status === 409)
        return {
          ok: false,
          error: String(body.error ?? "refused"),
          message: String(body.message ?? "The research run could not start."),
          ...(typeof body.availableUsdcE6 === "string" && typeof body.neededUsdcE6 === "string"
            ? { availableUsdcE6: body.availableUsdcE6, neededUsdcE6: body.neededUsdcE6 }
            : {}),
        };
      throw new Error(`the orchestrator answered ${res.status}`);
    },
  };
}
