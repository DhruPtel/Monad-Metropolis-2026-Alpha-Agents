// @ts-check
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MONAD_DIR = join(ROOT, "chains/monad");
export const FORK_CONFIG_PATH = join(MONAD_DIR, "fork.json");
/** The owner's playtest wallets, re-added to every deposit allowlist by every local deploy (Step 0, 2026-10-12). */
export const LOCAL_WALLETS_PATH = join(MONAD_DIR, "local-wallets.json");
export const FOUNDRY_VERSION_PATH = join(ROOT, ".foundry-version");
export const NVMRC_PATH = join(ROOT, ".nvmrc");
export const COMPOSE_FILE = join(ROOT, "infra/compose.yaml");
export const ENV_PATH = join(ROOT, ".env");
export const DEV_DIR = join(ROOT, ".dev");
export const ANVIL_PID_PATH = join(DEV_DIR, "anvil.pid");
export const ANVIL_LOG_PATH = join(DEV_DIR, "anvil.log");
/** The fork's state as anvil saves it every minute and on exit, and loads on the next start (D-364). */
export const ANVIL_STATE_PATH = join(DEV_DIR, "anvil-state.json");

/** M-FAST: the Base fork beside the playtest fork, with its own pin, log, pid and saved state. */
export const BASE_DIR = join(ROOT, "chains/base");
export const BASE_FORK_CONFIG_PATH = join(BASE_DIR, "fork.json");
export const BASE_ANVIL_PID_PATH = join(DEV_DIR, "base-anvil.pid");
export const BASE_ANVIL_LOG_PATH = join(DEV_DIR, "base-anvil.log");
export const BASE_ANVIL_STATE_PATH = join(DEV_DIR, "base-anvil-state.json");
