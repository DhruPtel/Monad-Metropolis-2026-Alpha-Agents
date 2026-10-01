// @ts-check
// Scans for secrets with gitleaks, pinned by image digest: the full git history
// of every ref, plus any uncommitted changes to tracked files. .env and other
// gitignored files are never read. Findings are printed with secrets redacted.
// Run before every push; CI runs the same scan.
import { spawnSync } from "node:child_process";
import { ROOT } from "./lib/paths.js";

const IMAGE =
  "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f";

const scans = [
  { name: "full git history", args: ["git", "--log-opts=--all"] },
  { name: "uncommitted changes", args: ["git", "--pre-commit"] },
  { name: "staged changes", args: ["git", "--staged"] },
];

let failed = false;
for (const scan of scans) {
  console.log(`secrets scan: ${scan.name}`);
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${ROOT}:/repo:ro`,
      "-w",
      "/repo",
      IMAGE,
      ...scan.args,
      "--config=.gitleaks.toml",
      "--gitleaks-ignore-path=.gitleaksignore",
      "--redact",
      "--no-banner",
      "--verbose",
      ".",
    ],
    { stdio: "inherit" },
  );
  if (result.error) {
    console.error("error: docker not found; the scan runs gitleaks in Docker");
    process.exit(1);
  }
  if (result.status !== 0) failed = true;
}

console.log(failed ? "\nSecrets scan FAILED. Do not push." : "\nSecrets scan passed.");
process.exit(failed ? 1 : 0);
