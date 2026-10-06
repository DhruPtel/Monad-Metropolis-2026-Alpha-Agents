// @ts-check
// Runs an app's Playwright tests inside the pinned Playwright image, the same
// image CI uses, so the committed screenshot baselines match.
//
//   node scripts/web-e2e.js [--app web|console] [--update]
//     Builds the app, then runs its screenshot and accessibility tests with no
//     .env (an empty file is mounted over it), exactly as CI does.
//   node scripts/web-e2e.js --app console --live
//   node scripts/web-e2e.js --app web --live   (pnpm test:web:live: mint through the API, reveal and view, on a test stack of its own)
//   node scripts/web-e2e.js --app web --live --agents   (pnpm test:web:live:agents: My Agents with the orchestrator, real E2B, Tavily and a model)
//     Drives the running console and fork (pnpm dev:all) through the real
//     fork-control and test-fund flows. This runs on the host, not in the
//     image: Docker Desktop on WSL2 does not share the distro's loopback with
//     --network=host, and the live tests take no screenshots, so the host's
//     Chromium is enough (install it once with the command in the README).
import { spawn, spawnSync } from "node:child_process";
import { LOCAL_TEST_FORK_PORT } from "@alpha-agents/config";
import { join } from "node:path";
import { ROOT } from "./lib/paths.js";

export const PLAYWRIGHT_IMAGE =
  "mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27";

/** The My Agents live run's orchestrator port, beside the development one on 4200. */
const LIVE_ORCHESTRATOR_PORT = 4252;
/** The live suite's control API port, beside the development API on 4100. */
const LIVE_API_PORT = 4101;

const args = process.argv.slice(2);
const appIndex = args.indexOf("--app");
const app = appIndex >= 0 ? args[appIndex + 1] : "web";
if (app !== "web" && app !== "console") {
  console.error("error: --app must be web or console");
  process.exit(1);
}
const update = args.includes("--update");
const live = args.includes("--live");
// P1-U9: the My Agents live run, on the same kind of stack plus the orchestrator.
const agents = args.includes("--agents");

const run = (
  /** @type {string} */ cmd,
  /** @type {string[]} */ cmdArgs,
  /** @type {{ cwd?: string, env?: NodeJS.ProcessEnv }} */ options = {},
) => spawnSync(cmd, cmdArgs, { stdio: "inherit", cwd: ROOT, ...options }).status ?? 1;

const playwrightCli = join("node_modules", "@playwright", "test", "cli.js");

if (live && app === "console") {
  process.exit(
    run("node", [playwrightCli, "test"], {
      cwd: join(ROOT, "apps", app),
      env: { ...process.env, LIVE_CONSOLE_URL: "http://127.0.0.1:3001" },
    }),
  );
}

// The web app's live test (P1-U11, P1-U4) runs on the host, where it can reach
// the fork (L-13), against a test stack of its own (D-200): an anvil fork on
// 8546, a throwaway database, the real indexer and control API on 4101. The
// test build is pointed at them; the playtest fork and the development
// database are never touched.
if (live && app === "web") {
  process.env.LOCAL_FORK_PORT = String(LOCAL_TEST_FORK_PORT);
  process.env.CONTROL_API_URL = `http://127.0.0.1:${LIVE_API_PORT}`;
  if (run("node", [join("scripts", "check-web-build.js")]) !== 0) process.exit(1);
  const { loadRootEnv } = await import("./lib/config.js");
  loadRootEnv();
  const { startTestStack } = await import("./lib/test-stack.js");
  console.log(
    `starting the live test stack: fork on ${LOCAL_TEST_FORK_PORT}, API on ${LIVE_API_PORT}`,
  );
  const stack = await startTestStack({
    forkPort: LOCAL_TEST_FORK_PORT,
    apiPort: LIVE_API_PORT,
    ...(agents
      ? {
          orchestrator: {
            port: LIVE_ORCHESTRATOR_PORT,
            namespace: `live-web-${Math.random().toString(16).slice(2, 8)}`,
          },
        }
      : {}),
  });
  let status;
  try {
    // Asynchronous, so the stack's piped logs keep flowing while the tests run.
    const child = spawn("node", [playwrightCli, "test"], {
      stdio: "inherit",
      cwd: join(ROOT, "apps", app),
      env: {
        ...process.env,
        LIVE_WEB: "1",
        LIVE_SPEC: agents ? "my-agents.live.spec.ts" : "live.spec.ts",
        TEST_DATABASE_URL: stack.databaseUrl,
      },
    });
    status = await new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
  } finally {
    await stack.stop();
  }
  process.exit(status ?? 1);
}

// The web app is built twice, real and test (mock wallet), and both are checked;
// Playwright then serves the test build (P1-U2).
const buildStatus =
  app === "web"
    ? run("node", [join("scripts", "check-web-build.js")])
    : run("pnpm", ["--filter", `@alpha-agents/${app}`, "build"]);
if (buildStatus !== 0) process.exit(1);

const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;
const status = run("docker", [
  "run",
  "--rm",
  "--ipc=host",
  "-v",
  "/dev/null:/work/.env:ro",
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
  playwrightCli,
  "test",
  ...(update ? ["--update-snapshots"] : []),
]);
process.exit(status);
