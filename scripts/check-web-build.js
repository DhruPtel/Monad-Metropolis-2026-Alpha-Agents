// @ts-check
// Builds apps/web twice and checks what each build contains (P1-U2):
// 1. The real build (.next), made with a throwaway PRIVY_APP_SECRET, must not
//    contain that secret anywhere, nor the mock wallet's marker.
// 2. The test build (.next-e2e, ALPHA_E2E_MOCK_WALLET=1) must contain the mock
//    wallet, so the Playwright tests really run against it.
// Used by `pnpm test:web:e2e` (scripts/web-e2e.js) and the CI web job.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/paths.js";

const WEB = join(ROOT, "apps", "web");
const MOCK_MARKER = "alpha-agents-mock-wallet-e2e-only";

/** @param {Record<string, string | undefined>} env */
function build(env) {
  const result = spawnSync("pnpm", ["--filter", "@alpha-agents/web", "build"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/**
 * Every file under dir whose text contains needle. The cache holds build
 * inputs, not output, so it is skipped.
 * @param {string} dir @param {string} needle @returns {string[]}
 */
function filesContaining(dir, needle) {
  /** @type {string[]} */
  const hits = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === "cache") continue;
    if (statSync(path).isDirectory()) hits.push(...filesContaining(path, needle));
    else if (readFileSync(path).includes(needle)) hits.push(path.slice(WEB.length + 1));
  }
  return hits;
}

const secret = `check-${randomBytes(16).toString("hex")}`;
let failed = false;
/** @param {string} what @param {string[]} hits @param {boolean} expected */
function report(what, hits, expected) {
  const ok = expected ? hits.length > 0 : hits.length === 0;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${what}${ok ? "" : `: ${hits.slice(0, 5).join(", ") || "not found"}`}`,
  );
  if (!ok) failed = true;
}

console.log("building the real web app (.next)");
build({
  ALPHA_E2E_MOCK_WALLET: "",
  PRIVY_APP_ID: "checkbuild000000000000000",
  PRIVY_APP_SECRET: secret,
});
report(
  "the Privy app secret is nowhere in the real build",
  filesContaining(join(WEB, ".next"), secret),
  false,
);
report(
  "the mock wallet is not in the real build",
  filesContaining(join(WEB, ".next"), MOCK_MARKER),
  false,
);

console.log("building the test web app (.next-e2e, mock wallet)");
build({ ALPHA_E2E_MOCK_WALLET: "1", PRIVY_APP_SECRET: secret });
report(
  "the test build contains the mock wallet",
  filesContaining(join(WEB, ".next-e2e"), MOCK_MARKER),
  true,
);
report(
  "the Privy app secret is nowhere in the test build",
  filesContaining(join(WEB, ".next-e2e"), secret),
  false,
);

process.exit(failed ? 1 : 0);
