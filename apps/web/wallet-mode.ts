/**
 * Which wallet provider a build of the web app contains (P1-U2). Read by
 * next.config.ts at build and start time.
 *
 * A real build always gets the Privy provider and writes to `.next`. Only an
 * explicit test build (ALPHA_E2E_MOCK_WALLET=1, set by `pnpm build:e2e` and the
 * Playwright server) swaps in the mock wallet, writes to a separate `.next-e2e`
 * so it can never be served as the real app, and is refused outright unless the
 * build targets the local fork.
 */
export const MOCK_WALLET_FLAG = "ALPHA_E2E_MOCK_WALLET";

export interface WalletBuildMode {
  readonly mock: boolean;
  /** The module that "#wallet-provider" resolves to, relative to apps/web. */
  readonly providerModule: string;
  /**
   * The module that "#server-identity" resolves to: who a session token
   * belongs to and which wallets they linked (P1-U11 claim route).
   */
  readonly identityModule: string;
  readonly distDir: ".next" | ".next-e2e";
}

export function walletBuildMode(
  env: Readonly<Record<string, string | undefined>>,
): WalletBuildMode {
  const flag = env[MOCK_WALLET_FLAG]?.trim();
  if (flag === undefined || flag === "" || flag === "0") {
    return {
      mock: false,
      providerModule: "./src/auth/privy-wallet-provider.tsx",
      identityModule: "./src/server/identity-privy.ts",
      distDir: ".next",
    };
  }
  if (flag !== "1") throw new Error(`${MOCK_WALLET_FLAG} must be 1 or unset, not "${flag}"`);
  const appEnv = env.APP_ENV?.trim() || "local";
  if (appEnv !== "local") {
    throw new Error(
      `${MOCK_WALLET_FLAG}=1 is for local test builds only; refusing it with APP_ENV=${appEnv}`,
    );
  }
  return {
    mock: true,
    providerModule: "./src/auth/mock-wallet-provider.tsx",
    identityModule: "./src/server/identity-mock.ts",
    distDir: ".next-e2e",
  };
}
