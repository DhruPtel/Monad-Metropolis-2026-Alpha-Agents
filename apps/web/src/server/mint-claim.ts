/**
 * The minimal mint claim route (P1-U11, D-194): local fork only. It proves who
 * is calling (the Privy session), checks the wallet asked for is one that user
 * has linked, and signs AgentNFT's EIP-712 claim for exactly that wallet with
 * the local dev signer. The real signer, with the beta allowlist, is P1-U4's.
 *
 * Pure: every dependency is passed in, so tests run it without Privy, a chain
 * or a key from .env. Nothing here logs; the signer key never leaves the server.
 */
import type { EnvironmentId } from "@alpha-agents/config";
import { type Address, getAddress, isAddress, isAddressEqual } from "viem";
import { CLAIM_TYPES, type MintClaim, claimDomain } from "@/agent/agent-nft";
import { type AccessTokenVerifier, type VerifiedSession, bearerToken } from "./session";

/** Signs EIP-712 typed data; a viem local account fits. */
export interface ClaimSigner {
  readonly address: Address;
  signTypedData(args: {
    domain: ReturnType<typeof claimDomain>;
    types: typeof CLAIM_TYPES;
    primaryType: "MintClaim";
    message: { wallet: Address; nonce: `0x${string}`; deadline: bigint };
  }): Promise<`0x${string}`>;
}

export interface MintClaimDeps {
  readonly environment: EnvironmentId;
  readonly verify: AccessTokenVerifier | null;
  /** The wallets linked to a Privy user. */
  readonly walletsOf: (session: VerifiedSession) => Promise<readonly string[]>;
  readonly signer: ClaimSigner | null;
  readonly contract: Address | null;
  readonly chainId: number;
  /** Whether the wallet has already minted, read from the chain. */
  readonly hasMinted: (wallet: Address) => Promise<boolean>;
  readonly now: () => number;
  readonly randomNonce: () => `0x${string}`;
}

/** How long a claim stays valid, in seconds. */
export const CLAIM_TTL_SECONDS = 600;

export type MintClaimError =
  | "local_only"
  | "not_configured"
  | "missing_token"
  | "invalid_token"
  | "bad_request"
  | "wallet_not_linked"
  | "already_minted";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const error = (status: number, code: MintClaimError, message: string) =>
  json(status, { error: code, message });

export async function mintClaimResponse(request: Request, deps: MintClaimDeps): Promise<Response> {
  // Refuse outright anywhere but the local fork: this signer is a dev key.
  if (deps.environment !== "local") {
    return error(404, "local_only", "The dev claim route runs on the local fork only.");
  }
  if (!deps.verify || !deps.signer || !deps.contract) {
    return error(
      503,
      "not_configured",
      "Minting is not configured: set LOCAL_CLAIM_SIGNER_PRIVATE_KEY and the Privy keys in .env, and deploy AgentNFT to the fork.",
    );
  }
  const token = bearerToken(request);
  if (!token) return error(401, "missing_token", "Log in to mint.");
  let session: VerifiedSession;
  try {
    session = await deps.verify(token);
  } catch {
    return error(401, "invalid_token", "Log in to mint.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(400, "bad_request", "Send the wallet to mint for.");
  }
  const raw = (body as { wallet?: unknown } | null)?.wallet;
  if (typeof raw !== "string" || !isAddress(raw, { strict: false })) {
    return error(400, "bad_request", "Send the wallet to mint for.");
  }
  const wallet = getAddress(raw);

  const linked = await deps.walletsOf(session);
  if (
    !linked.some((w) => isAddress(w, { strict: false }) && isAddressEqual(getAddress(w), wallet))
  ) {
    return error(403, "wallet_not_linked", "That wallet is not the one you logged in with.");
  }
  if (await deps.hasMinted(wallet)) {
    return error(409, "already_minted", "This wallet has already minted an agent.");
  }

  const nonce = deps.randomNonce();
  const deadline = BigInt(Math.floor(deps.now() / 1000) + CLAIM_TTL_SECONDS);
  const signature = await deps.signer.signTypedData({
    domain: claimDomain(deps.chainId, deps.contract),
    types: CLAIM_TYPES,
    primaryType: "MintClaim",
    message: { wallet, nonce, deadline },
  });
  const claim: MintClaim = {
    wallet,
    nonce,
    deadline: deadline.toString(),
    signature,
    contract: deps.contract,
  };
  return json(200, claim);
}
