"use server";

import { type ActionResult, attempt } from "@/lib/action-result";
import { orchestratorUrl } from "../agents/extension";

/**
 * P4-U2: the Risk Sentinel's playtest tools, offered by the orchestrator to
 * the dev console on the local fork only: a pass now, the feed drill (MON/USD
 * stalled or restored), and an operator's clearing of a state the sentinel
 * set, after review.
 */
async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${orchestratorUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok)
    throw new Error(
      typeof json.message === "string" ? json.message : `The orchestrator answered ${res.status}.`,
    );
  return json;
}

export async function sentinelTickAction(): Promise<ActionResult<{ actions: number }>> {
  return attempt(async () => {
    const r = await post("/v1/sentinel/tick", {});
    return { actions: Array.isArray(r.actions) ? r.actions.length : 0 };
  });
}

export async function stallFeedAction(down: boolean): Promise<ActionResult<{ down: boolean }>> {
  return attempt(async () => {
    const r = await post("/v1/dev/market/feed", { down });
    return { down: r.down === true };
  });
}

export async function clearSentinelAction(
  agentId: string,
): Promise<ActionResult<{ cleared: boolean; state: string }>> {
  return attempt(async () => {
    if (!/^[1-9]\d{0,4}$/.test(agentId)) throw new Error("That is not an agent ID.");
    const r = await post(`/v1/agents/${agentId}/sentinel/clear`, {});
    return { cleared: r.cleared === true, state: String(r.state) };
  });
}
