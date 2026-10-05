import type { AppChain } from "@alpha-agents/config";
import { type PublicClient, createPublicClient, http } from "viem";
import { viemChain } from "@/auth/session";
import type { ApiAgent } from "@/api/client";

/** An agent as the pages show it, from the control API's index. Species 0 means not yet revealed. */
export type AgentView = ApiAgent;

/**
 * A read-only client for the build's chain, through its public browser RPC.
 * Since P1-U4 the pages read agents and supply from the control API; the chain
 * is read directly only for the wallet network guard and the mint receipt.
 */
export function chainClient(target: AppChain): PublicClient {
  return createPublicClient({ chain: viemChain(target), transport: http(target.browserRpcUrl) });
}
