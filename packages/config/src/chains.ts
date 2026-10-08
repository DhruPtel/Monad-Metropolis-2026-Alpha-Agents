import {
  DEFAULT_ENVIRONMENT,
  ENVIRONMENTS,
  type EnvironmentId,
  isEnvironmentId,
  LOCAL_FORK_RPC_URL,
} from "./environments.ts";

/**
 * The chain the web app asks a wallet to use, per environment. Plain data, so
 * the app turns it into a viem/wagmi chain without this package depending on
 * either.
 *
 * `browserRpcUrl` is public by design: it ships to every browser. It is never
 * one of our keyed RPC URLs (those are secrets, P0-U3). The public Monad RPCs
 * answered eth_chainId 0x8f (143) and 0x279f (10143) on 2026-10-04.
 */
export interface AppChain {
  readonly environment: EnvironmentId;
  readonly id: number;
  /** Shown to the user and offered to the wallet when it adds the network. */
  readonly name: string;
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: 18;
  };
  readonly browserRpcUrl: string;
  readonly testnet: boolean;
}

const MON = { name: "MON", symbol: "MON", decimals: 18 } as const;

export const APP_CHAINS: Readonly<Record<EnvironmentId, AppChain>> = {
  local: {
    environment: "local",
    id: ENVIRONMENTS.local.chainId,
    name: "Monad (local fork)",
    nativeCurrency: MON,
    browserRpcUrl: LOCAL_FORK_RPC_URL,
    testnet: true,
  },
  testnet: {
    environment: "testnet",
    id: ENVIRONMENTS.testnet.chainId,
    name: "Monad Testnet",
    nativeCurrency: MON,
    browserRpcUrl: "https://testnet-rpc.monad.xyz",
    testnet: true,
  },
  beta: {
    environment: "beta",
    id: ENVIRONMENTS.beta.chainId,
    name: "Monad",
    nativeCurrency: MON,
    browserRpcUrl: "https://rpc.monad.xyz",
    testnet: false,
  },
  // Listed for completeness only: no web build accepts the canary (D-251, D-252).
  canary: {
    environment: "canary",
    id: ENVIRONMENTS.canary.chainId,
    name: "Monad",
    nativeCurrency: MON,
    browserRpcUrl: "https://rpc.monad.xyz",
    testnet: false,
  },
};

/**
 * The environment a web build targets, from APP_ENV. Unset means local (the
 * default everywhere); an unknown value is an error, never a silent fallback to
 * a chain the user did not mean.
 */
export function webEnvironment(appEnv: string | undefined): EnvironmentId {
  const value = appEnv?.trim();
  if (!value) return DEFAULT_ENVIRONMENT;
  if (!isEnvironmentId(value) || value === "canary")
    throw new Error(
      value === "canary"
        ? `APP_ENV "canary" is the mainnet canary's; the web app is never pointed at it (D-251, D-252)`
        : `APP_ENV "${value}" is not one of local, testnet, beta`,
    );
  return value;
}

/**
 * The chain for an environment. A local build may point at another loopback
 * fork (the test fork, D-200) with `localRpcUrl`; other environments ignore it.
 */
export function appChain(environment: EnvironmentId, localRpcUrl?: string): AppChain {
  const chain = APP_CHAINS[environment];
  return environment === "local" && localRpcUrl ? { ...chain, browserRpcUrl: localRpcUrl } : chain;
}
