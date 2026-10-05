import type { EnvironmentId } from "@alpha-agents/config";
import { addressEntry } from "./address-book.ts";
import { type Address, parseAbi } from "viem";

/**
 * AgentNFT as the apps use it (P1-U11, moved here in P1-U4): the ABI they call,
 * its address per environment from the address book, and the EIP-712 mint
 * claim. Shared by the web app (reads, mint) and the control API (signing).
 */
export const AGENT_NFT_ABI = parseAbi([
  "function mintWithClaim(uint64 deadline, bytes32 nonce, bytes signature) returns (uint256)",
  "function hasMinted(address wallet) view returns (bool)",
  "function claimSigner() view returns (address)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function ownerEpoch(uint256 agentId) view returns (uint64)",
  "function speciesOf(uint256 agentId) view returns (uint8)",
  "function tbaOf(uint256 agentId) view returns (address)",
  "function totalMinted() view returns (uint16)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function remainingOf(uint8 species) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event AgentMinted(uint256 indexed agentId, address indexed owner, address tba)",
  "error AlreadyMinted(address wallet)",
  "error SoldOut()",
  "error ClaimExpired(uint64 deadline)",
  "error ClaimNonceUsed(bytes32 nonce)",
  "error InvalidClaimSigner(address recovered)",
]);

export interface AgentNftDeployment {
  readonly address: Address;
  /** The first block worth scanning for its events. */
  readonly fromBlock: bigint;
  /**
   * The block the address book checked it at (the fork's pinned block): a
   * fixed block the wallet's network must agree on (network-check.ts, L-57).
   */
  readonly referenceBlock: bigint;
}

/**
 * The verified AgentNFT for an environment, or null where it is not deployed
 * (testnet until the Rehearsal, D-193; mainnet until PB-U1).
 */
export function agentNftDeployment(environment: EnvironmentId): AgentNftDeployment | null {
  const entry = addressEntry(environment, "agent_nft");
  if (entry.status !== "verified") return null;
  // Our contracts are deployed after the pinned fork block, so the scan starts
  // one block later and never asks the fork's upstream for history.
  return {
    address: entry.address as Address,
    fromBlock: BigInt(entry.verification.block + 1),
    referenceBlock: BigInt(entry.verification.block),
  };
}

export const CLAIM_TYPES = {
  MintClaim: [
    { name: "wallet", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export function claimDomain(chainId: number, contract: Address) {
  return {
    name: "AlphaAgents AgentNFT",
    version: "1",
    chainId,
    verifyingContract: contract,
  } as const;
}

/** A signed mint claim, as the claim route returns it. */
export interface MintClaim {
  readonly wallet: Address;
  readonly nonce: `0x${string}`;
  /** Unix seconds, as a decimal string (JSON has no bigint). */
  readonly deadline: string;
  readonly signature: `0x${string}`;
  readonly contract: Address;
}
