/**
 * The three environments every service can run in, selected by APP_ENV.
 *
 * `label` is the environment ID stamped on records and shown in the UI and the
 * API environment field (D-030, D-145); `id` is the short value of APP_ENV.
 */
export const ENVIRONMENT_IDS = ["local", "testnet", "beta"] as const;
export type EnvironmentId = (typeof ENVIRONMENT_IDS)[number];

export const DEFAULT_ENVIRONMENT: EnvironmentId = "local";

export const MONAD_MAINNET_CHAIN_ID = 143;
export const MONAD_TESTNET_CHAIN_ID = 10143;

/** The anvil fork started by `pnpm dev:up`. Local services sign only against this. */
export const LOCAL_FORK_RPC_URL = "http://127.0.0.1:8545";

export interface Environment {
  readonly id: EnvironmentId;
  readonly label: "fork" | "testnet" | "mainnet-beta";
  readonly chainId: number;
  readonly description: string;
  /**
   * Where services in this environment send transactions and reads. A variable
   * name, or a fixed loopback URL for the local fork so local signing can never
   * reach a remote chain.
   */
  readonly rpc: { readonly variable: string } | { readonly fixedUrl: string };
}

export const ENVIRONMENTS: Readonly<Record<EnvironmentId, Environment>> = {
  local: {
    id: "local",
    label: "fork",
    chainId: MONAD_MAINNET_CHAIN_ID,
    description: "anvil fork of Monad mainnet at the pinned block, on this machine",
    rpc: { fixedUrl: LOCAL_FORK_RPC_URL },
  },
  testnet: {
    id: "testnet",
    label: "testnet",
    chainId: MONAD_TESTNET_CHAIN_ID,
    description: "Monad testnet",
    rpc: { variable: "MONAD_TESTNET_RPC_URL" },
  },
  beta: {
    id: "beta",
    label: "mainnet-beta",
    chainId: MONAD_MAINNET_CHAIN_ID,
    description: "Monad mainnet, guarded beta (allowlists, caps, unaudited beta label)",
    rpc: { variable: "MONAD_RPC_URL" },
  },
};

export function isEnvironmentId(value: string): value is EnvironmentId {
  return (ENVIRONMENT_IDS as readonly string[]).includes(value);
}
