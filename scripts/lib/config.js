// @ts-check
import { existsSync, readFileSync } from "node:fs";
import {
  ConfigError,
  LOCAL_FORK_RPC_URL,
  MONAD_MAINNET_CHAIN_ID,
  loadConfig,
} from "@alpha-agents/config";
import { readForkConfig as readDevenvForkConfig } from "@alpha-agents/devenv";
import { ENV_PATH, FORK_CONFIG_PATH, FOUNDRY_VERSION_PATH } from "./paths.js";

export { MONAD_MAINNET_CHAIN_ID };
export const ANVIL_URL = LOCAL_FORK_RPC_URL;
const anvilUrl = new URL(ANVIL_URL);
export const ANVIL_HOST = anvilUrl.hostname;
export const ANVIL_PORT = Number(anvilUrl.port);

export { MIN_PLAUSIBLE_BLOCK, parseForkConfig } from "@alpha-agents/devenv";

/** The committed fork pin, chains/monad/fork.json, validated by packages/devenv. */
export function readForkConfig() {
  return readDevenvForkConfig(FORK_CONFIG_PATH);
}

/** @returns {string} the pinned Foundry version without the leading "v", for example "1.8.3" */
export function readFoundryVersion() {
  return readFileSync(FOUNDRY_VERSION_PATH, "utf8").trim().replace(/^v/, "");
}

/**
 * Extracts the version from `forge --version` or `anvil --version` output.
 * @param {string} output
 * @returns {string | undefined}
 */
export function parseFoundryVersion(output) {
  return /Version:\s*v?(\d+\.\d+\.\d+)/.exec(output)?.[1];
}

/** Loads the root .env into process.env without overriding variables already set. */
export function loadRootEnv() {
  if (existsSync(ENV_PATH)) {
    process.loadEnvFile(ENV_PATH);
  }
}

/**
 * Loads the shared config for the dev scripts, which run only the local fork and
 * need MONAD_RPC_URL as its upstream. Throws ConfigError, which never holds a value.
 * @param {Readonly<Record<string, string | undefined>>} [source]
 */
export function loadLocalConfig(source = process.env) {
  const appEnv = source.APP_ENV?.trim();
  if (appEnv !== undefined && appEnv !== "local") {
    throw new ConfigError("The dev scripts run only the local environment:", [
      { variable: "APP_ENV", problem: "must be local or unset for the dev scripts" },
    ]);
  }
  return loadConfig({ name: "the dev scripts", requires: ["MONAD_RPC_URL"] }, source);
}
