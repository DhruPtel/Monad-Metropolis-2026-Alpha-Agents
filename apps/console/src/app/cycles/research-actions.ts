"use server";

import { type ActionResult, attempt } from "@/lib/action-result";
import { orchestratorUrl } from "../agents/extension";

/**
 * P3-U10: the research loop's playtest tools, offered by the orchestrator
 * to the dev console on the local fork only: pause and resume, the fast
 * cadence (minutes instead of hours), a trigger fired by hand, one pass of
 * the watcher and the scheduler now, and the market mover (MON/USD by a
 * share). Each answers with the orchestrator's message when it refuses.
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

const agentPath = (agentId: string, rest: string) => {
  if (!/^[1-9]\d{0,4}$/.test(agentId)) throw new Error("That is not an agent ID.");
  return `/v1/agents/${agentId}/research${rest}`;
};

export async function pauseResearchAction(
  agentId: string,
  paused: boolean,
): Promise<ActionResult<{ paused: boolean }>> {
  return attempt(async () => {
    const r = await post(agentPath(agentId, "/pause"), { paused });
    return { paused: r.paused === true };
  });
}

export async function fastCadenceAction(
  agentId: string,
  fast: boolean,
): Promise<ActionResult<{ fast: boolean }>> {
  return attempt(async () => {
    const r = await post(agentPath(agentId, "/cadence"), { fast });
    return { fast: r.fastCadence === true };
  });
}

export async function fireTriggerAction(
  agentId: string,
  code: string,
): Promise<ActionResult<{ triggerId: string; spaced: boolean }>> {
  return attempt(async () => {
    if (!/^[A-Z_]{3,32}$/.test(code)) throw new Error("That is not a trigger code.");
    const r = await post(agentPath(agentId, `/triggers/${code}`), {});
    return { triggerId: String(r.triggerId), spaced: r.spaced === true };
  });
}

export async function researchTickAction(): Promise<
  ActionResult<{ fired: number; queued: number }>
> {
  return attempt(async () => {
    const r = await post("/v1/research/tick", {});
    return {
      fired: Array.isArray(r.fired) ? r.fired.length : 0,
      queued: Array.isArray(r.queued) ? r.queued.length : 0,
    };
  });
}

export async function moveMarketAction(
  bps: number,
): Promise<ActionResult<{ before: string; after: string; decimals: number }>> {
  return attempt(async () => {
    if (!Number.isInteger(bps) || Math.abs(bps) > 9_000)
      throw new Error("The move is a whole number of basis points within 90% either way.");
    const r = await post("/v1/dev/market/move", { bps });
    return {
      before: String(r.before),
      after: String(r.after),
      decimals: typeof r.decimals === "number" ? r.decimals : 8,
    };
  });
}
