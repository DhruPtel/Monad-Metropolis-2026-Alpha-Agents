import { AGENT_NFT_ABI } from "@alpha-agents/domain";
import { type Address, type PublicClient, createPublicClient, http } from "viem";

/**
 * Fresh chain reads for decisions that must not trust the index (FINAL_PLAN
 * 4.10: critical actions recheck chain state): whether a wallet has minted
 * before a claim is signed, and who owns an agent before an owner session is
 * issued or used.
 */
export interface ChainReader {
  /** How many agents the wallet has minted (at most MINTS_PER_WALLET, NFT-U1). */
  mintsOf(wallet: Address): Promise<number>;
  totalMinted(): Promise<number>;
  maxSupply(): Promise<number>;
  /** The owner and ownership epoch, or null when the agent does not exist. */
  ownership(agentId: bigint): Promise<{ owner: Address; epoch: bigint } | null>;
  /**
   * CO-U1: the deck as AgentNFT holds it, every species index with its onchain name, slug and
   * remaining count, so the mint page lists what the contract draws. Null where the contract
   * has no deck (an L2 testnet's AgentCopyNFT).
   */
  deck?(): Promise<DeckSpecies[] | null>;
}

export interface DeckSpecies {
  readonly index: number;
  readonly name: string;
  readonly slug: string;
  readonly remaining: number;
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
  // MAX_SUPPLY is a constant of the contract: read once, again only after a failed read (CQ-U1).
  let maxSupply: Promise<number> | null = null;
  return {
    mintsOf: async (wallet) => Number(await read<number>("mintsOf", [wallet])),
    totalMinted: async () => Number(await read<number>("totalMinted")),
    maxSupply: () => {
      maxSupply ??= read<bigint>("MAX_SUPPLY").then(Number, (err: unknown) => {
        maxSupply = null;
        throw err;
      });
      return maxSupply;
    },
    async deck() {
      let count: number;
      try {
        count = Number(await read<number>("SPECIES_COUNT"));
      } catch {
        return null;
      }
      const indexes = Array.from({ length: count }, (_, i) => i + 1);
      return Promise.all(
        indexes.map(async (index) => {
          const [[name, slug], remaining] = await Promise.all([
            read<readonly [string, string]>("speciesInfo", [index]),
            read<bigint>("remainingOf", [index]),
          ]);
          return { index, name, slug, remaining: Number(remaining) };
        }),
      );
    },
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
