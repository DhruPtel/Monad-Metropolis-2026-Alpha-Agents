import { CLAIM_TYPES, type MintClaim, claimDomain } from "@alpha-agents/domain";
import type { Address, Hex } from "viem";

/**
 * The mint claim (D-184, D-198): AgentNFT's EIP-712 MintClaim for one wallet,
 * with a nonce that works once and a short deadline.
 */
export interface ClaimSigner {
  readonly address: Address;
  signTypedData(args: {
    domain: ReturnType<typeof claimDomain>;
    types: typeof CLAIM_TYPES;
    primaryType: "MintClaim";
    message: { wallet: Address; nonce: Hex; deadline: bigint };
  }): Promise<Hex>;
}

/** How long a claim stays valid, in seconds. */
export const CLAIM_TTL_SECONDS = 600;

export async function signClaim(
  signer: ClaimSigner,
  input: { wallet: Address; contract: Address; chainId: number; nonce: Hex; nowSeconds: number },
): Promise<MintClaim> {
  const deadline = BigInt(input.nowSeconds + CLAIM_TTL_SECONDS);
  const signature = await signer.signTypedData({
    domain: claimDomain(input.chainId, input.contract),
    types: CLAIM_TYPES,
    primaryType: "MintClaim",
    message: { wallet: input.wallet, nonce: input.nonce, deadline },
  });
  return {
    wallet: input.wallet,
    nonce: input.nonce,
    deadline: deadline.toString(),
    signature,
    contract: input.contract,
  };
}

/** Why a wallet can or cannot mint, as the eligibility endpoint and the mint page say it. */
export type Eligibility = "eligible" | "not_allowlisted" | "already_minted" | "sold_out";

export const ELIGIBILITY_MESSAGES: Readonly<Record<Eligibility, string>> = {
  eligible: "This wallet can mint one agent.",
  not_allowlisted: "This wallet is not on the beta mint allowlist.",
  already_minted: "This wallet has already minted an agent.",
  sold_out: "All agents have been minted.",
};
