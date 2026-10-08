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
  readonly distDir: ".next" | ".next-e2e" | ".next-testnet" | ".next-beta";
}

/**
 * D-254 (5): a build for any environment but local must name its control API;
 * the local default (127.0.0.1:4100) is the local stack's, never a real chain's.
 */
export function requireControlApiUrl(env: Readonly<Record<string, string | undefined>>): void {
  const appEnv = env.APP_ENV?.trim() || "local";
  if (appEnv !== "local" && !env.CONTROL_API_URL?.trim()) {
    throw new Error(`CONTROL_API_URL must be set for a web build with APP_ENV=${appEnv} (D-254)`);
  }
}

export function walletBuildMode(
  env: Readonly<Record<string, string | undefined>>,
): WalletBuildMode {
  const flag = env[MOCK_WALLET_FLAG]?.trim();
  const appEnv = env.APP_ENV?.trim() || "local";
  if (flag === undefined || flag === "" || flag === "0") {
    // Each real environment builds into its own folder, so a testnet build
    // never replaces the local one (P2-EC).
    return {
      mock: false,
      providerModule: "./src/auth/privy-wallet-provider.tsx",
      distDir: appEnv === "testnet" ? ".next-testnet" : appEnv === "beta" ? ".next-beta" : ".next",
    };
  }
  if (flag !== "1") throw new Error(`${MOCK_WALLET_FLAG} must be 1 or unset, not "${flag}"`);
  if (appEnv !== "local") {
    throw new Error(
      `${MOCK_WALLET_FLAG}=1 is for local test builds only; refusing it with APP_ENV=${appEnv}`,
    );
  }
  return {
    mock: true,
    providerModule: "./src/auth/mock-wallet-provider.tsx",
    distDir: ".next-e2e",
  };
}
