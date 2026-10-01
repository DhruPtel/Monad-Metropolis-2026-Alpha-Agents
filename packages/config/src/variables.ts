import { z } from "zod";
import type { EnvironmentId } from "./environments.ts";

/**
 * Every environment variable the full build reads, in .env.example order.
 * The list comes from the Phase 0 owner setup checklist (BUILD_PLAN.md section 3).
 *
 * `example` is what .env.example shows. When `commented` is false it is a
 * placeholder: a value equal to it counts as not set, so a copied template never
 * looks configured. When `commented` is true it is a real default, written as a
 * commented-out line.
 */
export interface VariableSpec {
  readonly name: string;
  readonly group: string;
  readonly description: string;
  readonly secret: boolean;
  readonly firstUsedBy: string;
  readonly environments: readonly EnvironmentId[];
  readonly schema: z.ZodType<string | number | boolean>;
  /** Human description of a valid value, used in error messages. Never the value itself. */
  readonly expected: string;
  readonly example: string;
  readonly commented?: boolean;
  /** Used in the local environment only, when the variable is not set. */
  readonly localDefault?: string;
}

const ALL: readonly EnvironmentId[] = ["local", "testnet", "beta"];
const REMOTE: readonly EnvironmentId[] = ["testnet", "beta"];

const httpUrl = { schema: z.url({ protocol: /^https?$/ }), expected: "an http(s) URL" };
const postgresUrl = {
  schema: z.url({ protocol: /^postgres(ql)?$/ }),
  expected: "a postgres:// URL",
};
const redisUrl = { schema: z.url({ protocol: /^rediss?$/ }), expected: "a redis:// URL" };
const token = { schema: z.string().regex(/^\S+$/), expected: "a value without spaces" };
const port = {
  schema: z
    .string()
    .regex(/^\d{1,5}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535)),
  expected: "a port number from 1 to 65535",
};
const flag = {
  schema: z.enum(["true", "false"]).transform((v) => v === "true"),
  expected: 'exactly "true" or "false"',
};
const address = {
  schema: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  expected: "a 0x-prefixed 20-byte hex address",
};
const privateKey = {
  schema: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  expected: "a 0x-prefixed 32-byte hex private key",
};
const oneOf = (values: readonly [string, ...string[]]) => ({
  schema: z.enum(values),
  expected: `one of ${values.join(", ")}`,
});

