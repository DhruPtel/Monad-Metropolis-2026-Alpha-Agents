"use server";

import type { AgentId } from "@alpha-agents/domain";
import { type ActionResult, attempt } from "@/lib/action-result";
import { type TaskView, agentsSource } from "./extension";

// The orchestrator offers these only on the local stack (D-205); its messages carry no secret.

const agentId = (raw: string): AgentId => {
  if (!/^[1-9]\d{0,4}$/.test(raw)) throw new Error("That is not an agent ID.");
  return BigInt(raw) as AgentId;
};

export async function runNoopTaskAction(id: string): Promise<ActionResult<string>> {
  return attempt(async () => {
    const source = agentsSource();
    if (!source.triggerTask) throw new Error("The orchestrator is not configured.");
    return source.triggerTask(agentId(id), "noop");
  });
}

export async function taskAction(taskId: string): Promise<ActionResult<TaskView>> {
  return attempt(async () => {
    const source = agentsSource();
    if (!source.task) throw new Error("The orchestrator is not configured.");
    return source.task(taskId);
  });
}

export async function resetAgentAction(id: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    const source = agentsSource();
    if (!source.resetAgent) throw new Error("The orchestrator is not configured.");
    await source.resetAgent(agentId(id));
    return null;
  });
}
