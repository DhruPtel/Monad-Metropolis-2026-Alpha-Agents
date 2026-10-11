// @ts-check
// The commit gate, run by .githooks/pre-commit on every commit (F-T1): the
// secrets scan over the staged changes and the history, through
// scripts/secrets-scan.js, with its exit code carried through untouched. A
// failing scan ends the commit; nothing is printed that the scan did not
// already redact.
import { spawnSync } from "node:child_process";
import { ROOT } from "./lib/paths.js";

const scan = spawnSync("node", ["scripts/secrets-scan.js"], { cwd: ROOT, stdio: "inherit" });
if (scan.error) {
  console.error(`commit gate: the secrets scan could not run (${scan.error.message})`);
  process.exit(1);
}
if (scan.status !== 0) {
  console.error(
    "\ncommit gate: the secrets scan failed, so the commit is refused. Fix the finding, or record a checked false positive by fingerprint in .gitleaksignore with its reason, then commit again.",
  );
  process.exit(scan.status ?? 1);
}
console.log("commit gate: passed");
