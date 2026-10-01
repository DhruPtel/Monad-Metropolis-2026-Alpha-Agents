// @ts-check
import { existsSync, readFileSync } from "node:fs";
import { ENV_PATH, FORK_CONFIG_PATH, FOUNDRY_VERSION_PATH } from "./paths.js";

export const MONAD_MAINNET_CHAIN_ID = 143;
export const ANVIL_HOST = "127.0.0.1";
export const ANVIL_PORT = 8545;
export const ANVIL_URL = `http://${ANVIL_HOST}:${ANVIL_PORT}`;

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
  if (typeof blockNumber !== "number" || !Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
    throw new Error("fork.json blockNumber must be a positive integer");
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
 * Classifies MONAD_RPC_URL without ever returning its value.
 * A placeholder copied from .env.example or an empty value counts as unset.
 * @param {string | undefined} value
 * @returns {"ok" | "unset" | "placeholder" | "invalid"}
 */
export function classifyRpcUrl(value) {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return "unset";
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "invalid";
  if (url.hostname.endsWith(".example")) return "placeholder";
  return "ok";
}
