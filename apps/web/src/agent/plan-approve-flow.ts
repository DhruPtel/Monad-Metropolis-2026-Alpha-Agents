import { type ArmingFlowDeps, type ArmingProgress, runArm } from "./arming-flow";

/**
 * 2026-10-18 (owner): "Approve and start trading" in one step. When the agent
 * has no trading permission on chain yet, the owner's wallet registers it first
 * (the one signature, every state shown); then the plan is approved, and the
 * approval arms the agent, so its legs start without a further approval. A
 * permission the wallet refused or that failed leaves the plan waiting. Pure:
 * the page passes the steps in.
 */
export interface ApprovePlanDeps extends ArmingFlowDeps {
  /** POST /v1/agents/:id/proposals/:proposalId/approve with the owner session. */
  readonly approve: () => Promise<{ readonly armed?: boolean }>;
}

export type ApprovePlanProgress =
  | ArmingProgress
  | { readonly state: "approving" }
  | { readonly state: "approved"; readonly trading: boolean };

export async function runApproveAndStart(
  deps: ApprovePlanDeps,
  /** The agent's arming now: unarmed registers the grant first. */
  armingState: "unarmed" | "awaiting_first_trade" | "armed",
  report: (p: ApprovePlanProgress) => void,
): Promise<ApprovePlanProgress> {
  const finish = (p: ApprovePlanProgress) => {
    report(p);
    return p;
  };
  if (armingState === "unarmed") {
    const granted = await runArm(deps, report);
    if (granted.state !== "awaiting-first-trade" && granted.state !== "armed") return granted;
  }
  report({ state: "approving" });
  try {
    const r = await deps.approve();
    return finish({ state: "approved", trading: armingState === "armed" || r.armed === true });
  } catch (err) {
    return finish({
      state: "error",
      message:
        err instanceof Error && err.message
          ? err.message
          : "The platform could not approve the plan; try again.",
    });
  }
}
