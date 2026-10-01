import {
  DEFAULT_ENVIRONMENT,
  ENVIRONMENTS,
  ENVIRONMENT_IDS,
  type Environment,
  isEnvironmentId,
} from "./environments.ts";
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
}

export interface Config {
  readonly environment: Environment;
  readonly service: string;
  /** True only for a signing service that passed the mainnet guard. */
  readonly signing: boolean;
  /** The chain RPC for this environment. Local is always the loopback anvil fork. */
  readonly rpcUrl: Secret;
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
  if ("variable" in environment.rpc) required.add(environment.rpc.variable);

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
    const raw = classify(spec, source[spec.name]);

    let text: string;
    if (raw.state === "set") {
      text = raw.value;
    } else if (raw.state === "unset" && localDefault !== undefined) {
      text = localDefault;
    } else if (raw.state === "unset") {
      if (isRequired) issues.push({ variable: spec.name, problem: "is not set" });
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
      ? new Secret(environment.rpc.fixedUrl)
      : (values[environment.rpc.variable as VariableName] as Secret);
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
