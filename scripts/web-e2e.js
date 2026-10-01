// @ts-check
// Runs an app's Playwright tests inside the pinned Playwright image, the same
// image CI uses, so the committed screenshot baselines match.
//
//   node scripts/web-e2e.js [--app web|console] [--update]
//     Builds the app, then runs its screenshot and accessibility tests with no
//     .env (an empty file is mounted over it), exactly as CI does.
//   node scripts/web-e2e.js --app console --live
//     Drives the running console and fork (pnpm dev:all) through the real
//     fork-control and test-fund flows, using the host's network.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./lib/paths.js";

export const PLAYWRIGHT_IMAGE =
  "mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27";

const args = process.argv.slice(2);
const appIndex = args.indexOf("--app");
const app = appIndex >= 0 ? args[appIndex + 1] : "web";
if (app !== "web" && app !== "console") {
  console.error("error: --app must be web or console");
  process.exit(1);
}
const update = args.includes("--update");
const live = args.includes("--live");
if (live && app !== "console") {
  console.error("error: --live applies to the console only");
  process.exit(1);
}

const run = (/** @type {string} */ cmd, /** @type {string[]} */ cmdArgs) =>
  spawnSync(cmd, cmdArgs, { stdio: "inherit", cwd: ROOT }).status ?? 1;

if (!live && run("pnpm", ["--filter", `@alpha-agents/${app}`, "build"]) !== 0) process.exit(1);

const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;
const status = run("docker", [
  "run",
  "--rm",
  "--ipc=host",
  ...(live
    ? ["--network=host", "-e", "LIVE_CONSOLE_URL=http://127.0.0.1:3001"]
    : ["-v", "/dev/null:/work/.env:ro"]),
  "--user",
  `${uid}:${gid}`,
  "-e",
  "HOME=/tmp",
  "-e",
  "CI=1",
  "-v",
  `${ROOT}:/work`,
  "-w",
  `/work/apps/${app}`,
  PLAYWRIGHT_IMAGE,
  "node",
  join("node_modules", "@playwright", "test", "cli.js"),
  "test",
  ...(update ? ["--update-snapshots"] : []),
]);
process.exit(status);
