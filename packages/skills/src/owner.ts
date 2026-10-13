import { isAddressEqual } from "viem";
import { RULE_WORDS } from "./quick-check.ts";
import { auditPackage } from "./audit.ts";
import {
  type PackageFile,
  type PackageIssue,
  type SkillPackage,
  loadPackageFiles,
} from "./packages.ts";

/**
 * An owner's own skill (SK-U1, D-368 item 4): a package in the skill format,
 * uploaded for one agent, taken through every format rule (F1 to F8) and
 * every static rule (S1 to S15) the built-in skills pass, and two rules of
 * its own: its id may not be a platform skill's, and its publisher must be
 * the owner's wallet (F7: the owner's session stands in for the signature
 * until P6-U3's signing exists). Nothing here reads disk or network.
 */
export interface UploadedFile {
  /** Relative to the package root, forward slashes. */
  readonly path: string;
  /** The file's text, UTF-8: every file a package may hold is text. */
  readonly content: string;
}

export interface OwnerSkillCheck {
  /** The package when every blocking rule passed, else null. */
  readonly pkg: SkillPackage | null;
  /** Every finding, blocking first, each with its rule, path and message. */
  readonly issues: readonly PackageIssue[];
  readonly blocked: boolean;
}

/** The most an upload may carry, in files and bytes, before any rule runs (F3 is 2 MB). */
export const UPLOAD_LIMITS = { files: 80, bytes: 3 * 1024 * 1024 };

/**
 * Drops a shared root folder (a folder picker gives "my-skill/skill.json"),
 * so the package's paths start at skill.json. Paths without a shared root
 * are left as they are.
 */
export function stripSharedRoot(files: readonly UploadedFile[]): UploadedFile[] {
  if (files.length === 0) return [];
  const roots = new Set(files.map((f) => f.path.split("/")[0] ?? ""));
  const topLevel = files.some((f) => !f.path.includes("/"));
  if (topLevel || roots.size !== 1) return [...files];
  return files.map((f) => ({ ...f, path: f.path.slice(f.path.indexOf("/") + 1) }));
}

/**
 * Checks an owner's upload: the files' shape, the format rules, the static
 * audit, and the owner's own rules. Findings carry the rule so the page can
 * say what each means and what to do next (`RULE_WORDS`).
 */
export function checkOwnerSkill(
  upload: readonly UploadedFile[],
  o: { readonly reservedIds: readonly string[]; readonly owner: `0x${string}` },
): OwnerSkillCheck {
  const issues: PackageIssue[] = [];
  if (upload.length === 0)
    issues.push({
      rule: "F1",
      severity: "block",
      path: ".",
      message: "no files were given; a package holds skill.json and SKILL.md at least",
    });
  if (upload.length > UPLOAD_LIMITS.files)
    issues.push({
      rule: "F3",
      severity: "block",
      path: ".",
      message: `an upload holds at most ${UPLOAD_LIMITS.files} files`,
    });
  const bytes = upload.reduce((s, f) => s + Buffer.byteLength(f.content, "utf8"), 0);
  if (bytes > UPLOAD_LIMITS.bytes)
    issues.push({
      rule: "F3",
      severity: "block",
      path: ".",
      message: "the package is over 2 MB",
    });
  if (issues.length > 0) return { pkg: null, issues, blocked: true };
  const files: PackageFile[] = stripSharedRoot(upload).map((f) => ({
    path: f.path,
    bytes: Buffer.from(f.content, "utf8"),
  }));
  const loaded = loadPackageFiles(files);
  issues.push(...loaded.issues);
  const pkg = loaded.pkg;
  if (pkg) {
    if (o.reservedIds.includes(pkg.manifest.id))
      issues.push({
        rule: "F1",
        severity: "block",
        path: "skill.json:id",
        message: `${pkg.manifest.id} is a platform skill's id; choose another`,
      });
    if (!isAddressEqual(pkg.manifest.publisher.address, o.owner))
      issues.push({
        rule: "F7",
        severity: "block",
        path: "skill.json:publisher.address",
        message: `publisher.address must be your wallet, ${o.owner}`,
      });
    issues.push(...auditPackage(pkg));
  }
  const sorted = [...issues].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "block" ? -1 : 1,
  );
  const blocked = sorted.some((i) => i.severity === "block");
  return { pkg: blocked ? null : pkg, issues: sorted, blocked };
}

export { RULE_WORDS } from "./quick-check.ts";

/** The words for a rule the table does not know (never expected): the rule's own message stands. */
export function ruleWords(rule: string): { means: string; next: string } {
  return (
    RULE_WORDS[rule] ?? {
      means: "A rule of the skill format was not met.",
      next: "Read the finding and change the package accordingly.",
    }
  );
}
