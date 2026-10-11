// @ts-check
// Points git at the repository's versioned hooks (F-T1): `pnpm prepare` runs
// this after install, so every clone gets the commit gate in
// .githooks/pre-commit. Outside a git checkout (CI archives, Docker builds)
// it does nothing.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/paths.js";

if (!existsSync(join(ROOT, ".git"))) process.exit(0);
const r = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
  cwd: ROOT,
  stdio: "inherit",
});
process.exit(r.status ?? 1);
