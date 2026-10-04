import "server-only";
import { loadConfig, type Secret } from "@alpha-agents/config";
import { PrivyClient } from "@privy-io/node";
import type { AccessTokenVerifier } from "./session";

export interface PrivyVerifierOptions {
  readonly appId: string;
  readonly appSecret: string;
  /**
   * The app's ES256 verification key (PEM, from the Privy dashboard). With it
   * verification is local; without it the SDK fetches the key from Privy.
   */
  readonly verificationKey?: string;
}

/** A verifier backed by Privy's own token verification (ES256, issuer privy.io, audience the app ID). */
export function privyVerifier(options: PrivyVerifierOptions): AccessTokenVerifier {
  const client = new PrivyClient({
    appId: options.appId,
    appSecret: options.appSecret,
    ...(options.verificationKey ? { jwtVerificationKey: options.verificationKey } : {}),
  });
  return async (accessToken) => {
    const claims = await client.utils().auth().verifyAccessToken(accessToken);
    return {
      userId: claims.user_id,
      sessionId: claims.session_id,
      expiresAt: claims.expiration,
    };
  };
}

/**
 * The verifier for this server, from PRIVY_APP_ID and PRIVY_APP_SECRET, or null
 * when they are not set (the route then answers 503). The secret is read here,
 * on the server, at request time; it is never bundled or sent to a browser.
 */
export function configuredPrivyVerifier(
  env: Record<string, string | undefined> = process.env,
): AccessTokenVerifier | null {
  try {
    const config = loadConfig(
      {
        name: "web session check",
        usesChain: false,
        requires: ["PRIVY_APP_ID", "PRIVY_APP_SECRET"],
      },
      env,
    );
    return privyVerifier({
      appId: String(config.values.PRIVY_APP_ID),
      appSecret: (config.values.PRIVY_APP_SECRET as Secret).reveal(),
    });
  } catch {
    return null;
  }
}
