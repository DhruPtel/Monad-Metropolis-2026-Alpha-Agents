import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type PublicClient,
  getAddress,
  isAddressEqual,
} from "viem";
import type { ApiAgent } from "@/api/client";
import { AGENT_NFT_ABI } from "./agent-nft";

/**
 * The wallet's agents when the platform's index lags the chain (P2-EC). The
 * index (the control API) is the normal source; it can be minutes behind, for
 * example after the indexer was down. A wallet that has minted must never be
 * offered the mint, so the chain is read directly for what the index has not
 * seen yet: agents minted after the index's count that the wallet owns, and
 * the reveal of indexed agents still shown as unrevealed. Those agents are
 * marked pending, and drop the mark once the index catches up.
 */
export type PendingStage = "indexing" | "reveal";

export interface OwnedAgentView extends ApiAgent {
  /** Null when the index shows the agent in full; otherwise why it cannot yet. */
  readonly pending: PendingStage | null;
  /** Whether the index has the agent; one read only from the chain has no platform record yet. */
  readonly indexed: boolean;
}

export interface OwnedAgentsRead {
  readonly agents: readonly OwnedAgentView[];
  /** AgentNFT's own record that this wallet minted, whatever the index says. */
  readonly hasMinted: boolean;
  /** The chain has minted more agents than the index has seen. */
  readonly indexLagging: boolean;
}

/** The AgentNFT reads the fallback needs. */
export interface AgentNftReader {
  totalMinted(): Promise<bigint>;
  hasMinted(wallet: Address): Promise<boolean>;
  /** Null when the agent does not exist. */
  ownerOf(agentId: bigint): Promise<Address | null>;
  agent(agentId: bigint): Promise<{ tba: Address; species: number; ownerEpoch: bigint }>;
}

/** At most this many agents past the index's count are read, newest first. */
export const CHAIN_SCAN_LIMIT = 50;

const settled = (a: ApiAgent): OwnedAgentView => ({
  ...a,
  pending: a.species === 0 ? "reveal" : null,
  indexed: true,
});

/**
 * The index's agents for `wallet`, completed from the chain. `indexedMinted`
 * is how many agents the index has seen (the supply route's totalMinted).
 */
export async function ownedAgentsWithChain(
  wallet: Address,
  indexed: readonly ApiAgent[],
  indexedMinted: number,
  chain: AgentNftReader,
): Promise<OwnedAgentsRead> {
  const [total, hasMinted] = await Promise.all([chain.totalMinted(), chain.hasMinted(wallet)]);
  const chainMinted = Number(total);
  const agents: OwnedAgentView[] = [];
  // Indexed agents shown as unrevealed may already be revealed on chain.
  for (const a of indexed) {
    if (a.species !== 0) {
      agents.push(settled(a));
      continue;
    }
    const onChain = await chain.agent(a.id);
    agents.push(
      onChain.species === 0
        ? { ...a, pending: "reveal", indexed: true }
        : { ...a, species: onChain.species, pending: "indexing", indexed: true },
    );
  }
  // Agents minted after what the index has seen, owned by this wallet.
  const first = Math.max(indexedMinted + 1, chainMinted - CHAIN_SCAN_LIMIT + 1, 1);
  for (let id = chainMinted; id >= first; id--) {
    const agentId = BigInt(id);
    if (agents.some((a) => a.id === agentId)) continue;
    const owner = await chain.ownerOf(agentId);
    if (!owner || !isAddressEqual(owner, wallet)) continue;
    const a = await chain.agent(agentId);
    agents.push({
      id: agentId,
      owner: getAddress(owner),
      tba: a.tba,
      species: a.species,
      ownerEpoch: a.ownerEpoch,
      pending: a.species === 0 ? "reveal" : "indexing",
      indexed: false,
    });
  }
  agents.sort((x, y) => (x.id < y.id ? -1 : 1));
  return { agents, hasMinted, indexLagging: chainMinted > indexedMinted };
}

/** The reader over the build's chain, through the app's public RPC. */
export function viemAgentNftReader(client: PublicClient, agentNft: Address): AgentNftReader {
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({
      address: agentNft,
      abi: AGENT_NFT_ABI,
      functionName,
      args,
    } as never) as Promise<T>;
  return {
    totalMinted: () => read<bigint>("totalMinted"),
    hasMinted: (wallet) => read<boolean>("hasMinted", [wallet]),
    ownerOf: async (agentId) => {
      try {
        return await read<Address>("ownerOf", [agentId]);
      } catch (err) {
        // Only the contract's refusal means "no such agent"; a network failure surfaces (L-116).
        if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError))
          return null;
        throw err;
      }
    },
    agent: async (agentId) => {
      const [tba, species, ownerEpoch] = await Promise.all([
        read<Address>("tbaOf", [agentId]),
        read<number>("speciesOf", [agentId]),
        read<bigint>("ownerEpoch", [agentId]),
      ]);
      return { tba: getAddress(tba), species: Number(species), ownerEpoch: BigInt(ownerEpoch) };
    },
  };
}
