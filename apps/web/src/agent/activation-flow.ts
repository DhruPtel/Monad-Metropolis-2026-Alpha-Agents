import { type ArmingFlowDeps, type ArmingProgress, runArm } from "./arming-flow";

/**
 * Turning automatic trading on (F-U10, D-291), step by step: when the agent
 * has no trading permission on chain yet, the owner's wallet registers it
 * first (the arming flow of P2-U6, every state shown); then the platform is
 * asked to start the activation sweep, which runs every check again and
 * names the one that fails. Pure: the page passes the steps in.
 */
export interface TurnOnDeps extends ArmingFlowDeps {
  /** POST /v1/agents/:id/activation with the owner session. */
  readonly startActivation: () => Promise<{ status: number; body: unknown }>;
}

export type TurnOnProgress =
  | ArmingProgress
  | { readonly state: "starting" }
  | { readonly state: "started"; readonly activationId: string | null };

const messageOf = (body: unknown, fallback: string): string => {
  const m = (body as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : fallback;
};

export async function runTurnOn(
  deps: TurnOnDeps,
  /** The agent's arming now: unarmed registers the grant first. */
  armingState: "unarmed" | "awaiting_first_trade" | "armed",
  report: (p: TurnOnProgress) => void,
): Promise<TurnOnProgress> {
  const finish = (p: TurnOnProgress) => {
    report(p);
    return p;
  };
  if (armingState === "unarmed") {
    const armed = await runArm(deps, report);
    if (armed.state !== "awaiting-first-trade") return armed;
  }
  report({ state: "starting" });
  let status: number;
  let body: unknown;
  try {
    ({ status, body } = await deps.startActivation());
  } catch {
    return finish({ state: "error", message: "Could not reach the platform." });
  }
  if (status === 202) {
    const id = (body as { activation?: { activationId?: unknown } } | null)?.activation
      ?.activationId;
    return finish({ state: "started", activationId: typeof id === "string" ? id : null });
  }
  return finish({
    state: "error",
    message: messageOf(body, "The platform could not start the activation sweep."),
  });
}
