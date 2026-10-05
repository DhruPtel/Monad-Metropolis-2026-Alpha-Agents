import "server-only";
import {
  MOCK_ACCESS_TOKEN,
  MOCK_WALLET_ADDRESS,
  MOCK_WALLET_MARKER,
} from "@/auth/mock-wallet-constants";
import type { AccessTokenVerifier, VerifiedSession } from "./session";

/**
 * TEST BUILDS ONLY (ALPHA_E2E_MOCK_WALLET=1 on local; wallet-mode.ts): the mock
 * wallet's session. It accepts only the mock wallet's token and links only the
 * mock wallet, so the end-to-end mint flow runs without Privy.
 */
export function sessionVerifier(): AccessTokenVerifier | null {
  return async (token) => {
    if (token !== MOCK_ACCESS_TOKEN) throw new Error("not the mock wallet's token");
    return { userId: `did:mock:${MOCK_WALLET_MARKER}`, sessionId: "mock-session", expiresAt: 0 };
  };
}

/** The mock session links exactly the mock wallet, whoever asks. */
export function walletsOf(session: VerifiedSession): Promise<readonly string[]> {
  return Promise.resolve(session.userId.startsWith("did:mock:") ? [MOCK_WALLET_ADDRESS] : []);
}
