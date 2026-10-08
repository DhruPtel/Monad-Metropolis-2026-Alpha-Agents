import { TRADE_FLOW_MESSAGES } from "@alpha-agents/domain";
import { type Hex, encodeFunctionData, parseAbi } from "viem";
import { type AgentChainView, type ArmingRecord, grantProblem } from "./arming.ts";
import type { IntentView, TradeStore } from "./store.ts";

/**
 * The owner's trade flow actions (P2-U6), shared by the control API (the
 * owner's session) and the dev console (local only). The caller has already
 * proved the wallet owns the agent at the current ownership epoch.
 */

export interface ActionRefusal {
  readonly ok: false;
  readonly code: "NOT_FOUND" | "NOT_ARMED" | "NOT_WAITING" | "GRANT_INVALID" | "NO_FUNDING_ADDRESS";
  readonly message: string;
}

/** The Executor call that revokes an agent's grant, for the owner's wallet to send. */
const REVOKE_ABI = parseAbi(["function revokeSession(uint256 agentId)"]);
const REGISTER_ABI = parseAbi([
  "function registerSession(uint256 agentId, address key, uint64 validUntil)",
]);

export interface WalletCall {
  readonly to: Hex;
  readonly data: Hex;
  readonly value: "0";
}

export const revokeCall = (executor: Hex, agentId: number): WalletCall => ({
  to: executor,
  data: encodeFunctionData({
    abi: REVOKE_ABI,
    functionName: "revokeSession",
    args: [BigInt(agentId)],
  }),
  value: "0",
});

export const registerCall = (
  executor: Hex,
  agentId: number,
  key: Hex,
  validUntil: bigint,
): WalletCall => ({
  to: executor,
  data: encodeFunctionData({
    abi: REGISTER_ABI,
    functionName: "registerSession",
    args: [BigInt(agentId), key, validUntil],
  }),
  value: "0",
});

/**
 * Records the owner's grant once it is on chain: it must name the agent's
 * funding address, the current epochs, and last at most 30 days. The same
 * grant again renews the open arming.
 */
export async function confirmArming(
  store: TradeStore,
  chain: AgentChainView | null,
  a: { chainId: number; agentId: number; owner: Hex; fundingAddress: Hex | null },
): Promise<{ ok: true; record: ArmingRecord; renewed: boolean } | ActionRefusal> {
  if (!chain)
    return { ok: false, code: "NOT_FOUND", message: "This agent does not exist on this chain." };
  if (!a.fundingAddress)
    return {
      ok: false,
      code: "NO_FUNDING_ADDRESS",
      message: "The agent has no funding address yet; it gets one within a few seconds of minting.",
    };
  const problem = grantProblem(chain, a.owner, a.fundingAddress);
  if (problem || !chain.grant) return { ok: false, code: "GRANT_INVALID", message: problem ?? "" };
  const r = await store.startArming({
    chainId: a.chainId,
    agentId: a.agentId,
    owner: chain.owner,
    ownerEpoch: chain.ownerEpoch,
    configEpoch: chain.configEpoch,
    sessionKey: chain.grant.key,
    validUntil: chain.grant.validUntil,
  });
  return { ok: true, ...r };
}

/**
 * The owner approves one waiting intent. The agent must have a grant (an open
 * arming); the first approval after the grant arms it.
 */
export async function approveByOwner(
  store: TradeStore,
  chainId: number,
  agentId: number,
  intentId: string,
): Promise<{ ok: true; intent: IntentView; armed: ArmingRecord | null } | ActionRefusal> {
  const intent = await store.intent(chainId, agentId, intentId);
  if (!intent) return { ok: false, code: "NOT_FOUND", message: "No such intent for this agent." };
  const arming = await store.openArming(chainId, agentId);
  if (!arming)
    return {
      ok: false,
      code: "NOT_ARMED",
      message: `${TRADE_FLOW_MESSAGES.NOT_ARMED} Register its trading permission first, then approve.`,
    };
  if (intent.status !== "awaiting_approval")
    return {
      ok: false,
      code: "NOT_WAITING",
      message: `This intent is ${intent.status.replace("_", " ")}, not waiting for approval.`,
    };
  if (intent.ownerEpoch !== arming.ownerEpoch || intent.configEpoch !== arming.configEpoch)
    return {
      ok: false,
      code: "NOT_WAITING",
      message: "This intent was proposed before the agent's last sale or change.",
    };
  const approved = await store.approve(chainId, agentId, intentId, "owner");
  if (!approved)
    return {
      ok: false,
      code: "NOT_WAITING",
      message: "This intent is no longer waiting for approval.",
    };
  const armed =
    arming.status === "awaiting_first_trade"
      ? await store.markArmed(arming.armingId, intentId)
      : null;
  return { ok: true, intent: approved, armed };
}

/** The owner rejects one waiting intent; the agent stays as armed (or not) as it was. */
export async function rejectByOwner(
  store: TradeStore,
  chainId: number,
  agentId: number,
  intentId: string,
): Promise<{ ok: true; intent: IntentView } | ActionRefusal> {
  const intent = await store.intent(chainId, agentId, intentId);
  if (!intent) return { ok: false, code: "NOT_FOUND", message: "No such intent for this agent." };
  const rejected = await store.rejectByOwner(chainId, agentId, intentId);
  if (!rejected)
    return {
      ok: false,
      code: "NOT_WAITING",
      message: `This intent is ${intent.status.replace("_", " ")}, not waiting for approval.`,
    };
  return { ok: true, intent: rejected };
}

/** The owner disarms the agent: the arming ends now; the wallet then revokes the grant on chain. */
export async function disarm(
  store: TradeStore,
  chainId: number,
  agentId: number,
): Promise<ArmingRecord | null> {
  const open = await store.openArming(chainId, agentId);
  return open ? store.endArming(open.armingId, "disarmed") : null;
}
