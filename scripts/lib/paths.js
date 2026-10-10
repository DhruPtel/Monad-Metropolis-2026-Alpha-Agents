// @ts-check
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MONAD_DIR = join(ROOT, "chains/monad");
export const FORK_CONFIG_PATH = join(MONAD_DIR, "fork.json");
export const FOUNDRY_VERSION_PATH = join(ROOT, ".foundry-version");
export const NVMRC_PATH = join(ROOT, ".nvmrc");
export const COMPOSE_FILE = join(ROOT, "infra/compose.yaml");
export const ENV_PATH = join(ROOT, ".env");
export const DEV_DIR = join(ROOT, ".dev");
export const ANVIL_PID_PATH = join(DEV_DIR, "anvil.pid");
export const ANVIL_LOG_PATH = join(DEV_DIR, "anvil.log");
/** The fork's state as anvil saves it every minute and on exit, and loads on the next start (D-364). */
export const ANVIL_STATE_PATH = join(DEV_DIR, "anvil-state.json");
