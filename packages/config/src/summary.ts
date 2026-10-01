import type { Config } from "./load.ts";
import { Secret } from "./secret.ts";
import { VARIABLES, type VariableName } from "./variables.ts";

export interface ConfigSummary {
  readonly appEnv: string;
  readonly environment: string;
  readonly chainId: number;
  readonly service: string;
  readonly signing: boolean;
  /** Public values as-is; secrets as "set (redacted)"; unset variables are omitted. */
  readonly variables: Readonly<Partial<Record<VariableName, string>>>;
}

/** A summary of a loaded config that is safe to log: no secret value appears in it. */
export function summarizeConfig(config: Config): ConfigSummary {
  const variables: Partial<Record<VariableName, string>> = {};
  for (const { name } of VARIABLES) {
    const value = config.values[name];
    if (value === undefined) continue;
    variables[name] = value instanceof Secret ? "set (redacted)" : String(value);
  }
  return {
    appEnv: config.environment.id,
    environment: config.environment.label,
    chainId: config.environment.chainId,
    service: config.service,
    signing: config.signing,
    variables,
  };
}
