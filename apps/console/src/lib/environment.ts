import {
  ConfigError,
  type ConfigSummary,
  type EnvSource,
  loadConfig,
  summarizeConfig,
} from "@alpha-agents/config";
import { type StackHealth, stackHealth } from "@alpha-agents/devenv";

/**
 * Everything the Environment panel shows. Config comes only through
 * summarizeConfig, which never holds a secret value; a ConfigError holds only
 * variable names and problems.
 */
export type ConfigView =
  | { readonly ok: true; readonly summary: ConfigSummary }
  | { readonly ok: false; readonly issues: readonly { variable: string; problem: string }[] };

export function configView(source: EnvSource = process.env): ConfigView {
  try {
    return { ok: true, summary: summarizeConfig(loadConfig({ name: "dev console" }, source)) };
  } catch (err) {
    if (err instanceof ConfigError) {
      return {
        ok: false,
        issues: err.issues.map((i) => ({ variable: i.variable, problem: i.problem })),
      };
    }
    throw err;
  }
}

export interface EnvironmentSnapshot {
  readonly config: ConfigView;
  readonly health: StackHealth;
}

export async function environmentSnapshot(
  source: EnvSource = process.env,
): Promise<EnvironmentSnapshot> {
  return { config: configView(source), health: await stackHealth() };
}
