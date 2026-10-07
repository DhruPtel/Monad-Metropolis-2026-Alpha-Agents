import { PrivyClient } from "@privy-io/node";

/**
 * Who is calling (P1-U2's session check, moved here in P1-U4): a Privy access
 * token proves the user, and Privy's user record lists the wallets they
 * linked. Nothing here logs or echoes a token; the app secret stays inside.
 */
export interface VerifiedSession {
  readonly userId: string;
  readonly sessionId: string;
  /** Token expiry, Unix seconds. */
  readonly expiresAt: number;
}

export interface Identity {
  /** Verifies an access token, or throws. */
  verify(accessToken: string): Promise<VerifiedSession>;
  /** The Ethereum wallets the user has linked. Throws when Privy cannot be reached. */
  walletsOf(session: VerifiedSession): Promise<readonly string[]>;
}

export function privyIdentity(appId: string, appSecret: string): Identity {
  const client = new PrivyClient({ appId, appSecret });
  return {
    async verify(accessToken) {
      const claims = await client.utils().auth().verifyAccessToken(accessToken);
      return { userId: claims.user_id, sessionId: claims.session_id, expiresAt: claims.expiration };
    },
    async walletsOf(session) {
      const user = await client.users()._get(session.userId);
      return user.linked_accounts.flatMap((account) =>
        account.type === "wallet" && "chain_type" in account && account.chain_type === "ethereum"
          ? [account.address]
          : [],
      );
    },
  };
}

/**
 * TEST STACKS ONLY (ALPHA_E2E_MOCK_IDENTITY=1, refused outside APP_ENV=local):
 * the web test build's mock wallets. A mock token names the one wallet it was
 * issued for, and links only that wallet, as a Privy session links only the
 * wallet that logged in; a token for one wallet never acts for another. These
 * values must equal apps/web/src/auth/mock-wallet-constants.ts
 * (identity.test.ts checks).
 */
export const MOCK_WALLET_MARKER = "alpha-agents-mock-wallet-e2e-only";
export const MOCK_WALLET_ADDRESS = "0x00000000000000000000000000000000000e2e01";
export const MOCK_ACCESS_TOKEN = `mock-token-${MOCK_WALLET_MARKER}`;
export const MOCK_IDENTITY_FLAG = "ALPHA_E2E_MOCK_IDENTITY";

/** The mock token for one wallet. */
export const mockAccessTokenFor = (wallet: string): string =>
  `${MOCK_ACCESS_TOKEN}:${wallet.toLowerCase()}`;

const MOCK_USER = `did:mock:${MOCK_WALLET_MARKER}:`;

export function mockIdentity(): Identity {
  return {
    async verify(token) {
      const wallet = token.startsWith(`${MOCK_ACCESS_TOKEN}:`)
        ? token.slice(MOCK_ACCESS_TOKEN.length + 1)
        : "";
      if (!/^0x[0-9a-f]{40}$/.test(wallet)) throw new Error("not a mock wallet's token");
      return { userId: `${MOCK_USER}${wallet}`, sessionId: "mock-session", expiresAt: 0 };
    },
    async walletsOf(session) {
      return session.userId.startsWith(MOCK_USER) ? [session.userId.slice(MOCK_USER.length)] : [];
    },
  };
}
