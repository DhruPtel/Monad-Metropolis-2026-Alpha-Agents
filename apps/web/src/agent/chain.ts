import type { AppChain } from "@alpha-agents/config";
import { type Address, createPublicClient, http, isAddressEqual, type PublicClient } from "viem";
import { viemChain } from "@/auth/session";
import { AGENT_NFT_ABI, type AgentNftDeployment } from "./agent-nft";

/** An agent as read from AgentNFT. Species 0 means not yet revealed. */
export interface AgentView {
  readonly id: bigint;
  readonly owner: Address;
  readonly species: number;
  readonly tba: Address;
  readonly ownerEpoch: bigint;
}

/** A read-only client for the build's chain, through its public browser RPC. */
export function chainClient(target: AppChain): PublicClient {
  return createPublicClient({ chain: viemChain(target), transport: http(target.browserRpcUrl) });
}

export async function readAgent(
  client: PublicClient,
  deployment: AgentNftDeployment,
  id: bigint,
): Promise<AgentView> {
  const target = { address: deployment.address, abi: AGENT_NFT_ABI, args: [id] } as const;
  const [owner, species, tba, ownerEpoch] = await Promise.all([
    client.readContract({ ...target, functionName: "ownerOf" }),
    client.readContract({ ...target, functionName: "speciesOf" }),
    client.readContract({ ...target, functionName: "tbaOf" }),
    client.readContract({ ...target, functionName: "ownerEpoch" }),
  ]);
  return { id, owner, species, tba, ownerEpoch };
}

/**
 * The agents a wallet owns now. There is no indexer yet (P1-U4), so this
 * finds every agent ever transferred to the wallet from AgentNFT's Transfer
 * events (mints included), then keeps only those whose `ownerOf` is still the
 * wallet: a fresh chain read decides, never the event history alone.
 */
export async function ownedAgents(
  client: PublicClient,
  deployment: AgentNftDeployment,
  wallet: Address,
): Promise<AgentView[]> {
  const logs = await client.getContractEvents({
    address: deployment.address,
    abi: AGENT_NFT_ABI,
    eventName: "Transfer",
    args: { to: wallet },
    fromBlock: deployment.fromBlock,
    toBlock: "latest",
  });
  const ids = [
    ...new Set(logs.flatMap((l) => (l.args.tokenId === undefined ? [] : [l.args.tokenId]))),
  ];
  const views = await Promise.all(ids.map((id) => readAgent(client, deployment, id)));
  return views
    .filter((v) => isAddressEqual(v.owner, wallet))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * The agent a wallet minted, from its `AgentMinted` event (one per wallet),
 * with its species read fresh; null when the wallet has minted nothing.
 */
export async function mintedAgent(
  client: PublicClient,
  deployment: AgentNftDeployment,
  wallet: Address,
): Promise<{ id: bigint; species: number } | null> {
  const [log] = await client.getContractEvents({
    address: deployment.address,
    abi: AGENT_NFT_ABI,
    eventName: "AgentMinted",
    args: { owner: wallet },
    fromBlock: deployment.fromBlock,
    toBlock: "latest",
  });
  const id = log?.args.agentId;
  if (id === undefined) return null;
  const species = await client.readContract({
    address: deployment.address,
    abi: AGENT_NFT_ABI,
    functionName: "speciesOf",
    args: [id],
  });
  return { id, species };
}
