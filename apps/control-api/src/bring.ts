import {
  ARBITRUM_SEPOLIA_DEPLOYMENT as ARBITRUM_SEPOLIA,
  BASE_SEPOLIA_DEPLOYMENT as BASE_SEPOLIA,
} from "@alpha-agents/domain";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * CO-U1 "Bring to Base / Arbitrum" (owner, 2026-10-15): the platform's copy of a Monad agent on
 * an L2 testnet, minted to the agent's Monad owner with the same number, species and tier (or
 * moved to them when the copy belongs to an earlier owner). The route checks the caller owns
 * the agent on Monad; the deployer, the copy NFT's minter, sends the transaction.
 */
export const BRING_CHAINS = ["base-sepolia", "arbitrum-sepolia"] as const;
export type BringChain = (typeof BRING_CHAINS)[number];

export interface BringResult {
  readonly chain: BringChain;
  readonly agentId: string;
  readonly status: "minted" | "moved" | "already";
  readonly txHash: Hex | null;
}

export interface BringDeps {
  bring(chain: BringChain, agentId: bigint, owner: Address): Promise<BringResult>;
}

const MONAD_ABI = parseAbi([
  "function speciesOf(uint256) view returns (uint8)",
  "function tierOf(uint256) view returns (uint8)",
]);
const COPY_ABI = parseAbi([
  "function ownerOf(uint256) view returns (address)",
  "function mintCopy(address to, uint256 agentId, uint8 tier, uint8 species)",
  "function moveCopy(uint256 agentId, address to)",
]);
const TARGETS: Record<
  BringChain,
  { chainId: number; rpcVariable: string; copyNft: string | null }
> = {
  "base-sepolia": {
    chainId: 84532,
    rpcVariable: "BASE_SEPOLIA_RPC_URL",
    copyNft:
      (BASE_SEPOLIA as { contracts?: Record<string, { address: string }> } | null)?.contracts
        ?.agent_nft?.address ?? null,
  },
  "arbitrum-sepolia": {
    chainId: 421614,
    rpcVariable: "ARBITRUM_SEPOLIA_RPC_URL",
    copyNft:
      (ARBITRUM_SEPOLIA as { contracts?: Record<string, { address: string }> } | null)?.contracts
        ?.agent_nft?.address ?? null,
  },
};

/** The live version: Monad reads on `monadRpcUrl`, writes with the deployer key on each L2. */
export function chainBring(o: {
  monadRpcUrl: string;
  monadAgentNft: Address;
  deployerKey: Hex;
  env: Readonly<Record<string, string | undefined>>;
}): BringDeps {
  const monad = createPublicClient({ transport: http(o.monadRpcUrl) });
  const account = privateKeyToAccount(o.deployerKey);
  return {
    async bring(chain, agentId, owner) {
      const t = TARGETS[chain];
      const rpc = o.env[t.rpcVariable]?.trim();
      if (!t.copyNft || !rpc) throw new Error(`${chain} is not set up for copies`);
      const nft = getAddress(t.copyNft);
      const read = { address: o.monadAgentNft, abi: MONAD_ABI, args: [agentId] } as const;
      const [species, tier] = await Promise.all([
        monad.readContract({ ...read, functionName: "speciesOf" }),
        monad.readContract({ ...read, functionName: "tierOf" }),
      ]);
      if (Number(species) === 0) throw new BringRefused("not_revealed", "Reveal the agent first.");
      const target = {
        id: t.chainId,
        name: chain,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpc] } },
      };
      const client = createPublicClient({ chain: target, transport: http(rpc) });
      const wallet = createWalletClient({ account, chain: target, transport: http(rpc) });
      const current = await client
        .readContract({ address: nft, abi: COPY_ABI, functionName: "ownerOf", args: [agentId] })
        .catch(() => null);
      if (current && getAddress(current) === getAddress(owner))
        return { chain, agentId: agentId.toString(), status: "already", txHash: null };
      const hash = current
        ? await wallet.writeContract({
            address: nft,
            abi: COPY_ABI,
            functionName: "moveCopy",
            args: [agentId, owner],
          })
        : await wallet.writeContract({
            address: nft,
            abi: COPY_ABI,
            functionName: "mintCopy",
            args: [owner, agentId, Number(tier), Number(species)],
          });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(`the copy transaction ${hash} reverted`);
      return {
        chain,
        agentId: agentId.toString(),
        status: current ? "moved" : "minted",
        txHash: hash,
      };
    },
  };
}

/** A refusal the owner can act on, with its code. */
export class BringRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
