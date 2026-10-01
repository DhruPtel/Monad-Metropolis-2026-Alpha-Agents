// @ts-check
import { existsSync, readFileSync } from "node:fs";
import {
  ConfigError,
  LOCAL_FORK_RPC_URL,
  MONAD_MAINNET_CHAIN_ID,
  loadConfig,
} from "@alpha-agents/config";
import { ENV_PATH, FORK_CONFIG_PATH, FOUNDRY_VERSION_PATH } from "./paths.js";

export { MONAD_MAINNET_CHAIN_ID };
export const ANVIL_URL = LOCAL_FORK_RPC_URL;
const anvilUrl = new URL(ANVIL_URL);
export const ANVIL_HOST = anvilUrl.hostname;
export const ANVIL_PORT = Number(anvilUrl.port);

/**
 * Monad mainnet passed this height before P0-U2 (October 2026). A pin below it is
 * a placeholder or a typo. Same floor as ForkConfigTest in chains/monad.
 */
export const MIN_PLAUSIBLE_BLOCK = 100_000_000;

/**
 * @typedef {{ chainId: number, blockNumber: number }} ForkConfig
 */

/**
 * Parses and validates the committed fork pin.
 * @param {string} text
 * @returns {ForkConfig}
 */
export function parseForkConfig(text) {
  /** @type {unknown} */
  const data = JSON.parse(text);
  if (typeof data !== "object" || data === null) {
    throw new Error("fork.json must be a JSON object");
  }
  const { chainId, blockNumber } = /** @type {Record<string, unknown>} */ (data);
  if (chainId !== MONAD_MAINNET_CHAIN_ID) {
    throw new Error(`fork.json chainId must be ${MONAD_MAINNET_CHAIN_ID}`);
  }
  if (typeof blockNumber !== "number" || !Number.isSafeInteger(blockNumber)) {
    throw new Error("fork.json blockNumber must be an integer");
  }
  if (blockNumber < MIN_PLAUSIBLE_BLOCK) {
    throw new Error(
      `fork.json blockNumber is below ${MIN_PLAUSIBLE_BLOCK}; it looks like a placeholder`,
    );
  }
  return { chainId, blockNumber };
}

/** @returns {ForkConfig} */
export function readForkConfig() {
  return parseForkConfig(readFileSync(FORK_CONFIG_PATH, "utf8"));
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
