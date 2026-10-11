import type { ActivationCheck, ActivationView } from "@alpha-agents/trading";

/**
 * The activation sweep's owner routes (F-U10) read and start the sweep
 * through the orchestrator, which owns the checks, the record and the queue
 * (`ORCHESTRATOR_URL`, as the plan card's re-check does). These are the
 * shapes it answers with; the web app reads the same ones.
 */
export interface ActivationReadJson {
  readonly agentId: string;
  readonly activation: ActivationView | null;
  readonly checks: readonly ActivationCheck[];
  readonly ceilingUsdcE6: string;
  readonly tier: { readonly choice: "LOW" | "MEDIUM" | "HIGH"; readonly label: string };
}

export type ActivationStartJson =
  | { readonly ok: true; readonly activation: ActivationView }
  | {
      readonly ok: false;
      /** The orchestrator's error code, `activation_<check>`. */
      readonly error: string;
      readonly message: string;
      readonly checks: readonly ActivationCheck[];
    };

export interface ActivationDeps {
  readonly read: (agentId: number) => Promise<ActivationReadJson>;
  readonly start: (agentId: number) => Promise<ActivationStartJson>;
}

/** The orchestrator's two routes over HTTP, for main.ts. */
export function orchestratorActivation(orchestratorUrl: string): ActivationDeps {
  const url = (agentId: number) => `${orchestratorUrl}/v1/agents/${agentId}/activation`;
  return {
    async read(agentId) {
      const res = await fetch(url(agentId), { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`the orchestrator answered ${res.status}`);
      return (await res.json()) as ActivationReadJson;
    },
    async start(agentId) {
      const res = await fetch(url(agentId), {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 202) return { ok: true, activation: body.activation as ActivationView };
      if (res.status === 409)
        return {
          ok: false,
          error: String(body.error ?? "activation_refused"),
          message: String(body.message ?? "The sweep could not start."),
          checks: (body.checks as ActivationCheck[] | undefined) ?? [],
        };
      throw new Error(`the orchestrator answered ${res.status}`);
    },
  };
}
