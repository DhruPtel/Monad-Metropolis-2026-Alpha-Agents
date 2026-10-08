import { AGENT_NFT_ABI } from "@alpha-agents/domain";
import { type Hex, createPublicClient, http, parseAbi, zeroAddress } from "viem";
import type { AgentChainView } from "./arming.ts";

/**
 * Fresh reads of what arming depends on (P2-U6): the agent's owner and
 * ownership epoch from AgentNFT, its configuration epoch and session grant
 * from the Executor, and the block's time. For callers without the chain
 * tools' reader (the control API).
 */
export interface AgentViewReader {
  /** Null when the agent does not exist. */
  agent(agentId: number): Promise<AgentChainView | null>;
}

const EXECUTOR_READS = parseAbi([
  "function configEpochOf(uint256 agentId) view returns (uint64)",
  "function sessionOf(uint256 agentId) view returns ((address key, uint64 ownerEpoch, uint64 configEpoch, uint64 validUntil))",
]);

export function rpcAgentViewReader(
  rpcUrl: string,
  contracts: { readonly agentNft: Hex; readonly executor: Hex },
): AgentViewReader {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return {
    async agent(agentId) {
      const id = BigInt(agentId);
      let owner: Hex;
      try {
        owner = await client.readContract({
          address: contracts.agentNft,
          abi: AGENT_NFT_ABI,
          functionName: "ownerOf",
          args: [id],
        });
      } catch (err) {
        if (err instanceof Error && /revert/i.test(err.message)) return null;
        throw err;
      }
      const [block, ownerEpoch, configEpoch, session] = await Promise.all([
        client.getBlock(),
        client.readContract({
          address: contracts.agentNft,
          abi: AGENT_NFT_ABI,
          functionName: "ownerEpoch",
          args: [id],
        }),
        client.readContract({
          address: contracts.executor,
          abi: EXECUTOR_READS,
          functionName: "configEpochOf",
          args: [id],
        }),
        client.readContract({
          address: contracts.executor,
          abi: EXECUTOR_READS,
          functionName: "sessionOf",
          args: [id],
        }),
      ]);
      return {
        owner,
        ownerEpoch,
        configEpoch,
        timestamp: block.timestamp,
        grant:
          session.key === zeroAddress
            ? null
            : {
                key: session.key,
                ownerEpoch: session.ownerEpoch,
                configEpoch: session.configEpoch,
                validUntil: session.validUntil,
              },
      };
    },
  };
}
