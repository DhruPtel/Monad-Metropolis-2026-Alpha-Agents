import { AGENT_NFT_ABI, type CustodyPath } from "@alpha-agents/domain";
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

/** Which custody set serves an agent (D-367), read from the two factories. */
export interface CustodyPathReader {
  /** Null when the agent does not exist. */
  custodyPath(agentId: number): Promise<CustodyPath | null>;
}

const FACTORY_READS = parseAbi([
  "function personalAccountOf(uint256 agentId, address owner) view returns (address)",
]);

/**
 * An agent is on v3 once its owner opened a PersonalAccountV3; on v2 while it
 * has only a v2 account; on v3 with no account at all (new accounts open on
 * the fund agent's set).
 */
export function rpcCustodyPathReader(
  rpcUrl: string,
  contracts: {
    readonly agentNft: Hex;
    readonly accountFactory: Hex;
    readonly accountFactoryV3: Hex;
  },
): CustodyPathReader {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return {
    async custodyPath(agentId) {
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
      const accountOf = (factory: Hex) =>
        client.readContract({
          address: factory,
          abi: FACTORY_READS,
          functionName: "personalAccountOf",
          args: [id, owner],
        });
      const [v3, v2] = await Promise.all([
        accountOf(contracts.accountFactoryV3),
        accountOf(contracts.accountFactory),
      ]);
      if (v3 !== zeroAddress) return "v3";
      return v2 !== zeroAddress ? "v2" : "v3";
    },
  };
}
