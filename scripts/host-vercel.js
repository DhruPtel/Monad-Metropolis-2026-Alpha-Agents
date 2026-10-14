// @ts-check
// pnpm host:vercel (HOST-U1): deploys apps/web to Vercel for the testnet
// environment, pointed at the public API URL the host tunnel printed. The
// project's root directory is apps/web and the build runs here from the
// repo root (a pnpm workspace builds from the repo, which Vercel's remote
// build of one folder cannot); only its output is uploaded. Only
// public values reach the build: APP_ENV, CONTROL_API_URL and PRIVY_APP_ID;
// no secret is passed (the control API keeps PRIVY_APP_SECRET, the claim
// signer and every key), and scripts/check-web-build.js is the proof that a
// web build never carries one. Needs a Vercel login (`npx vercel login`,
// once, in your own terminal); the project is linked on the first run.
//
//   pnpm host:vercel              production, with the tunnel's current URL
//   pnpm host:vercel --preview    a preview deployment instead
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEV_DIR, ROOT } from "./lib/paths.js";
import { loadRootEnv } from "./lib/config.js";

const PROJECT = process.env.HOST_VERCEL_PROJECT?.trim() || "vivarium-testnet";
loadRootEnv();
const preview = process.argv.includes("--preview");
const state = existsSync(join(DEV_DIR, "host.json"))
  ? /** @type {{ url?: string | null }} */ (
      JSON.parse(readFileSync(join(DEV_DIR, "host.json"), "utf8"))
    )
  : null;
const apiUrl = process.env.HOST_API_URL?.trim() || state?.url || null;
const privyAppId = process.env.PRIVY_APP_ID?.trim() || "";

if (!apiUrl) {
  console.error(
    "error: no public API URL; start the tunnel first with pnpm host:up (or set HOST_API_URL)",
  );
  process.exit(1);
}
if (!/^https:\/\//.test(apiUrl)) {
  console.error("error: the public API URL must be https");
  process.exit(1);
}
if (privyAppId.length !== 25) {
  console.error(
    "error: PRIVY_APP_ID (25 characters, public) must be set in .env for the web build",
  );
  process.exit(1);
}

/** Only the public values the web build and its server reads take; nothing else of the environment. */
const PUBLIC_ENV = {
  APP_ENV: "testnet",
  CONTROL_API_URL: apiUrl,
  PRIVY_APP_ID: privyAppId,
  // 2026-10-14: the browser calls the site's own /api/*, forwarded to CONTROL_API_URL, so a
  // network that filters the API's host still reaches it (apps/web/dev-api-proxy.ts).
  WEB_API_PROXY: "1",
  // CO-U1: the testnet this site's build runs on (monad, base-sepolia or arbitrum-sepolia).
  TESTNET_CHAIN: process.env.TESTNET_CHAIN?.trim() || "monad",
};
const base = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  VERCEL_TELEMETRY_DISABLED: "1",
  ...(process.env.VERCEL_TOKEN ? { VERCEL_TOKEN: process.env.VERCEL_TOKEN } : {}),
};
const vercel = (/** @type {string[]} */ args, { quiet = false, input = "" } = {}) =>
  spawnSync("npx", ["-y", "vercel@latest", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: quiet ? "pipe" : ["pipe", "inherit", "inherit"],
    input,
    env: { ...base, ...PUBLIC_ENV },
  });

const who = vercel(["whoami"], { quiet: true });
if (who.status !== 0) {
  console.log("Vercel is not logged in on this machine. Run this in your own terminal, once:");
  console.log("  npx vercel login");
  console.log("Then deploy with the tunnel's URL:");
  console.log("  pnpm host:vercel");
  console.log(
    `The build gets APP_ENV=testnet, CONTROL_API_URL=${apiUrl} and PRIVY_APP_ID (public), nothing else.`,
  );
  process.exit(1);
}
console.log(`Vercel: logged in as ${(who.stdout ?? "").trim()}`);
if (!existsSync(join(ROOT, ".vercel", "project.json"))) {
  const linked = vercel(["link", "--yes", "--project", PROJECT]);
  if (linked.status !== 0) {
    console.error(`error: could not link the Vercel project ${PROJECT}`);
    process.exit(linked.status ?? 1);
  }
}
// The server's runtime values (the Privy app id and the environment are read per request).
const target = preview ? "preview" : "production";
for (const [name, value] of Object.entries(PUBLIC_ENV)) {
  vercel(["env", "rm", name, target, "--yes"], { quiet: true });
  const added = vercel(["env", "add", name, target], { quiet: true, input: `${value}\n` });
  if (added.status !== 0) {
    console.error(
      `error: could not set ${name} on Vercel: ${(added.stderr ?? "").trim().split("\n")[0]}`,
    );
    process.exit(added.status ?? 1);
  }
}
console.log(`Vercel: APP_ENV, CONTROL_API_URL, PRIVY_APP_ID, WEB_API_PROXY and TESTNET_CHAIN set for ${target}`);
const built = vercel(["build", ...(preview ? [] : ["--prod"]), "--yes"]);
if (built.status !== 0) {
  console.error("error: the build failed; see the output above");
  process.exit(built.status ?? 1);
}
const result = vercel(["deploy", "--prebuilt", ...(preview ? [] : ["--prod"]), "--yes"], {
  quiet: true,
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.status !== 0) {
  console.error("error: the deployment failed; see Vercel's output above");
  process.exit(result.status ?? 1);
}
// The deployment's origins join the guard's CORS list (read live by pnpm host:up).
const origins = new Set(
  (
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/https:\/\/[a-z0-9.-]+\.vercel\.app/g) ??
    []
  ).map((o) => o.toLowerCase()),
);
origins.add(`https://${PROJECT}.vercel.app`);
const originsPath = join(DEV_DIR, "host-origins.json");
/** @type {string[]} */
const known = (() => {
  try {
    const parsed = /** @type {{ origins?: unknown }} */ (
      JSON.parse(readFileSync(originsPath, "utf8"))
    );
    return Array.isArray(parsed.origins) ? parsed.origins.filter((o) => typeof o === "string") : [];
  } catch {
    return [];
  }
})();
writeFileSync(
  originsPath,
  `${JSON.stringify({ origins: [...new Set([...known, ...origins])] }, null, 2)}\n`,
);
console.log(`Vercel: ${[...origins].join(", ")} allowed by the guard's CORS from now on.`);
console.log(
  "Deployed. Next: add https://" +
    PROJECT +
    ".vercel.app to Privy's allowed origins (the Privy dashboard, your app, Settings, Allowed origins); the guard already allows it.",
);
