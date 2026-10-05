import "server-only";
import { loadConfig, type Secret } from "@alpha-agents/config";
import { PrivyClient } from "@privy-io/node";
import { configuredPrivyVerifier } from "./privy";
import type { AccessTokenVerifier, VerifiedSession } from "./session";

/**
 * Who a session belongs to, in a real build: Privy verifies the token, and
 * Privy's user record lists the wallets that user linked (P1-U11 claim route).
 * Test builds alias "#server-identity" to identity-mock.ts instead.
 */
export function sessionVerifier(): AccessTokenVerifier | null {
  return configuredPrivyVerifier();
}

/** The Ethereum wallets the Privy user has linked, or none when Privy is not configured. */
export async function walletsOf(session: VerifiedSession): Promise<readonly string[]> {
  let appId: string;
  let appSecret: string;
  try {
    const config = loadConfig(
      { name: "web claim route", usesChain: false, requires: ["PRIVY_APP_ID", "PRIVY_APP_SECRET"] },
      process.env,
    );
    appId = String(config.values.PRIVY_APP_ID);
    appSecret = (config.values.PRIVY_APP_SECRET as Secret).reveal();
  } catch {
    return [];
  }
  const user = await new PrivyClient({ appId, appSecret }).users()._get(session.userId);
  return user.linked_accounts.flatMap((account) =>
    account.type === "wallet" && "chain_type" in account && account.chain_type === "ethereum"
      ? [account.address]
      : [],
  );
}
