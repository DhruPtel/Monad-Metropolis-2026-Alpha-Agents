"use server";

import { mintTestUsdc } from "@alpha-agents/devenv";
import type { AgentId } from "@alpha-agents/domain";
import { type ActionResult, attempt } from "@/lib/action-result";
import { type RefundView, type TaskView, agentsSource } from "./extension";

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

/** Test USDC the "Fund" button sends: 5 USDC. A "use server" file may export only async functions. */
const FUND_AMOUNT_E6 = 5_000_000n;

/**
 * Sends test USDC to the agent's funding address on the local fork, as any
 * wallet would; the indexer and the orchestrator credit it with no other step.
 */
export async function fundAgentAction(id: string): Promise<ActionResult<string>> {
  return attempt(async () => {
    const list = await agentsSource().listAgents();
    const agent = list.agents.find((a) => a.agentId === agentId(id));
    const address = agent?.credits?.fundingAddress;
    if (!address)
      throw new Error("This agent has no funding address yet: is the orchestrator running?");
    await mintTestUsdc(address, FUND_AMOUNT_E6);
    return address;
  });
}

export async function refundAgentAction(id: string): Promise<ActionResult<string>> {
  return attempt(async () => {
    const source = agentsSource();
    if (!source.refund) throw new Error("The orchestrator is not configured.");
    return source.refund(agentId(id));
  });
}

export async function refundStatusAction(refundId: string): Promise<ActionResult<RefundView>> {
  return attempt(async () => {
    const source = agentsSource();
    if (!source.refundStatus) throw new Error("The orchestrator is not configured.");
    return source.refundStatus(refundId);
  });
}
