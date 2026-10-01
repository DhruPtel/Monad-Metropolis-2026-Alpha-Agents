// @ts-check
// Runs the fork smoke tests against the local anvil fork started by `pnpm dev:up`.
// Forge does not read the root .env, and the fork tests skip themselves when
// MONAD_RPC_URL is unset, so this loads .env and refuses to run instead of
// letting a skipped suite look like a pass.
import { spawnSync } from "node:child_process";
import { classifyRpcUrl, loadRootEnv } from "./lib/config.js";
import { MONAD_DIR } from "./lib/paths.js";

loadRootEnv();
if (classifyRpcUrl(process.env.MONAD_RPC_URL) !== "ok") {
  console.error("error: MONAD_RPC_URL is not set in .env. Run pnpm run doctor for details.");
  process.exit(1);
}
const result = spawnSync("forge", ["test", "--match-path", "test/fork/**", "-vv"], {
  cwd: MONAD_DIR,
  stdio: "inherit",
  env: process.env,
});
if (result.error) console.error("error: forge not found on PATH");
process.exit(result.status ?? 1);
