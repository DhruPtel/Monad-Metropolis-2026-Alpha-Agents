// @ts-check
// Starts the web app (apps/web) with the root .env loaded. Next.js reads .env
// files only from the app's own folder, so without this PRIVY_APP_ID and
// PRIVY_APP_SECRET never reach the app and wallet login shows as not configured.
//   node scripts/web.js dev     (pnpm dev:web)
//   node scripts/web.js start   (serves the last `next build`)
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadRootEnv } from "./lib/config.js";
import { ROOT } from "./lib/paths.js";

const mode = process.argv[2] === "start" ? "start" : "dev";
loadRootEnv();

const cwd = join(ROOT, "apps/web");
const next = join(cwd, "node_modules", "next", "dist", "bin", "next");
// Privy allows only the origins in its dashboard, and localhost and 127.0.0.1
// are different origins; open the address the dashboard lists.
console.log("web app: http://localhost:3000");
const result = spawnSync(process.execPath, [next, mode, "--port", "3000"], {
  cwd,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
