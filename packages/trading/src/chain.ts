import {
  AGENT_NFT_ABI,
  type CustodyPath,
  type ManagedAccount,
  managedAccountOf,
} from "@alpha-agents/domain";
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
const FACTORY_V3_READS = parseAbi([
  "function vaultOf(uint256 agentId) view returns (address)",
  "function personalAccountOf(uint256 agentId, address owner) view returns (address)",
]);

export function rpcAgentViewReader(
  rpcUrl: string,
  contracts: {
    readonly agentNft: Hex;
    readonly executor: Hex;
    /** P7-U2: AccountFactoryV3, to tell an agent whose trading account is its vault (D-241). */
    readonly accountFactoryV3?: Hex;
  },
  options: {
    /** Step 0 (2026-10-12, A-90): the owner's choice of the account the agent manages, from the store. */
    readonly managedAccount?: (agentId: number) => Promise<ManagedAccount | null>;
  } = {},
): AgentViewReader {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const choiceOf = options.managedAccount ?? (async () => null);
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
      const [block, ownerEpoch, configEpoch, session, vault, personal, choice] = await Promise.all([
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
        contracts.accountFactoryV3
          ? client.readContract({
              address: contracts.accountFactoryV3,
              abi: FACTORY_V3_READS,
              functionName: "vaultOf",
              args: [id],
            })
          : Promise.resolve(zeroAddress),
        contracts.accountFactoryV3
          ? client.readContract({
              address: contracts.accountFactoryV3,
              abi: FACTORY_V3_READS,
              functionName: "personalAccountOf",
              args: [id, owner],
            })
          : Promise.resolve(zeroAddress),
        choiceOf(agentId),
      ]);
      const resolved = managedAccountOf({
        vault: vault === zeroAddress ? null : vault,
        personal: personal === zeroAddress ? null : personal,
        choice,
      });
      return {
        owner,
        ownerEpoch,
        configEpoch,
        timestamp: block.timestamp,
        isVault: resolved.isVault,
        managed: resolved.managed,
        vault: vault === zeroAddress ? null : vault,
        personalAccount: personal === zeroAddress ? null : personal,
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

/**
 * An agent is on v3 wherever the fund agent's set is deployed (A-80, read
 * after the F-U11 playtest): the activation sweep, the plans and the window
 * live on that set, so a v2 PersonalAccount the agent still has is an older
 * account its owner withdraws from, never the path. Null when the agent does
 * not exist.
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
      // The owner read above is the existence check; the set itself decides the path.
      void owner;
      return "v3";
    },
  };
}
