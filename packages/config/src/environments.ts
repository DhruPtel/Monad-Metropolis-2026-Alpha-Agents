/**
 * The environments, selected by APP_ENV: the three every service can run in,
 * and `canary`, the P2-EC mainnet canary's own (D-251), which only
 * `pnpm canary:mainnet` and the address book accept; every service refuses it.
 *
 * `label` is the environment ID stamped on records and shown in the UI and the
 * API environment field (D-030, D-145); `id` is the short value of APP_ENV.
 */
export const ENVIRONMENT_IDS = ["local", "testnet", "beta", "canary"] as const;
export type EnvironmentId = (typeof ENVIRONMENT_IDS)[number];

export const DEFAULT_ENVIRONMENT: EnvironmentId = "local";

/** The environment ID stamped on every record, by APP_ENV value. */
export const ENVIRONMENT_LABELS = ["fork", "testnet", "mainnet-beta", "mainnet-canary"] as const;
export type EnvironmentLabel = (typeof ENVIRONMENT_LABELS)[number];

export const MONAD_MAINNET_CHAIN_ID = 143;
export const MONAD_TESTNET_CHAIN_ID = 10143;

/**
 * The local fork's own chain ID (D-195). The fork copies Monad mainnet's state
 * at the pinned block and runs Monad's EVM (anvil --network monad), but it
 * answers 143143, not 143, so a wallet can never mistake Monad mainnet for the
 * fork: with both on 143, MetaMask sent a local mint to mainnet through its
 * gasless relay (L-53). 143143 is in no public chain registry. Contracts on
 * the fork see this ID in block.chainid, so EIP-712 claims and Tokenbound
 * accounts use it too.
 */
export const LOCAL_FORK_CHAIN_ID = 143143;

/** The anvil fork started by `pnpm dev:up`: the playtest fork. */
export const LOCAL_FORK_RPC_URL = "http://127.0.0.1:8545";

/** The port tests run their own fork on, never the playtest fork's (D-200). */
export const LOCAL_TEST_FORK_PORT = 8546;

/**
 * The loopback fork this process uses: the playtest fork, or the test fork
 * when LOCAL_FORK_PORT says so (D-200). Always loopback, so local signing can
 * never reach a remote chain.
 */
export function localForkRpcUrl(
  source: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const raw = source.LOCAL_FORK_PORT?.trim();
  if (!raw) return LOCAL_FORK_RPC_URL;
  const port = Number(raw);
  if (!/^\d{1,5}$/.test(raw) || port < 1 || port > 65535) {
    throw new Error("LOCAL_FORK_PORT must be a port number from 1 to 65535");
  }
  return `http://127.0.0.1:${port}`;
}

export interface Environment {
  readonly id: EnvironmentId;
  readonly label: EnvironmentLabel;
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
    chainId: LOCAL_FORK_CHAIN_ID,
    description:
      "anvil fork of Monad mainnet at the pinned block, on this machine, as chain 143143",
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
  canary: {
    id: "canary",
    label: "mainnet-canary",
    chainId: MONAD_MAINNET_CHAIN_ID,
    description:
      "Monad mainnet, P2-EC's throwaway canary of the trading contracts (D-251); only pnpm canary:mainnet runs here",
    rpc: { variable: "MONAD_RPC_URL" },
  },
};

export function isEnvironmentId(value: string): value is EnvironmentId {
  return (ENVIRONMENT_IDS as readonly string[]).includes(value);
}
