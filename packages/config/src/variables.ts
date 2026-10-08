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
  /**
   * On testnet the value is read from this variable instead, and the variable
   * itself is ignored (P2-EC, D-254). One .env holds the local and the testnet
   * keys side by side, so a testnet process can never pick up a local key.
   */
  readonly testnetSource?: string;
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
    description:
      "Which environment this process runs in: local, testnet or beta; canary only for pnpm canary:mainnet (D-251)",
    secret: false,
    firstUsedBy: "P0-U3",
    environments: [...ALL, "canary"],
    ...oneOf(["local", "testnet", "beta", "canary"]),
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
  {
    name: "CANARY_SIGNING_ENABLED",
    group: "Environment",
    description:
      'Must be "true" for pnpm canary:mainnet to sign on Monad mainnet with APP_ENV=canary (D-251); rejected elsewhere',
    secret: false,
    firstUsedBy: "P2-EC",
    environments: ["canary"],
    ...flag,
    example: "false",
    commented: true,
  },

  // Chain RPC
  {
    name: "MONAD_RPC_URL",
    group: "Chain RPC",
    description:
      "Monad mainnet RPC (chain 143): upstream of the local fork, and the beta and canary chain RPC",
    secret: true,
    firstUsedBy: "P0-U2",
    environments: ["local", "beta", "canary"],
    ...httpUrl,
    example: "https://your-monad-mainnet-rpc.example/your-api-key",
  },
  {
    name: "MONAD_RPC_URL_SECONDARY",
    group: "Chain RPC",
    description:
      "Second Monad mainnet RPC provider, for failover and cross-checks (Q-23); local forks fall back to it (D-220). On testnet the second provider is MONAD_TESTNET_RPC_URL_SECONDARY instead",
    secret: true,
    firstUsedBy: "P1-U9",
    environments: [...ALL, "canary"],
    ...httpUrl,
    example: "https://your-second-monad-mainnet-rpc.example/your-api-key",
    testnetSource: "MONAD_TESTNET_RPC_URL_SECONDARY",
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
  {
    name: "MONAD_TESTNET_RPC_URL_SECONDARY",
    group: "Chain RPC",
    description:
      "Second Monad testnet RPC provider, ideally another provider (D-254); the testnet signer's second RPC. Optional",
    secret: true,
    firstUsedBy: "P2-EC",
    environments: ["testnet"],
    ...httpUrl,
    example: "https://your-second-monad-testnet-rpc.example/your-api-key",
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
  {
    name: "LOCAL_FORK_PORT",
    group: "Local Docker services",
    description:
      "Port of the local anvil fork the services use: 8545 is the playtest fork (pnpm dev:up); tests set 8546 for their own fork (D-200)",
    secret: false,
    firstUsedBy: "P1-U4",
    environments: ["local"],
    ...port,
    example: "8545",
    commented: true,
    localDefault: "8545",
  },

  // Database and queue
  {
    name: "DATABASE_URL",
    group: "Database and queue",
    description: "Postgres connection URL; defaults to the local container in local",
    secret: true,
    firstUsedBy: "P0-U4",
    environments: [...ALL, "canary"],
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

  // Platform addresses
  {
    name: "PLATFORM_TREASURY_ADDRESS",
    group: "Platform addresses",
    description:
      "Platform treasury: the only address a credit settlement may pay (FINAL_PLAN 4.1.10, D-261). Unset refuses every settlement",
    secret: false,
    firstUsedBy: "P2-U5",
    environments: ALL,
    ...address,
    example: "0x0000000000000000000000000000000000000000",
  },

  // Mainnet canary keys (P2-EC part 2 only; throwaway, D-252, D-259, D-316)
  {
    name: "CANARY_OWNER_PRIVATE_KEY",
    group: "Mainnet canary keys",
    description:
      "The canary owner: deploys and administers the canary contracts and owns its one agent (D-259)",
    secret: true,
    firstUsedBy: "P2-EC",
    environments: ["canary"],
    ...privateKey,
    example: "0x0000000000000000000000000000000000000000000000000000000000000000",
  },
  {
    name: "CANARY_GUARDIAN_PRIVATE_KEY",
    group: "Mainnet canary keys",
    description: "The canary guardian: can only pause and tighten (D-252)",
    secret: true,
    firstUsedBy: "P2-EC",
    environments: ["canary"],
    ...privateKey,
    example: "0x0000000000000000000000000000000000000000000000000000000000000000",
  },
  {
    name: "CANARY_SESSION_PRIVATE_KEY",
    group: "Mainnet canary keys",
    description:
      "The canary's session key, a raw key never derived from a seed: at most 3 MON, granted for at most 24 hours (D-252)",
    secret: true,
    firstUsedBy: "P2-EC",
    environments: ["canary"],
    ...privateKey,
    example: "0x0000000000000000000000000000000000000000000000000000000000000000",
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
    name: "TESTNET_CLAIM_SIGNER_PRIVATE_KEY",
    group: "Testnet keys",
    description:
      "Testnet mint-claim signer, the testnet AgentNFT's claimSigner; the control API uses it as CLAIM_SIGNER_PRIVATE_KEY on testnet (P2-EC)",
    secret: true,
    firstUsedBy: "P2-EC",
    environments: ["testnet"],
    ...privateKey,
    example: "0x0000000000000000000000000000000000000000000000000000000000000000",
  },
  {
    name: "TESTNET_REVEAL_KEEPER_PRIVATE_KEY",
    group: "Testnet keys",
    description:
      "Testnet reveal keeper: pays the Entropy fee; the orchestrator uses it as REVEAL_KEEPER_PRIVATE_KEY on testnet (P2-EC)",
    secret: true,
    firstUsedBy: "P2-EC",
    environments: ["testnet"],
    ...privateKey,
    example: "0x0000000000000000000000000000000000000000000000000000000000000000",
  },
  {
    name: "TESTNET_FUNDING_ADDRESS_SEED",
    group: "Testnet keys",
    description:
      "Testnet seed for agents' funding addresses; the orchestrator uses it as FUNDING_ADDRESS_SEED on testnet (P2-EC)",
    secret: true,
    firstUsedBy: "P2-EC",
    environments: ["testnet"],
    schema: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    expected: "a 0x-prefixed 32-byte hex seed",
    example: "0x0000000000000000000000000000000000000000000000000000000000000000",
  },
  {
    name: "TESTNET_FEED_PRIVATE_KEY",
    group: "Testnet keys",
    description:
      "The only writer of the two TestnetFeeds (D-253); re-dates them on demand before an action that needs a fresh price (D-307)",
    secret: true,
    firstUsedBy: "P2-EC",
    environments: ["testnet"],
    ...privateKey,
    example: "0x0000000000000000000000000000000000000000000000000000000000000000",
  },
  {
    name: "TESTNET_TEST_WALLET_PRIVATE_KEY",
    group: "Testnet keys",
    description:
      "A throwaway owner wallet for P2-EC's end-to-end run on testnet (mint, deposit, arm, trade, withdraw); never an app or platform key",
    secret: true,
    firstUsedBy: "P2-EC",
    environments: ["testnet"],
    ...privateKey,
    example: "0x0000000000000000000000000000000000000000000000000000000000000000",
  },
  {
    name: "TESTNET_ORCHESTRATOR_SECRET",
    group: "Testnet keys",
    description:
      "The testnet orchestrator's secret (ORCHESTRATOR_SECRET on testnet): it encrypts each agent's stored gateway key, so it must stay the same across restarts. pnpm testnet:up creates it once if missing",
    secret: true,
    firstUsedBy: "P2-EC",
    environments: ["testnet"],
    schema: z.string().regex(/^\S{32,}$/),
    expected: "at least 32 characters without spaces",
    example: "your-random-testnet-orchestrator-secret",
  },
  {
    name: "TESTNET_API_SESSION_SECRET",
    group: "Testnet keys",
    description:
      "The testnet control API's session secret (API_SESSION_SECRET on testnet). pnpm testnet:up creates it once if missing",
    secret: true,
    firstUsedBy: "P2-EC",
    environments: ["testnet"],
    schema: z.string().regex(/^\S{32,}$/),
    expected: "at least 32 characters without spaces",
    example: "your-random-testnet-api-session-secret",
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

  {
    name: "ORCHESTRATOR_PORT",
    group: "Agent runtime",
    description: "Port the orchestrator's internal API listens on, loopback only (D-205)",
    secret: false,
    firstUsedBy: "P1-U5",
    environments: ALL,
    ...port,
    example: "4200",
    commented: true,
    localDefault: "4200",
  },
  {
    name: "SCAN_INTERVAL_MINUTES",
    group: "Agent runtime",
    description:
      "Minutes between scheduled Scans of a funded agent (D-216); each Scan spends the agent's credits",
    secret: false,
    firstUsedBy: "P1-U7",
    environments: ALL,
    schema: z
      .string()
      .regex(/^\d{1,6}$/)
      .transform(Number)
      .pipe(z.number().int().min(5).max(100_000)),
    expected: "a whole number of minutes from 5 to 100000",
    example: "360",
    commented: true,
    localDefault: "360",
  },
  {
    name: "ORCHESTRATOR_URL",
    group: "Agent runtime",
    description: "Base URL of the orchestrator's internal API, as the dev console calls it",
    secret: false,
    firstUsedBy: "P1-U5",
    environments: ALL,
    ...httpUrl,
    example: "http://127.0.0.1:4200",
    commented: true,
    localDefault: "http://127.0.0.1:4200",
  },
  {
    name: "ORCHESTRATOR_SECRET",
    group: "Agent runtime",
    description:
      "Encrypts each agent's LiteLLM virtual key at rest in Postgres (D-203); at least 32 characters. The default is for the local fork only: set a random one elsewhere",
    secret: true,
    firstUsedBy: "P1-U5",
    environments: ALL,
    schema: z.string().regex(/^\S{32,}$/),
    expected: "at least 32 characters without spaces",
    example: "local-fork-only-orchestrator-secret-0123456789",
    commented: true,
    localDefault: "local-fork-only-orchestrator-secret-0123456789",
    testnetSource: "TESTNET_ORCHESTRATOR_SECRET",
  },
  {
    name: "REVEAL_KEEPER_PRIVATE_KEY",
    group: "Agent runtime",
    description:
      "The reveal keeper's wallet: pays the Entropy fee and sends requestReveal and reveal (D-201). Any funded account; anvil account 3 on the local fork. Local and testnet only, KMS before the beta",
    secret: true,
    firstUsedBy: "P1-U5",
    environments: ["local", "testnet"],
    ...privateKey,
    example: "0x0000000000000000000000000000000000000000000000000000000000000000",
    testnetSource: "TESTNET_REVEAL_KEEPER_PRIVATE_KEY",
  },
  {
    name: "LOCAL_FIRST_REVEAL_SPECIES",
    group: "Agent runtime",
    description:
      "Local fork only (D-221): the species agent #1 reveals as on a fresh fork, as a slug (bee), or random. The keeper steers its simulated Entropy number; any other environment refuses to start with this set",
    secret: false,
    firstUsedBy: "P1-U9",
    environments: ["local"],
    schema: z.string().regex(/^(random|[a-z][a-z-]{1,30})$/),
    expected: "a species slug such as bee, or random",
    example: "random",
    commented: true,
    localDefault: "bee",
  },

  {
    name: "FUNDING_ADDRESS_SEED",
    group: "Agent runtime",
    description:
      "Platform seed every agent's funding address is derived from (D-207); held only by the orchestrator. One per environment, never reused. Local and testnet only, KMS keys before the beta",
    secret: true,
    firstUsedBy: "P1-U6",
    environments: ["local", "testnet"],
    schema: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    expected: "a 0x-prefixed 32-byte hex seed",
    example: "0x0000000000000000000000000000000000000000000000000000000000000000",
    testnetSource: "TESTNET_FUNDING_ADDRESS_SEED",
  },

  // Model gateway
  {
    name: "LITELLM_BASE_URL",
    group: "Model gateway",
    description:
      "LiteLLM gateway URL that every model call goes through; locally the agent compose profile",
    secret: false,
    firstUsedBy: "P1-U1",
    environments: ALL,
    ...httpUrl,
    example: "http://127.0.0.1:4000",
    commented: true,
    localDefault: "http://127.0.0.1:4000",
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
  {
    name: "CLAIM_SIGNER_PRIVATE_KEY",
    group: "Wallet login",
    description:
      "The control API's mint-claim signer key, AgentNFT's claimSigner (anvil account 1 on the local fork); local and testnet only, KMS before the beta (D-198). Was LOCAL_CLAIM_SIGNER_PRIVATE_KEY",
    secret: true,
    firstUsedBy: "P1-U4",
    environments: ["local", "testnet"],
    ...privateKey,
    example: "0x0000000000000000000000000000000000000000000000000000000000000000",
    testnetSource: "TESTNET_CLAIM_SIGNER_PRIVATE_KEY",
  },
  {
    name: "API_SESSION_SECRET",
    group: "Wallet login",
    description:
      "Signs the control API's short-lived owner sessions (wallet, agent, ownership epoch); at least 32 characters. The default is for the local fork only: set a random one elsewhere",
    secret: true,
    firstUsedBy: "P1-U4",
    environments: ALL,
    schema: z.string().regex(/^\S{32,}$/),
    expected: "at least 32 characters without spaces",
    example: "local-fork-only-api-session-secret-0123456789",
    commented: true,
    localDefault: "local-fork-only-api-session-secret-0123456789",
    testnetSource: "TESTNET_API_SESSION_SECRET",
  },

  // Indexer and monitoring
  {
    name: "CONTROL_API_PORT",
    group: "Indexer and monitoring",
    description: "Port the control API listens on",
    secret: false,
    firstUsedBy: "P1-U4",
    environments: ALL,
    ...port,
    example: "4100",
    commented: true,
    localDefault: "4100",
  },
  {
    name: "CONTROL_API_URL",
    group: "Indexer and monitoring",
    description: "Base URL of the control API, as the web app and the dev console call it",
    secret: false,
    firstUsedBy: "P1-U4",
    environments: ALL,
    ...httpUrl,
    example: "http://127.0.0.1:4100",
    commented: true,
    localDefault: "http://127.0.0.1:4100",
  },
  {
    name: "ENVIO_API_TOKEN",
    group: "Indexer and monitoring",
    description:
      "Envio HyperSync API token, for a later HyperSync log source; the RPC poller does not use it (D-197)",
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
    name: "TAVILY_API_KEY",
    group: "Research data",
    description: "Tavily API key for web_search and read_url on the data tools server (D-214)",
    secret: true,
    firstUsedBy: "P1-U7",
    environments: ALL,
    ...token,
    example: "your-tavily-api-key",
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
