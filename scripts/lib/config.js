// @ts-check
import { existsSync, readFileSync } from "node:fs";
import {
  BASE_MAINNET_CHAIN_ID,
  ConfigError,
  MONAD_MAINNET_CHAIN_ID,
  forkRpcUrl,
  loadConfig,
} from "@alpha-agents/config";
import { parseForkConfig, readForkConfig as readDevenvForkConfig } from "@alpha-agents/devenv";
import {
  BASE_FORK_CONFIG_PATH,
  ENV_PATH,
  FORK_CONFIG_PATH,
  FOUNDRY_VERSION_PATH,
} from "./paths.js";

export { MONAD_MAINNET_CHAIN_ID };
/**
 * M-FAST: which fork the deploy scripts work on. `local` (the default) is the
 * Monad fork; `base` is the Base fork, whose address book, tokens, feeds,
 * pools and Entropy the scripts then use. Set FORK_ENV before importing.
 */
export const FORK_ENV = /** @type {"local" | "base"} */ (
  (() => {
    const raw = process.env.FORK_ENV?.trim() || "local";
    if (raw !== "local" && raw !== "base")
      throw new Error(`FORK_ENV must be local or base, not "${raw}"`);
    return raw;
  })()
);
/** The chain the fork stands for. */
export const FORK_CHAIN = FORK_ENV === "base" ? "base" : "monad";
// forge runs against the Base fork under the base profile (the optimism network family); see foundry.toml.
if (FORK_ENV === "base" && !process.env.FOUNDRY_PROFILE) process.env.FOUNDRY_PROFILE = "base";
/** The fork the scripts use: the playtest fork, a test fork when LOCAL_FORK_PORT says so (D-200), or the Base fork when FORK_ENV=base. */
export const ANVIL_URL = forkRpcUrl(FORK_ENV, process.env);
const anvilUrl = new URL(ANVIL_URL);
export const ANVIL_HOST = anvilUrl.hostname;
export const ANVIL_PORT = Number(anvilUrl.port);

export { MIN_PLAUSIBLE_BLOCK, parseForkConfig } from "@alpha-agents/devenv";

/** The committed fork pin, chains/monad/fork.json, validated by packages/devenv. */
export function readForkConfig() {
  return readDevenvForkConfig(FORK_CONFIG_PATH);
}

/** The Base fork's pin, chains/base/fork.json (M-FAST). */
export function readBaseForkConfig() {
  // Base's head was past 52,500,000 on 2026-10-13; anything far below is a placeholder.
  return parseForkConfig(
    readFileSync(BASE_FORK_CONFIG_PATH, "utf8"),
    BASE_MAINNET_CHAIN_ID,
    50_000_000,
  );
}

/** Base's public endpoint: the fork's upstream and the research reads when BASE_RPC_URL is unset (A-98). */
export const BASE_PUBLIC_RPC_URL = "https://mainnet.base.org";

/** The Base fork's upstream: BASE_RPC_URL from .env, or Base's public endpoint. Never printed. */
export function baseUpstreamUrl() {
  return process.env.BASE_RPC_URL?.trim() || BASE_PUBLIC_RPC_URL;
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
