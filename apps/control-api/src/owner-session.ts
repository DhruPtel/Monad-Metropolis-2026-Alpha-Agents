import { SignJWT, jwtVerify } from "jose";
import { type Address, getAddress } from "viem";

/**
 * Owner sessions (P1-U2's item, built in P1-U4, D-199): a short-lived token
 * that says which wallet owns which agent at which ownership epoch. Every
 * owner-only action checks it against a fresh chain read, so a transfer,
 * which bumps the epoch, ends every session the old owner held.
 */
export interface OwnerClaims {
  readonly wallet: Address;
  readonly agentId: bigint;
  readonly ownerEpoch: bigint;
  readonly chainId: number;
  readonly userId: string;
}

export const OWNER_SESSION_TTL_SECONDS = 15 * 60;
const AUDIENCE = "alpha-agents-control-api";
const ISSUER = "alpha-agents-control-api";

export async function issueOwnerSession(
  secret: string,
  claims: OwnerClaims,
  nowSeconds: number,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = nowSeconds + OWNER_SESSION_TTL_SECONDS;
  const token = await new SignJWT({
    wallet: claims.wallet,
    agentId: claims.agentId.toString(),
    ownerEpoch: claims.ownerEpoch.toString(),
    chainId: claims.chainId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(secret));
  return { token, expiresAt };
}

/** The claims of a valid, unexpired token signed with this secret; throws otherwise. */
export async function readOwnerSession(
  secret: string,
  token: string,
  nowSeconds: number,
): Promise<OwnerClaims> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
    audience: AUDIENCE,
    issuer: ISSUER,
    currentDate: new Date(nowSeconds * 1000),
  });
  const { wallet, agentId, ownerEpoch, chainId } = payload as Record<string, unknown>;
  if (
    typeof wallet !== "string" ||
    typeof agentId !== "string" ||
    typeof ownerEpoch !== "string" ||
    typeof chainId !== "number" ||
    typeof payload.sub !== "string"
  ) {
    throw new Error("malformed owner session");
  }
  return {
    wallet: getAddress(wallet),
    agentId: BigInt(agentId),
    ownerEpoch: BigInt(ownerEpoch),
    chainId,
    userId: payload.sub,
  };
}
