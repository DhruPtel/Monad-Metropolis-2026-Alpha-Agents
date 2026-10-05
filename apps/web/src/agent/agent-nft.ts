// AgentNFT's ABI, deployment and mint claim live in packages/domain (P1-U4),
// shared with the control API's claim signer.
export {
  AGENT_NFT_ABI,
  CLAIM_TYPES,
  agentNftDeployment,
  claimDomain,
  type AgentNftDeployment,
  type MintClaim,
} from "@alpha-agents/domain";
