// @ts-check
// Builds the web app, then runs its Playwright screenshot and accessibility
// tests inside the pinned Playwright image, the same image CI uses, so the
// committed baselines match. Pass --update to rewrite the baselines.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./lib/paths.js";

export const PLAYWRIGHT_IMAGE =
  "mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27";

const update = process.argv.includes("--update");
const run = (/** @type {string} */ cmd, /** @type {string[]} */ args) =>
  spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT }).status ?? 1;

if (run("pnpm", ["--filter", "@alpha-agents/web", "build"]) !== 0) process.exit(1);

const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;
const status = run("docker", [
  "run",
  "--rm",
  "--ipc=host",
  "--user",
  `${uid}:${gid}`,
  "-e",
  "HOME=/tmp",
  "-e",
  "CI=1",
  "-v",
  `${ROOT}:/work`,
  "-w",
  "/work/apps/web",
  PLAYWRIGHT_IMAGE,
  "node",
  join("node_modules", "@playwright", "test", "cli.js"),
  "test",
  ...(update ? ["--update-snapshots"] : []),
]);
process.exit(status);
