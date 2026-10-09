"use server";

import { type ActionResult, attempt } from "@/lib/action-result";
import { orchestratorUrl } from "../agents/extension";

/**
 * P3-U4: starts a research cycle now. The orchestrator offers it only to
 * operators (D-205) and refuses with a message the page shows: no goal, no
 * credits, a sandbox or a cycle already running.
 */
export async function startCycleAction(
  agentId: string,
  kind: "ROUTINE" | "ACTIVATION",
): Promise<ActionResult<{ cycleId: string }>> {
  return attempt(async () => {
    if (!/^[1-9]\d{0,4}$/.test(agentId)) throw new Error("That is not an agent ID.");
    const res = await fetch(`${orchestratorUrl()}/v1/agents/${agentId}/cycles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind }),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as {
      cycleId?: string;
      message?: string;
      error?: string;
    };
    if (res.status !== 202 || !body.cycleId)
      throw new Error(body.message ?? `The orchestrator answered ${res.status}.`);
    return { cycleId: body.cycleId };
  });
}
