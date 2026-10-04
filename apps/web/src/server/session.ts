/**
 * The server-side session check (P1-U2): proves which Privy user is calling, so
 * the API, minting and My Agents can trust the identity. Pure: the verifier is
 * passed in, so tests run the real Privy verification against their own key.
 *
 * Nothing here logs or echoes a token, and the Privy app secret never leaves
 * the server (it lives inside the verifier).
 */

/** What a verified Privy access token proves. */
export interface VerifiedSession {
  /** The Privy user ID (a DID such as did:privy:...). */
  readonly userId: string;
  readonly sessionId: string;
  /** Token expiry, Unix seconds. */
  readonly expiresAt: number;
}

/** Verifies an access token, or throws. */
export type AccessTokenVerifier = (accessToken: string) => Promise<VerifiedSession>;

export type SessionError = "not_configured" | "missing_token" | "invalid_token";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** The bearer token from an Authorization header, or null if absent or malformed. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  return match?.[1] ?? null;
}

/**
 * 200 with the session for a valid token; 401 for a missing or invalid one;
 * 503 when login is not configured on this server. The 401 body never says why
 * a token failed, so it cannot be used to probe the verifier.
 */
export async function sessionResponse(
  request: Request,
  verify: AccessTokenVerifier | null,
): Promise<Response> {
  if (!verify) return json(503, { error: "not_configured" satisfies SessionError });
  const token = bearerToken(request);
  if (!token) return json(401, { error: "missing_token" satisfies SessionError });
  let session: VerifiedSession;
  try {
    session = await verify(token);
  } catch {
    return json(401, { error: "invalid_token" satisfies SessionError });
  }
  return json(200, session);
}
