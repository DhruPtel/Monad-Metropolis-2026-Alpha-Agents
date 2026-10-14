/**
 * The environments, selected by APP_ENV: the three every service can run in,
 * and `canary`, the P2-EC mainnet canary's own (D-251), which only
 * `pnpm canary:mainnet` and the address book accept; every service refuses it.
 *
 * `label` is the environment ID stamped on records and shown in the UI and the
 * API environment field (D-030, D-145); `id` is the short value of APP_ENV.
 */
export const ENVIRONMENT_IDS = ["local", "base", "testnet", "beta", "canary"] as const;
export type EnvironmentId = (typeof ENVIRONMENT_IDS)[number];

export const DEFAULT_ENVIRONMENT: EnvironmentId = "local";

/** The environment ID stamped on every record, by APP_ENV value. */
export const ENVIRONMENT_LABELS = [
  "fork",
  "base-fork",
  "testnet",
  "mainnet-beta",
  "mainnet-canary",
] as const;
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
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;

/**
 * Colosseum (2026-10-14): APP_ENV=testnet runs on one of three testnets, chosen per process by
 * TESTNET_CHAIN (Monad testnet when unset, so every existing testnet process is unchanged). Each
 * stack is siloed: its own database, its own address book, the same testnet operator keys.
 */
export const TESTNET_CHAIN_KEYS = ["monad", "base-sepolia", "arbitrum-sepolia"] as const;
export type TestnetChainKey = (typeof TESTNET_CHAIN_KEYS)[number];
export interface TestnetChain {
  readonly key: TestnetChainKey;
  readonly chainId: number;
  readonly name: string;
  readonly native: "MON" | "ETH";
  /** The RPC variable services read, and the optional second provider's. */
  readonly rpcVariable: string;
  readonly secondaryRpcVariable: string | null;
  /** The public RPC a browser wallet is offered. */
  readonly browserRpcUrl: string;
  /** A transaction's page on the chain's explorer, before the hash. */
  readonly explorerTxUrl: string;
}
export const TESTNET_CHAINS: Readonly<Record<TestnetChainKey, TestnetChain>> = {
  monad: {
    key: "monad",
    chainId: 10143,
    name: "Monad Testnet",
    native: "MON",
    rpcVariable: "MONAD_TESTNET_RPC_URL",
    secondaryRpcVariable: "MONAD_TESTNET_RPC_URL_SECONDARY",
    browserRpcUrl: "https://testnet-rpc.monad.xyz",
    explorerTxUrl: "https://testnet.monadvision.com/tx/",
  },
  "base-sepolia": {
    key: "base-sepolia",
    chainId: BASE_SEPOLIA_CHAIN_ID,
    name: "Base Sepolia",
    native: "ETH",
    rpcVariable: "BASE_SEPOLIA_RPC_URL",
    secondaryRpcVariable: null,
    browserRpcUrl: "https://sepolia.base.org",
    explorerTxUrl: "https://sepolia.basescan.org/tx/",
  },
  "arbitrum-sepolia": {
    key: "arbitrum-sepolia",
    chainId: ARBITRUM_SEPOLIA_CHAIN_ID,
    name: "Arbitrum Sepolia",
    native: "ETH",
    rpcVariable: "ARBITRUM_SEPOLIA_RPC_URL",
    secondaryRpcVariable: null,
    browserRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    explorerTxUrl: "https://sepolia.arbiscan.io/tx/",
  },
};
export const TESTNET_CHAIN_IDS: readonly number[] = TESTNET_CHAIN_KEYS.map(
  (k) => TESTNET_CHAINS[k].chainId,
);
export function testnetChainFor(raw: string | undefined): TestnetChain {
  const key = raw?.trim() || "monad";
  if (!(TESTNET_CHAIN_KEYS as readonly string[]).includes(key))
    throw new Error(`TESTNET_CHAIN must be one of ${TESTNET_CHAIN_KEYS.join(", ")}, not "${key}"`);
  return TESTNET_CHAINS[key as TestnetChainKey];
}
/** This process's testnet. The web build inlines TESTNET_CHAIN (next.config.ts). */
export const TESTNET_CHAIN: TestnetChain = testnetChainFor(
  typeof process === "undefined" ? undefined : process.env.TESTNET_CHAIN,
);

