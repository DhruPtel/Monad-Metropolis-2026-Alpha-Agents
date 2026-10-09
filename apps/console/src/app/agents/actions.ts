"use server";

import { mintTestUsdc } from "@alpha-agents/devenv";
import type { AgentId } from "@alpha-agents/domain";
import { type ActionResult, attempt } from "@/lib/action-result";
import { consoleForkUrl } from "@/lib/fork-url";
import {
  type ArmingView,
  type PlanParams,
  type RunnerDecisionView,
  type RefundView,
  type RevealSteeringView,
  type TaskView,
  agentsSource,
} from "./extension";

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

/** P1-U7: queues a Scan now (D-216); refused below the Scan minimum (D-222) or while one is open. */
export async function runScanAction(id: string): Promise<ActionResult<string>> {
  return attempt(async () => {
    const source = agentsSource();
    if (!source.triggerTask) throw new Error("The orchestrator is not configured.");
    return source.triggerTask(agentId(id), "scan");
  });
}

/** P2-U5: the chain check: the agent reads its account and proposes a small swap that waits. */
export async function runChainCheckAction(id: string): Promise<ActionResult<string>> {
  return attempt(async () => {
    const source = agentsSource();
    if (!source.triggerTask) throw new Error("The orchestrator is not configured.");
    return source.triggerTask(agentId(id), "chain_check");
  });
}

/** P3-U9: the research check: the agent uses each research source once. */
export async function runResearchCheckAction(id: string): Promise<ActionResult<string>> {
  return attempt(async () => {
    const source = agentsSource();
    if (!source.triggerTask) throw new Error("The orchestrator is not configured.");
    return source.triggerTask(agentId(id), "research_check");
  });
}

/**
 * D-221: steer a reveal on the local fork, once: a wallet's next reveal (its
 * lowest unrevealed agent, or the next one it mints) or one pending agent.
 */
export async function steerRevealAction(
  species: string,
  target: { wallet: string } | { agentId: string },
): Promise<ActionResult<RevealSteeringView>> {
  return attempt(async () => {
    const source = agentsSource();
    if (!source.steerReveal) throw new Error("The orchestrator is not configured.");
    if (!/^[a-z][a-z-]{1,30}$/.test(species)) throw new Error("That is not a species.");
    if ("wallet" in target) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(target.wallet.trim()))
        throw new Error("That is not a wallet address.");
      return source.steerReveal(species, { wallet: target.wallet.trim() });
    }
    return source.steerReveal(species, { agentId: agentId(target.agentId.trim()).toString() });
  });
}

/** D-221: cancel a pending steer. */
export async function cancelSteerAction(
  steerId: string,
): Promise<ActionResult<RevealSteeringView>> {
  return attempt(async () => {
    const source = agentsSource();
    if (!source.cancelSteer) throw new Error("The orchestrator is not configured.");
    if (!/^[0-9a-zA-Z-]{1,64}$/.test(steerId)) throw new Error("That is not a steer.");
    return source.cancelSteer(steerId);
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
    await mintTestUsdc(address, FUND_AMOUNT_E6, consoleForkUrl());
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

/** P2-U6: arm the agent as its owner would (the grant on the local fork, then its record). */
export async function armAgentAction(id: string): Promise<ActionResult<ArmingView>> {
  return attempt(async () => {
    const source = agentsSource();
    if (!source.armAgent) throw new Error("The orchestrator is not configured.");
    return source.armAgent(agentId(id));
  });
}

/** P2-U6: disarm now; the grant is revoked on the local fork. */
export async function disarmAgentAction(id: string): Promise<ActionResult<ArmingView>> {
  return attempt(async () => {
    const source = agentsSource();
    if (!source.disarmAgent) throw new Error("The orchestrator is not configured.");
    return source.disarmAgent(agentId(id));
  });
}

/** P2-U6: approve a waiting intent as the owner; resolves to true when it armed the agent. */
export async function approveIntentAction(
  id: string,
  intentId: string,
): Promise<ActionResult<boolean>> {
  return attempt(async () => {
    const source = agentsSource();
    if (!source.approveIntent) throw new Error("The orchestrator is not configured.");
    if (!/^intent-[0-9a-f-]{36}$/.test(intentId)) throw new Error("That is not an intent.");
    return source.approveIntent(agentId(id), intentId);
  });
}

/** P2-U6: a proposal over the trade size limit, so a blocked trade can be seen (local only). */
export async function proposeOverLimitAction(id: string): Promise<ActionResult<string>> {
  return attempt(async () => {
    const source = agentsSource();
    if (!source.proposeOverLimit) throw new Error("The orchestrator is not configured.");
    return source.proposeOverLimit(agentId(id));
  });
}

/** P3-U3: sets the agent's rebalance_bands@1 plan (checked against its goal; bumps the strategy epoch). */
export async function setPlanAction(id: string, params: PlanParams): Promise<ActionResult<string>> {
  return attempt(async () => {
    const source = agentsSource();
    if (!source.setPlan) throw new Error("The orchestrator is not configured.");
    return source.setPlan(agentId(id), params);
  });
}

/** P3-U3: runs the template runner for the agent once now (local only). */
export async function runRunnerAction(id: string): Promise<ActionResult<RunnerDecisionView>> {
  return attempt(async () => {
    const source = agentsSource();
    if (!source.runRunner) throw new Error("The orchestrator is not configured.");
    return source.runRunner(agentId(id));
  });
}
