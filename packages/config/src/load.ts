import {
  DEFAULT_ENVIRONMENT,
  ENVIRONMENTS,
  ENVIRONMENT_IDS,
  type Environment,
  isEnvironmentId,
  localForkRpcUrl,
} from "./environments.ts";
import { createHash } from "node:crypto";
import { Secret } from "./secret.ts";
import { VARIABLES, type VariableName, type VariableSpec } from "./variables.ts";

export type ConfigValue = string | number | boolean | Secret;
export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface ServiceSpec {
  /** Shown in error messages, for example "signer" or "dev scripts". */
  readonly name: string;
  /** True for any service that can sign transactions. Gates beta on BETA_SIGNING_ENABLED. */
  readonly signs?: boolean;
  /** Variables this service cannot start without, beyond the environment's chain RPC. */
  readonly requires?: readonly VariableName[];
  /**
   * False for a service that never reads or writes the chain (the web session
   * check): the environment's RPC is then not required, and `rpcUrl` is null when
   * it is not set. Defaults to true.
   */
  readonly usesChain?: boolean;
}

export interface Config {
  readonly environment: Environment;
  readonly service: string;
  /** True only for a signing service that passed the mainnet guard. */
  readonly signing: boolean;
  /**
   * The chain RPC for this environment. Local is always the loopback anvil fork.
   * Null only for a service with `usesChain: false` whose RPC is not set.
   */
  readonly rpcUrl: Secret | null;
  /** Every variable of this environment that is set; secrets are wrapped in Secret. */
  readonly values: Readonly<Partial<Record<VariableName, ConfigValue>>>;
}

export interface ConfigIssue {
  readonly variable: string;
  /** Says what is wrong in words. Never contains the value. */
  readonly problem: string;
}