export const VARIABLES = [
  // Environment
  {
    name: "APP_ENV",
    group: "Environment",
    description: "Which environment this process runs in: local, testnet or beta",
    secret: false,
    firstUsedBy: "P0-U3",
    environments: ALL,
    ...oneOf(["local", "testnet", "beta"]),
    example: "local",
    commented: true,
  },
  {
    name: "BETA_SIGNING_ENABLED",
    group: "Environment",
    description:
      'Must be "true" for a signing service to start with APP_ENV=beta; rejected elsewhere',
    secret: false,
    firstUsedBy: "P0-U3",
    environments: ["beta"],
    ...flag,
    example: "false",
    commented: true,
  },

  // Chain RPC
  {
    name: "MONAD_RPC_URL",
    group: "Chain RPC",
    description:
      "Monad mainnet RPC (chain 143): upstream of the local fork, and the beta chain RPC",
    secret: true,
    firstUsedBy: "P0-U2",
    environments: ["local", "beta"],
    ...httpUrl,
    example: "https://your-monad-mainnet-rpc.example/your-api-key",
  },
  {
    name: "MONAD_RPC_URL_SECONDARY",
    group: "Chain RPC",
    description: "Second Monad mainnet RPC provider, for failover and cross-checks (Q-23)",
    secret: true,
    firstUsedBy: "P2-U4",
    environments: ["beta"],
    ...httpUrl,
    example: "https://your-second-monad-mainnet-rpc.example/your-api-key",
  },
  {
    name: "MONAD_TESTNET_RPC_URL",
    group: "Chain RPC",
    description: "Monad testnet RPC (chain 10143); never a mainnet URL",
    secret: true,
    firstUsedBy: "P1-U3",
    environments: ["testnet"],
    ...httpUrl,
    example: "https://your-monad-testnet-rpc.example/your-api-key",
  },

  // Local Docker services
  {
    name: "POSTGRES_PORT",
    group: "Local Docker services",
    description: "Host port for the local Postgres container",
    secret: false,
    firstUsedBy: "P0-U2",
    environments: ["local"],
    ...port,
    example: "5432",
    commented: true,
  },
  {
    name: "POSTGRES_PASSWORD",
    group: "Local Docker services",
    description: "Password for the local Postgres container (development only)",
    secret: true,
    firstUsedBy: "P0-U2",
    environments: ["local"],
    ...token,
    example: "alpha_local_dev_only",
    commented: true,
  },
  {
    name: "REDIS_PORT",
    group: "Local Docker services",
    description: "Host port for the local Redis container",
    secret: false,
    firstUsedBy: "P0-U2",
    environments: ["local"],
    ...port,
    example: "6380",
    commented: true,
  },

  // Database and queue
  {
    name: "DATABASE_URL",
    group: "Database and queue",
    description: "Postgres connection URL; defaults to the local container in local",
    secret: true,
    firstUsedBy: "P0-U4",
    environments: ALL,
    ...postgresUrl,
    example: "postgres://alpha:alpha_local_dev_only@127.0.0.1:5432/alpha_agents",
    commented: true,
    localDefault: "postgres://alpha:alpha_local_dev_only@127.0.0.1:5432/alpha_agents",
  },
  {
    name: "REDIS_URL",
    group: "Database and queue",
    description: "Redis connection URL; defaults to the local container in local",
    secret: true,
    firstUsedBy: "P1-U5",
    environments: ALL,
    ...redisUrl,
    example: "redis://127.0.0.1:6380",
    commented: true,
    localDefault: "redis://127.0.0.1:6380",
  },

  // Testnet keys (never used by local or beta)
  {
    name: "TESTNET_DEPLOYER_PRIVATE_KEY",
    group: "Testnet keys",
    description: "Testnet contract deployer key; holds faucet MON only",
    secret: true,
    firstUsedBy: "P1-U3",
    environments: ["testnet"],
    ...privateKey,
    example: "0x0000000000000000000000000000000000000000000000000000000000000000",
  },
  {
    name: "TESTNET_GUARDIAN_PRIVATE_KEY",
    group: "Testnet keys",
    description: "Testnet guardian key; can only tighten limits",
    secret: true,
    firstUsedBy: "P1-U3",
    environments: ["testnet"],
    ...privateKey,
    example: "0x0000000000000000000000000000000000000000000000000000000000000000",
  },
  {
    name: "TESTNET_SENTINEL_PRIVATE_KEY",
    group: "Testnet keys",
    description: "Testnet sentinel key, separate from the guardian key (D-138)",
    secret: true,
    firstUsedBy: "P1-U3",
    environments: ["testnet"],
    ...privateKey,
    example: "0x0000000000000000000000000000000000000000000000000000000000000000",
  },
  {
    name: "TESTNET_ADMIN_SAFE_ADDRESS",
    group: "Testnet keys",
    description: "Admin multisig (Safe) on Monad testnet",
    secret: false,
    firstUsedBy: "P1-U3",
    environments: ["testnet"],
    ...address,
    example: "0x0000000000000000000000000000000000000000",
  },

  // Beta keys (KMS references only; no raw mainnet key is ever an env var)
  {
    name: "BETA_DEPLOYER_KMS_KEY_ID",
    group: "Beta keys",
    description: "KMS key reference for the mainnet deployer",
    secret: true,
    firstUsedBy: "PB-U1",
    environments: ["beta"],
    ...token,
    example: "your-beta-deployer-kms-key-id",
  },
  {
    name: "BETA_GUARDIAN_KMS_KEY_ID",
    group: "Beta keys",
    description: "KMS key reference for the mainnet guardian",
    secret: true,
    firstUsedBy: "PB-U1",
    environments: ["beta"],
    ...token,
    example: "your-beta-guardian-kms-key-id",
  },
  {
    name: "BETA_SENTINEL_KMS_KEY_ID",
    group: "Beta keys",
    description: "KMS key reference for the mainnet sentinel, separate from the guardian (D-138)",
    secret: true,
    firstUsedBy: "PB-U1",
    environments: ["beta"],
    ...token,
    example: "your-beta-sentinel-kms-key-id",
  },
  {
    name: "BETA_ADMIN_SAFE_ADDRESS",
    group: "Beta keys",
    description: "Admin multisig (Safe) on Monad mainnet",
    secret: false,
    firstUsedBy: "PB-U1",
    environments: ["beta"],
    ...address,
    example: "0x0000000000000000000000000000000000000000",
  },

  // Cloud KMS (funding addresses, signer, skill key broker)
  {
    name: "KMS_PROVIDER",
    group: "Cloud KMS",
    description: "Cloud KMS provider for funding address keys and the signer",
    secret: false,
    firstUsedBy: "P1-U5",
    environments: REMOTE,
    ...oneOf(["aws", "gcp"]),
    example: "aws",
    commented: true,
  },
  {
    name: "KMS_CREDENTIALS",
    group: "Cloud KMS",
    description: "Credentials for the KMS provider (a path or a provider credential string)",
    secret: true,
    firstUsedBy: "P1-U5",
    environments: REMOTE,
    ...token,
    example: "your-kms-credentials",
  },
  {
    name: "TESTNET_KMS_KEY_RING",
    group: "Cloud KMS",
    description: "Key ring or alias prefix for testnet funding address keys",
    secret: false,
    firstUsedBy: "P1-U5",
    environments: ["testnet"],
    ...token,
    example: "your-testnet-key-ring",
  },
  {
    name: "BETA_KMS_KEY_RING",
    group: "Cloud KMS",
    description: "Key ring or alias prefix for mainnet funding address keys",
    secret: false,
    firstUsedBy: "PB-U1",
    environments: ["beta"],
    ...token,
    example: "your-beta-key-ring",
  },

  // Agent runtime
  {
    name: "E2B_API_KEY",
    group: "Agent runtime",
    description: "E2B sandbox API key (Q-04)",
    secret: true,
    firstUsedBy: "P1-U1",
    environments: ALL,
    ...token,
    example: "your-e2b-api-key",
  },
  {
    name: "HERMES_API_SERVER_KEY",
    group: "Agent runtime",
    description: "Hermes API server key, 32 or more characters",
    secret: true,
    firstUsedBy: "P1-U1",
    environments: ALL,
    schema: z.string().regex(/^\S{32,}$/),
    expected: "32 or more characters without spaces",
    example: "your-hermes-api-server-key-of-32-or-more-characters",
  },

  // Model gateway
  {
    name: "LITELLM_BASE_URL",
    group: "Model gateway",
    description: "LiteLLM gateway URL that every model call goes through",
    secret: false,
    firstUsedBy: "P1-U1",
    environments: ALL,
    ...httpUrl,
    example: "https://your-litellm-gateway.example",
  },
  {
    name: "LITELLM_MASTER_KEY",
    group: "Model gateway",
    description: "LiteLLM master key, used only to mint per-agent virtual keys",
    secret: true,
    firstUsedBy: "P1-U1",
    environments: ALL,
    ...token,
    example: "your-litellm-master-key",
  },
  {
    name: "ANTHROPIC_API_KEY",
    group: "Model gateway",
    description: "Model provider key, read by LiteLLM only (Q-08 decides the provider list)",
    secret: true,
    firstUsedBy: "P1-U1",
    environments: ALL,
    ...token,
    example: "your-anthropic-api-key",
  },
  {
    name: "OPENAI_API_KEY",
    group: "Model gateway",
    description: "Model provider key, read by LiteLLM only (Q-08 decides the provider list)",
    secret: true,
    firstUsedBy: "P1-U1",
    environments: ALL,
    ...token,
    example: "your-openai-api-key",
  },

  // Wallet login
  {
    name: "PRIVY_APP_ID",
    group: "Wallet login",
    description: "Privy app ID (MetaMask and OKX enabled)",
    secret: false,
    firstUsedBy: "P1-U2",
    environments: ALL,
    ...token,
    example: "your-privy-app-id",
  },
  {
    name: "PRIVY_APP_SECRET",
    group: "Wallet login",
    description: "Privy app secret, server side only",
    secret: true,
    firstUsedBy: "P1-U2",
    environments: ALL,
    ...token,
    example: "your-privy-app-secret",
  },

  // Indexer and monitoring
  {
    name: "ENVIO_API_TOKEN",
    group: "Indexer and monitoring",
    description: "Envio HyperIndex and HyperSync API token",
    secret: true,
    firstUsedBy: "P1-U4",
    environments: ALL,
    ...token,
    example: "your-envio-api-token",
  },
  {
    name: "SENTRY_DSN",
    group: "Indexer and monitoring",
    description: "Sentry DSN for errors (P1-U4) and alerts (PB-U1)",
    secret: false,
    firstUsedBy: "P1-U4",
    environments: ALL,
    ...httpUrl,
    example: "https://your-key@your-org.ingest.sentry.example/0",
  },

  // Research data
  {
    name: "SEARCH_PROVIDER",
    group: "Research data",
    description: "Web search provider (Q-24)",
    secret: false,
    firstUsedBy: "P1-U7",
    environments: ALL,
    ...oneOf(["exa", "tavily"]),
    example: "exa",
    commented: true,
  },
  {
    name: "SEARCH_API_KEY",
    group: "Research data",
    description: "Web search API key",
    secret: true,
    firstUsedBy: "P1-U7",
    environments: ALL,
    ...token,
    example: "your-search-api-key",
  },
  {
    name: "X_API_BEARER_TOKEN",
    group: "Research data",
    description: "X API bearer token, pay per use",
    secret: true,
    firstUsedBy: "P3-U2",
    environments: ALL,
    ...token,
    example: "your-x-api-bearer-token",
  },
  {
    name: "DUNE_API_KEY",
    group: "Research data",
    description: "Dune API key",
    secret: true,
    firstUsedBy: "P3-U2",
    environments: ALL,
    ...token,
    example: "your-dune-api-key",
  },
  {
    name: "COINGECKO_API_KEY",
    group: "Research data",
    description: "CoinGecko API key",
    secret: true,
    firstUsedBy: "P3-U2",
    environments: ALL,
    ...token,
    example: "your-coingecko-api-key",
  },
  {
    name: "WALLET_DATA_PROVIDER",
    group: "Research data",
    description: "Wallet data provider for the wallet and holder tools (Q-24)",
    secret: false,
    firstUsedBy: "P3-U2",
    environments: ALL,
    ...token,
    example: "your-wallet-data-provider",
  },
  {
    name: "WALLET_DATA_API_KEY",
    group: "Research data",
    description: "Wallet data provider API key",
    secret: true,
    firstUsedBy: "P3-U2",
    environments: ALL,
    ...token,
    example: "your-wallet-data-api-key",
  },

  // Payments (x402)
  {
    name: "TESTNET_X402_FACILITATOR_URL",
    group: "Payments (x402)",
    description: "x402 facilitator endpoint on Monad testnet (Q-20)",
    secret: false,
    firstUsedBy: "P5-U4",
    environments: ["testnet"],
    ...httpUrl,
    example: "https://your-testnet-x402-facilitator.example",
  },
  {
    name: "BETA_X402_FACILITATOR_URL",
    group: "Payments (x402)",
    description: "x402 facilitator endpoint on Monad mainnet (Q-20)",
    secret: false,
    firstUsedBy: "P8-U4",
    environments: ["beta"],
    ...httpUrl,
    example: "https://your-mainnet-x402-facilitator.example",
  },

  // Publishing
  {
    name: "PINNING_API_KEY",
    group: "Publishing",
    description: "IPFS or Arweave pinning service key for token metadata and art (Q-26)",
    secret: true,
    firstUsedBy: "P6-U5",
    environments: ALL,
    ...token,
    example: "your-pinning-api-key",
  },

  // Web
  {
    name: "APP_PUBLIC_URL",
    group: "Web",
    description: "Public URL of the web app",
    secret: false,
    firstUsedBy: "PB-U1",
    environments: ALL,
    ...httpUrl,
    example: "http://localhost:3000",
    commented: true,
    localDefault: "http://localhost:3000",
  },
] as const satisfies readonly VariableSpec[];

export type VariableName = (typeof VARIABLES)[number]["name"];

const BY_NAME: ReadonlyMap<string, VariableSpec> = new Map(VARIABLES.map((v) => [v.name, v]));

export function variableSpec(name: string): VariableSpec | undefined {
  return BY_NAME.get(name);
}

export function isVariableName(name: string): name is VariableName {
  return BY_NAME.has(name);
}
