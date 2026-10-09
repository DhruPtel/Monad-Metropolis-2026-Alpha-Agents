import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { auditPackage } from "./audit.ts";
import { type PackageIssue, type SkillPackage, loadPackage } from "./packages.ts";

/**
 * The built-in set (P3-U7, D-106, D-288): the launch skills under
 * `builtin/skills` and the platform's stage playbooks under
 * `builtin/playbooks`, mounted read-only into every agent's sandbox, the
 * same set for every agent until builds exist (P6-U6). A published version is
 * immutable: `builtin/versions.json` records each version's content hash, and
 * a package whose bytes changed without a new version fails.
 */
export type BuiltinKind = "skill" | "playbook";

export interface BuiltinPackage extends SkillPackage {
  readonly kind: BuiltinKind;
}

export interface BuiltinSet {
  readonly packages: readonly BuiltinPackage[];
  /** sha256 over every package's ID, version and content hash: the set's identity. */
  readonly setHash: string;
  readonly issues: readonly (PackageIssue & { readonly id: string })[];
}

export const BUILTIN_ROOT = new URL("../builtin/", import.meta.url);
const LOCK = new URL("versions.json", BUILTIN_ROOT);

export type VersionLock = Record<
  string,
  { readonly version: string; readonly contentHash: string }
>;

export function readVersionLock(): VersionLock {
  return (JSON.parse(readFileSync(LOCK, "utf8")) as { versions: VersionLock }).versions;
}

/** F1's immutability: a version already recorded with a different hash is refused. */
export function versionIssues(
  pkgs: readonly SkillPackage[],
  lock: VersionLock,
): (PackageIssue & { id: string })[] {
  const out: (PackageIssue & { id: string })[] = [];
  for (const p of pkgs) {
    const was = lock[p.manifest.id];
    if (was && was.version === p.manifest.version && was.contentHash !== p.contentHash)
      out.push({
        id: p.manifest.id,
        rule: "F1",
        severity: "block",
        path: "skill.json:version",
        message: `version ${p.manifest.version} is already published with another content hash; bump the version`,
      });
    if (!was)
      out.push({
        id: p.manifest.id,
        rule: "F1",
        severity: "block",
        path: "skill.json:version",
        message: "this package is not in builtin/versions.json; run pnpm skills:lock",
      });
  }
  return out;
}

/** Loads, validates and audits every built-in package. */
export function loadBuiltinSet(
  root: URL = BUILTIN_ROOT,
  lock: VersionLock | null = null,
): BuiltinSet {
  const packages: BuiltinPackage[] = [];
  const issues: (PackageIssue & { id: string })[] = [];
  for (const [kind, sub] of [
    ["skill", "skills"],
    ["playbook", "playbooks"],
  ] as const) {
    const dir = new URL(`${sub}/`, root);
    for (const id of readdirSync(dir).sort()) {
      const { pkg, issues: found } = loadPackage(new URL(`${id}/`, dir).pathname, id);
      issues.push(...found.map((i) => ({ ...i, id })));
      if (!pkg) continue;
      issues.push(...auditPackage(pkg).map((i) => ({ ...i, id })));
      packages.push({ ...pkg, kind });
    }
  }
  issues.push(...versionIssues(packages, lock ?? readVersionLock()));
  const setHash = createHash("sha256")
    .update(
      packages.map((p) => `${p.manifest.id}@${p.manifest.version}:${p.contentHash}`).join("\n"),
    )
    .digest("hex");
  return { packages, setHash, issues };
}
