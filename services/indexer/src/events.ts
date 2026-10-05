import { parseAbi } from "viem";

/**
 * Every event AgentNFT emits, its own and inherited (ERC-721, ERC-4906,
 * Ownable2Step, EIP-712), copied from the compiled ABI. events.test.ts checks
 * this list against `forge inspect` so a new event can never go unindexed.
 */
export const AGENT_NFT_EVENTS_ABI = parseAbi([
  "event AgentMinted(uint256 indexed agentId, address indexed owner, address tba)",
  "event AgentRevealed(uint256 indexed agentId, uint8 tier, uint8 species)",
  "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
  "event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId)",
  "event ClaimRequiredSet(bool required)",
  "event ClaimSignerSet(address indexed previousSigner, address indexed newSigner)",
  "event ContractURIUpdated()",
  "event EIP712DomainChanged()",
  "event EscrowSet(address indexed escrow)",
  "event ImageBaseURIFrozen(string uri)",
  "event ImageBaseURISet(string uri)",
  "event MetadataUpdate(uint256 _tokenId)",
  "event OwnerEpochBumped(uint256 indexed agentId, uint64 epoch, address indexed from, address indexed to)",
  "event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "event RevealRequested(uint64 indexed sequence, uint256 firstAgentId, uint256 lastAgentId, bool retry)",
  "event RevealSeedStored(uint64 indexed sequence, bytes32 seed)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event TreasurySet(address indexed previousTreasury, address indexed newTreasury)",
]);

export type AgentNftEventName = (typeof AGENT_NFT_EVENTS_ABI)[number]["name"];

/**
 * What the indexer does with each event: every one is stored raw; these also
 * change the agents projection. The rest are admin, reveal-batch, approval and
 * metadata events, kept for the record and the console.
 */
export const PROJECTED_EVENTS = [
  "AgentMinted",
  "Transfer",
  "OwnerEpochBumped",
  "AgentRevealed",
] as const satisfies readonly AgentNftEventName[];

export const USDC_TRANSFER_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
