import { AGENT_NFT_ABI } from "@alpha-agents/domain";
import { type Address, type PublicClient, createPublicClient, http } from "viem";

/**
 * Fresh chain reads for decisions that must not trust the index (FINAL_PLAN
 * 4.10: critical actions recheck chain state): whether a wallet has minted
 * before a claim is signed, and who owns an agent before an owner session is
 * issued or used.
 */
export interface ChainReader {
  hasMinted(wallet: Address): Promise<boolean>;
  totalMinted(): Promise<number>;
  maxSupply(): Promise<number>;
  /** The owner and ownership epoch, or null when the agent does not exist. */
  ownership(agentId: bigint): Promise<{ owner: Address; epoch: bigint } | null>;
}

export function rpcChainReader(rpcUrl: string, contract: Address): ChainReader {
  const client: PublicClient = createPublicClient({ transport: http(rpcUrl) });
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({
      address: contract,
      abi: AGENT_NFT_ABI,
      functionName,
      args,
    } as never) as Promise<T>;
  return {
    hasMinted: (wallet) => read<boolean>("hasMinted", [wallet]),
    totalMinted: async () => Number(await read<number>("totalMinted")),
    maxSupply: async () => Number(await read<bigint>("MAX_SUPPLY")),
    async ownership(agentId) {
      try {
        const [owner, epoch] = await Promise.all([
          read<Address>("ownerOf", [agentId]),
          read<bigint>("ownerEpoch", [agentId]),
        ]);
        return { owner, epoch };
      } catch (err) {
        // ownerOf reverts for an agent that does not exist.
        if (err instanceof Error && /revert/i.test(err.message)) return null;
        throw err;
      }
    },
  };
}
