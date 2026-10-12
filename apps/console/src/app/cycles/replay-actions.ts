"use server";

import { type ActionResult, attempt } from "@/lib/action-result";
import { orchestratorUrl } from "../agents/extension";
import type { ReplayOverride } from "./replay";

/**
 * UI-U2: the replay tool's actions. A replay runs a stored stage again on
 * its stored inputs with the edited texts mounted; saving makes an edit the
 * next version of that playbook or skill for this agent. The orchestrator
 * refuses with a message the page shows: a stage with no stored prompt, the
 * Test stage, a running stage, a cycle already open, or no credits.
 */
const STAGE_ID = /^stage-run-[0-9a-f-]{36}$/;
const CYCLE_ID = /^cycle-[0-9a-f-]{36}$/;

async function post(path: string, body: unknown, expect: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${orchestratorUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status !== expect)
    throw new Error(
      typeof json.message === "string"
        ? json.message
        : Array.isArray(json.issues)
          ? `The text does not pass the skill checks: ${(json.issues as { rule: string; message: string }[])
              .map((i) => `${i.rule} ${i.message}`)
              .join("; ")}`
          : `The orchestrator answered ${res.status}.`,
    );
  return json;
}

export async function startReplayAction(
  stageRunId: string,
  overrides: readonly ReplayOverride[],
): Promise<ActionResult<{ cycleId: string }>> {
  return attempt(async () => {
    if (!STAGE_ID.test(stageRunId)) throw new Error("That is not a stage ID.");
    const r = await post(`/v1/stages/${stageRunId}/replay`, { overrides }, 202);
    if (typeof r.cycleId !== "string") throw new Error("The orchestrator named no replay.");
    return { cycleId: r.cycleId };
  });
}

export async function saveReplayTextAction(
  stageRunId: string,
  override: ReplayOverride,
  savedFrom: string | null,
): Promise<ActionResult<{ version: string; saved: boolean }>> {
  return attempt(async () => {
    if (!STAGE_ID.test(stageRunId)) throw new Error("That is not a stage ID.");
    if (savedFrom !== null && !CYCLE_ID.test(savedFrom)) throw new Error("That is not a cycle ID.");
    const r = await post(
      `/v1/stages/${stageRunId}/replay/save`,
      { override, ...(savedFrom ? { savedFrom } : {}) },
      201,
    );
    return { version: String(r.version ?? ""), saved: r.saved === true };
  });
}
