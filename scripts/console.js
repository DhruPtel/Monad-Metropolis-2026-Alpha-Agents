// @ts-check
// Starts the dev console (apps/console). It refuses unless APP_ENV is local
// (or unset) and always binds to 127.0.0.1; next.config.ts checks APP_ENV
// again, and the console's proxy answers only requests addressed to
// 127.0.0.1 or localhost.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  ConsoleRefusedError,
  assertConsoleEnvironment,
  consoleNextArgs,
} from "@alpha-agents/devenv";
import { loadRootEnv } from "./lib/config.js";
import { ROOT } from "./lib/paths.js";

const mode = process.argv[2] === "start" ? "start" : "dev";
loadRootEnv();
try {
  assertConsoleEnvironment();
} catch (err) {
  if (!(err instanceof ConsoleRefusedError)) throw err;
  console.error(`error: ${err.message}`);
  process.exit(1);
}

const cwd = join(ROOT, "apps/console");
const next = join(cwd, "node_modules", "next", "dist", "bin", "next");
console.log("dev console: http://127.0.0.1:3001 (local only)");
const result = spawnSync(process.execPath, [next, ...consoleNextArgs(mode)], {
  cwd,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