/**
 * Thrown when configuration is missing or invalid. The message and `issues` name
 * variables and describe the problem; they never contain a value, and there is
 * no `cause`, so nothing that wraps or logs this error can leak a secret.
 */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(heading: string, issues: readonly ConfigIssue[]) {
    super(
      [heading, ...issues.map((i) => `  - ${i.variable} ${i.problem}`)].join("\n") +
        "\nSee .env.example for every variable, its format and the unit that first uses it.",
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

type Raw =
  | { state: "unset" }
  | { state: "empty" }
  | { state: "placeholder" }
  | { state: "set"; value: string };

/** A value equal to the template's placeholder, or a URL on an .example host, is not configured. */
function classify(spec: VariableSpec, raw: string | undefined): Raw {
  if (raw === undefined) return { state: "unset" };
  const value = raw.trim();
  if (value === "") return { state: "empty" };
  if (!spec.commented && value === spec.example) return { state: "placeholder" };
  if (/^[a-z]+:\/\//i.test(value)) {
    try {
      if (new URL(value).hostname.endsWith(".example")) return { state: "placeholder" };
    } catch {
      // Not a parseable URL; the schema reports it as invalid.
    }
  }
  return { state: "set", value };
}

function selectEnvironment(source: EnvSource): Environment {
  const raw = source.APP_ENV;
  if (raw === undefined) return ENVIRONMENTS[DEFAULT_ENVIRONMENT];
  const value = raw.trim();
  if (value === "") {
    throw new ConfigError("Configuration is invalid:", [
      { variable: "APP_ENV", problem: "is set but empty; remove it to use local" },
    ]);
  }
  if (!isEnvironmentId(value)) {
    throw new ConfigError("Configuration is invalid:", [
      { variable: "APP_ENV", problem: `must be one of ${ENVIRONMENT_IDS.join(", ")}` },
    ]);
  }
  return ENVIRONMENTS[value];
}

/**
 * Loads and validates configuration for one service in the environment named by
 * APP_ENV (default local). Throws ConfigError listing every problem at once.
 *
 * Only variables of the selected environment are read, so a local or testnet
 * process never loads a mainnet key reference, and vice versa.
 */
export function loadConfig(service: ServiceSpec, source: EnvSource = process.env): Config {
  const environment = selectEnvironment(source);
  const heading = `Configuration for ${service.name} (APP_ENV=${environment.id}) is invalid:`;
  const issues: ConfigIssue[] = [];

  const required = new Set<string>(service.requires ?? []);
  if (service.usesChain !== false && "variable" in environment.rpc)
    required.add(environment.rpc.variable);

  const specs: readonly VariableSpec[] = VARIABLES;
  const inScope = specs.filter((spec) => spec.environments.includes(environment.id));
  for (const name of required) {
    if (!inScope.some((spec) => spec.name === name)) {
      throw new ConfigError(heading, [
        { variable: name, problem: `is not used by the ${environment.id} environment` },
      ]);
    }
  }

  const values: Partial<Record<VariableName, ConfigValue>> = {};
  for (const spec of inScope) {
    if (spec.name === "APP_ENV") continue;
    const isRequired = required.has(spec.name);
    const localDefault = environment.id === "local" ? spec.localDefault : undefined;
    // On testnet a key with a testnet source is read only from it (D-254).
    const sourceName =
      environment.id === "testnet" && spec.testnetSource ? spec.testnetSource : spec.name;
    const raw = classify(spec, source[sourceName]);

    let text: string;
    if (raw.state === "set") {
      text = raw.value;
    } else if (raw.state === "unset" && localDefault !== undefined) {
      text = localDefault;
    } else if (raw.state === "unset") {
      if (isRequired)
        issues.push({
          variable: spec.name,
          problem:
            sourceName === spec.name ? "is not set" : `is not set (on testnet it is ${sourceName})`,
        });
      continue;
    } else if (isRequired || localDefault !== undefined) {
      // An empty or template value that would silently not take effect is an error.
      issues.push({
        variable: spec.name,
        problem:
          raw.state === "empty"
            ? "is set but empty"
            : "is still the .env.example placeholder; set a real value",
      });
      continue;
    } else {
      // An optional variable left empty or as the template placeholder counts as not set.
      continue;
    }

    const parsed = spec.schema.safeParse(text);
    if (!parsed.success) {
      issues.push({ variable: spec.name, problem: `is invalid: expected ${spec.expected}` });
      continue;
    }
    values[spec.name as VariableName] = spec.secret ? new Secret(text) : parsed.data;
  }

  checkGuards(environment, service, source, values, issues);
  if (issues.length > 0) throw new ConfigError(heading, issues);

  const rpcUrl =
    "fixedUrl" in environment.rpc
      ? new Secret(localForkRpcUrl(source))
      : ((values[environment.rpc.variable as VariableName] as Secret | undefined) ?? null);
  return {
    environment,
    service: service.name,
    signing: service.signs === true,
    rpcUrl,
    values,
  };
}

/** The mainnet guard. Pushes issues; never reads a value into a message. */
function checkGuards(
  environment: Environment,
  service: ServiceSpec,
  source: EnvSource,
  values: Partial<Record<VariableName, ConfigValue>>,
  issues: ConfigIssue[],
): void {
  // Steered reveals exist only with the local fork's simulated randomness (D-221).
  // Anywhere else a set value means a local .env reached a real network: refuse.
  const steer = source.LOCAL_FIRST_REVEAL_SPECIES?.trim();
  if (environment.id !== "local" && steer && steer !== "random") {
    issues.push({
      variable: "LOCAL_FIRST_REVEAL_SPECIES",
      problem: `is set, but steered reveals exist only with APP_ENV=local; on ${environment.id} reveals use real Pyth Entropy. Remove it`,
    });
  }

  if (environment.id === "beta") {
    if (service.signs === true && values.BETA_SIGNING_ENABLED !== true) {
      issues.push({
        variable: "BETA_SIGNING_ENABLED",
        problem: `must be "true" for ${service.name} to sign on Monad mainnet; it is a signing service and APP_ENV=beta`,
      });
    }
    return;
  }

  // Outside beta the flag has no meaning, and a set flag means a beta .env was
  // pointed at the wrong environment.
  if (source.BETA_SIGNING_ENABLED?.trim() === "true") {
    issues.push({
      variable: "BETA_SIGNING_ENABLED",
      problem: `is "true", which is only allowed with APP_ENV=beta`,
    });
  }

  // Testnet must never point at the mainnet RPC. Local signs only against the
  // fixed loopback fork, so it cannot reach chain 143 remotely.
  if (environment.id === "testnet") {
    checkTestnetKeys(source, issues);
    checkTestnetServices(source, issues);
    const testnet = source.MONAD_TESTNET_RPC_URL?.trim();
    const mainnet = source.MONAD_RPC_URL?.trim();
    if (testnet && mainnet && testnet === mainnet) {
      issues.push({
        variable: "MONAD_TESTNET_RPC_URL",
        problem: "is the same URL as MONAD_RPC_URL (Monad mainnet); use a testnet RPC",
      });
    }
  }
}

/**
 * sha256 of anvil's ten well-known development keys (the "test test ... junk"
 * mnemonic, accounts 0 to 9), each as a lowercase 0x-prefixed hex string.
 * Stored as hashes, so no key appears in the source.
 */
const ANVIL_KEY_HASHES = new Set([
  "60a09e4357868c1e9b801052726d061c370429f723db84523ed58ac354f6eb8a",
  "095101cf732c298a0ce0320b9de704209cdd8640b70d8fdf4e5be51aa2eb272e",
  "bb4978fbe7638de8e6ee13d9a59a5fb047beb0f0ee059fe166541b1f96b6af63",
  "f02322197a196ceb746aa52cee2a869abf0fe231c4d6d050a8a5f02c6625a1d4",
  "5de22089c247b9b2722ec5c33498e6bc481b1faba85f4da957f8b84679fcf88c",
  "59feecfa04eb096ba44eed297e4239fa32d8840cbc1ffb8ff2f7fd8e8e0edd38",
  "b69d88ff1ad5834ab1d8ed45f20d72b6ccf3429c9ccc75b93d14ca0ee00dec16",
  "b6b9ee08c38f62da71fa150a8ada4a7a09c7d3c4a9f6445e51e5a4b2c6395368",
  "be394de37f9d6cf6682434e9f15a4f891eca9b614bf79da2da22a8e48a658fcd",
  "dd0102d1cd0c6ac702573e3e7551fc6cec26596b6287348804c1b0f9544b5bf9",
]);

/** True when `value` is one of anvil's well-known development keys. */
export function isAnvilKey(value: string): boolean {
  const hash = createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
  return ANVIL_KEY_HASHES.has(hash);
}

/** The testnet keys and seeds, each with the local variable it must differ from, if any. */
const TESTNET_KEYS: readonly (readonly [string, string | null])[] = [
  ["TESTNET_DEPLOYER_PRIVATE_KEY", null],
  ["TESTNET_GUARDIAN_PRIVATE_KEY", null],
  ["TESTNET_SENTINEL_PRIVATE_KEY", null],
  ["TESTNET_CLAIM_SIGNER_PRIVATE_KEY", "CLAIM_SIGNER_PRIVATE_KEY"],
  ["TESTNET_REVEAL_KEEPER_PRIVATE_KEY", "REVEAL_KEEPER_PRIVATE_KEY"],
  ["TESTNET_FUNDING_ADDRESS_SEED", "FUNDING_ADDRESS_SEED"],
  ["TESTNET_FEED_PRIVATE_KEY", null],
];

/**
 * D-254 (4): no testnet key or seed is one of anvil's well-known keys, equal
 * to the local key it replaces, or equal to another testnet key. Never reads
 * a value into a message.
 */
function checkTestnetKeys(source: EnvSource, issues: ConfigIssue[]): void {
  const seen = new Map<string, string>();
  for (const [name, local] of TESTNET_KEYS) {
    const value = source[name]?.trim().toLowerCase();
    if (!value || /^0x0{64}$/.test(value)) continue;
    if (isAnvilKey(value)) {
      issues.push({ variable: name, problem: "is one of anvil's well-known development keys" });
    }
    if (local && source[local]?.trim().toLowerCase() === value) {
      issues.push({
        variable: name,
        problem: `is the same as the local ${local}; testnet keys must differ from local ones`,
      });
    }
    const other = seen.get(value);
    if (other)
      issues.push({ variable: name, problem: `is the same as ${other}; use a key of its own` });
    else seen.set(value, name);
  }
}

/** The local containers' default database and queue, which testnet must never share. */
const LOCAL_DATABASE_URL = "postgres://alpha:alpha_local_dev_only@127.0.0.1:5432/alpha_agents";

/** A testnet process keeps its own database and Redis database (P2-EC). */
function checkTestnetServices(source: EnvSource, issues: ConfigIssue[]): void {
  const db = source.DATABASE_URL?.trim();
  if (db && db.replace(/\/+$/, "") === LOCAL_DATABASE_URL) {
    issues.push({
      variable: "DATABASE_URL",
      problem: "is the local database; testnet uses a database of its own",
    });
  }
  const redis = source.REDIS_URL?.trim();
  if (redis) {
    try {
      const url = new URL(redis);
      const index = url.pathname.replace(/^\//, "");
      const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      if (loopback && (index === "" || index === "0")) {
        issues.push({
          variable: "REDIS_URL",
          problem: "is the local Redis database 0; testnet uses another database index",
        });
      }
    } catch {
      // The schema reports an invalid URL.
    }
  }
}

/**
 * Checks the chain ID an RPC reported against the environment. Services call
 * this at startup, after eth_chainId and before any signing.
 */
export function assertChainId(config: Config, observedChainId: number): void {
  if (observedChainId !== config.environment.chainId) {
    throw new ConfigError(
      `Chain check for ${config.service} (APP_ENV=${config.environment.id}) failed:`,
      [
        {
          variable:
            "variable" in config.environment.rpc ? config.environment.rpc.variable : "local fork",
          problem: `reports chain ID ${observedChainId}, but ${config.environment.id} is chain ${config.environment.chainId}`,
        },
      ],
    );
  }
}