/**
 * CO-U1: the wrapped native token's symbol, and the name and native token of the market this
 * process's agents research: WETH and Base on the L2 testnets (whose research reads Base's
 * market) and the Base fork, WMON and Monad otherwise.
 */
const ETH_MARKET =
  (typeof process !== "undefined" && process.env.APP_ENV === "base") ||
  (typeof process !== "undefined" &&
    process.env.APP_ENV === "testnet" &&
    TESTNET_CHAIN.native === "ETH");
export const WRAPPED_NATIVE_SYMBOL: "WETH" | "WMON" = ETH_MARKET ? "WETH" : "WMON";
export const RESEARCH_MARKET: { readonly name: string; readonly native: string } = ETH_MARKET
  ? { name: "Base", native: "ETH" }
  : { name: "Monad", native: "MON" };

export const LOCAL_FORK_CHAIN_ID = 143143;
/** Base mainnet (M-FAST). */
export const BASE_MAINNET_CHAIN_ID = 8453;
/**
 * The Base fork's own chain id (M-FAST): never Base's 8453, for the reason
 * LESSONS "Wallets and networks" gives (a fork that shares a real chain's id
 * lets a wallet send a local transaction to the real chain, L-53).
 */
export const BASE_FORK_CHAIN_ID = 84538453;
/** The Base fork's default port, beside the playtest fork on 8545 and the test forks. */
/**
 * Base's public endpoint (M-FAST, A-98): the Base fork's upstream and the
 * base environment's research reads when BASE_RPC_URL is unset. Rate limited
 * and not an archive node; the owner adds a keyed endpoint for a steadier fork.
 */
export const BASE_PUBLIC_RPC_URL = "https://mainnet.base.org";
export const BASE_FORK_PORT = 8590;
export const BASE_FORK_RPC_URL = `http://127.0.0.1:${BASE_FORK_PORT}`;
/** The environments that are anvil forks on this machine: local-only features and dev actions run there. */
export const FORK_ENVIRONMENT_IDS = ["local", "base"] as const;
export type ForkEnvironmentId = (typeof FORK_ENVIRONMENT_IDS)[number];
export function isForkEnvironment(id: string): id is ForkEnvironmentId {
  return (FORK_ENVIRONMENT_IDS as readonly string[]).includes(id);
}
/** The chain ids a fork on this machine answers. */
export const FORK_CHAIN_IDS: readonly number[] = [LOCAL_FORK_CHAIN_ID, BASE_FORK_CHAIN_ID];

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

/** The Base fork's RPC URL (M-FAST): port 8590, or BASE_FORK_PORT; always loopback. */
export function baseForkRpcUrl(
  source: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const raw = source.BASE_FORK_PORT?.trim();
  if (!raw) return BASE_FORK_RPC_URL;
  const port = Number(raw);
  if (!/^\d{1,5}$/.test(raw) || port < 1 || port > 65535) {
    throw new Error("BASE_FORK_PORT must be a port number from 1 to 65535");
  }
  return `http://127.0.0.1:${port}`;
}

/** A fork environment's RPC URL from the environment variables (the port overrides). */
export function forkRpcUrl(
  id: ForkEnvironmentId,
  source: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return id === "base" ? baseForkRpcUrl(source) : localForkRpcUrl(source);
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
  base: {
    id: "base",
    label: "base-fork",
    chainId: BASE_FORK_CHAIN_ID,
    description:
      "anvil fork of Base mainnet at the pinned block, on this machine, as chain 84538453 (M-FAST: development on a fork, not a Base deployment)",
    rpc: { fixedUrl: BASE_FORK_RPC_URL },
  },
  testnet: {
    id: "testnet",
    label: "testnet",
    chainId: TESTNET_CHAIN.chainId,
    description: TESTNET_CHAIN.key === "monad" ? "Monad testnet" : TESTNET_CHAIN.name,
    rpc: { variable: TESTNET_CHAIN.rpcVariable },
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
