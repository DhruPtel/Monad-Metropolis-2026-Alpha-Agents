import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type SkillManifest, validateManifest } from "./manifest.ts";

/**
 * Skill packages on disk (P3-U7, FINAL_PLAN 4.5.2, D-099): a folder with
 * `skill.json` and `SKILL.md`, optional `references/` (Markdown), `data/`
 * (JSON, CSV, YAML), `examples/` and `evals/evals.yaml` (required for a
 * strategy skill). The platform computes the content hash over the exact
 * bytes of every file, generates the Hermes frontmatter (discarding any the
 * publisher wrote), and materializes one folder per skill named with the
 * platform prefix. Imported as `@alpha-agents/skills/packages`, apart from
 * the package's main entry, because it reads files (L-156).
 */
export const HERMES_NAME_PREFIX = "aa-";

export interface PackageFile {
  /** Relative to the package root, with forward slashes. */
  readonly path: string;
  readonly bytes: Buffer;
}

export interface SkillPackage {
  readonly dir: string;
  readonly manifest: SkillManifest;
  readonly files: readonly PackageFile[];
  /** sha256 over every file's path and bytes, in path order: the version's identity. */
  readonly contentHash: string;
  /** sha256 of the canonical manifest JSON. */
  readonly manifestHash: string;
  /** The folder and frontmatter name in the sandbox: the platform prefix and the ID. */
  readonly hermesName: string;
  /** SKILL.md as mounted: generated frontmatter, then the body without any publisher frontmatter. */
  readonly skillMd: string;
}

export interface PackageIssue {
  /** The rule: F1 to F8 format, S1 to S15 static (2.6 of the Bankr platform mapping). */
  readonly rule: string;
  readonly severity: "block" | "warn";
  readonly path: string;
  readonly message: string;
}

const ALLOWED_TOP = new Set(["skill.json", "SKILL.md", "CHANGELOG.md"]);
const ALLOWED_DIRS: Readonly<Record<string, RegExp>> = {
  references: /^[A-Za-z0-9_.-]+\.md$/,
  data: /^[A-Za-z0-9_.-]+\.(json|csv|ya?ml)$/,
  examples: /^[A-Za-z0-9_.-]+\.(md|json|ya?ml)$/,
  evals: /^evals\.ya?ml$/,
};
const LIMITS = {
  skillMdLines: 500,
  skillMdChars: 40_000,
  referenceBytes: 100 * 1024,
  referenceFiles: 40,
  dataBytes: 256 * 1024,
  dataFiles: 20,
  packageBytes: 2 * 1024 * 1024,
};

/** Every file under a folder, refusing what a package may never hold (F2). */
export function readPackageFiles(dir: string): { files: PackageFile[]; issues: PackageIssue[] } {
  const files: PackageFile[] = [];
  const issues: PackageIssue[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      const rel = relative(dir, abs).split(sep).join("/");
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        issues.push({
          rule: "F2",
          severity: "block",
          path: rel,
          message: "a symlink is not allowed",
        });
        continue;
      }
      if (name.startsWith(".")) {
        issues.push({
          rule: "F2",
          severity: "block",
          path: rel,
          message: "a dotfile is not allowed",
        });
        continue;
      }
      if (st.isDirectory()) {
        if (rel.includes("/") || !(name in ALLOWED_DIRS))
          issues.push({
            rule: "F2",
            severity: "block",
            path: rel,
            message: "this folder is not allowed in a skill package",
          });
        else walk(abs);
        continue;
      }
      if ((st.mode & 0o111) !== 0)
        issues.push({
          rule: "F2",
          severity: "block",
          path: rel,
          message: "an executable file is not allowed",
        });
      const [top, file] = rel.includes("/") ? (rel.split("/") as [string, string]) : [null, rel];
      const allowed = top === null ? ALLOWED_TOP.has(file) : ALLOWED_DIRS[top]?.test(file) === true;
      if (!allowed)
        issues.push({
          rule: "F2",
          severity: "block",
          path: rel,
          message: "this file is not allowed in a skill package",
        });
      files.push({ path: rel, bytes: readFileSync(abs) });
    }
  };
  walk(dir);
  return { files, issues };
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** The content hash: sha256 over "path\0sha256(bytes)\n" for every file in path order. */
export function contentHashOf(files: readonly PackageFile[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\0${sha256(f.bytes)}\n`)
    .join("");
  return sha256(lines);
}

/** JSON with sorted keys, so the same manifest always hashes the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/** A double-quoted YAML scalar: backslashes and quotes escaped, never a raw newline. */
export function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

/** Drops any frontmatter the publisher wrote (FINAL_PLAN 4.5.2: publisher frontmatter is discarded). */
export function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end < 0) return md;
  const after = md.indexOf("\n", end + 4);
  return after < 0 ? "" : md.slice(after + 1).replace(/^\n+/, "");
}

/**
 * The frontmatter the platform generates: name (the mounted folder), a
 * double-quoted description, the version, and metadata.hermes tags and
 * related skills. It never emits environment variables, credential files,
 * config, blueprints, deps or shell (D-099).
 */
export function frontmatterFor(m: SkillManifest): string {
  const tags = [m.type, ...(m.synergy_tags ?? [])];
  return [
    "---",
    `name: ${HERMES_NAME_PREFIX}${m.id}`,
    `description: ${yamlQuote(m.description.model)}`,
    `version: ${m.version}`,
    "metadata:",
    "  hermes:",
    `    tags: [${tags.map(yamlQuote).join(", ")}]`,
    `    related_skills: [${(m.dependencies ?? []).map((d) => yamlQuote(`${HERMES_NAME_PREFIX}${d}`)).join(", ")}]`,
    "---",
    "",
  ].join("\n");
}

/** F4: the first 57 characters, all the index shows, stand alone: not empty and not cut mid-word. */
export function standsAlone(description: string): boolean {
  if (description.length <= 57) return description.trim().length > 0;
  const head = description.slice(0, 57);
  const next = description[57] ?? "";
  return head.trim().length > 0 && (/\s/.test(next) || /[\s.!?:;,]$/.test(head));
}

/** Loads and checks one package. Issues include the format rules F1 to F8; the audit adds S1 to S15. */
export function loadPackage(
  dir: string,
  expectedId?: string,
): { pkg: SkillPackage | null; issues: PackageIssue[] } {
  const { files, issues } = readPackageFiles(dir);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const manifestFile = byPath.get("skill.json");
  const skillFile = byPath.get("SKILL.md");
  if (!manifestFile)
    issues.push({
      rule: "F1",
      severity: "block",
      path: "skill.json",
      message: "skill.json is required",
    });
  if (!skillFile)
    issues.push({
      rule: "F1",
      severity: "block",
      path: "SKILL.md",
      message: "SKILL.md is required",
    });
  if (!manifestFile || !skillFile) return { pkg: null, issues };
  let raw: unknown;
  try {
    raw = JSON.parse(manifestFile.bytes.toString("utf8"));
  } catch {
    issues.push({
      rule: "F1",
      severity: "block",
      path: "skill.json",
      message: "skill.json is not valid JSON",
    });
    return { pkg: null, issues };
  }
  const v = validateManifest(raw);
  if (!v.ok) {
    for (const i of v.issues)
      issues.push({
        rule: /tool registry|registry intent|retired/.test(i.message)
          ? "F5"
          : i.path === "privacy"
            ? "F8"
            : "F1",
        severity: "block",
        path: `skill.json:${i.path}`,
        message: i.message,
      });
    return { pkg: null, issues };
  }
  const m = v.manifest;
  const folder = dir.split(/[\\/]/).filter(Boolean).at(-1);
  if (m.id !== (expectedId ?? folder))
    issues.push({
      rule: "F1",
      severity: "block",
      path: "skill.json:id",
      message: `id ${m.id} must equal the folder name`,
    });
  const body = stripFrontmatter(skillFile.bytes.toString("utf8"));
  if (body.split("\n").length > LIMITS.skillMdLines || body.length > LIMITS.skillMdChars)
    issues.push({
      rule: "F3",
      severity: "block",
      path: "SKILL.md",
      message: "SKILL.md is over 500 lines or 40,000 characters",
    });
  const refs = files.filter((f) => f.path.startsWith("references/"));
  const data = files.filter((f) => f.path.startsWith("data/"));
  if (
    refs.length > LIMITS.referenceFiles ||
    refs.some((f) => f.bytes.length > LIMITS.referenceBytes)
  )
    issues.push({
      rule: "F3",
      severity: "block",
      path: "references",
      message: "references are limited to 40 files of 100 KB",
    });
  if (data.length > LIMITS.dataFiles || data.some((f) => f.bytes.length > LIMITS.dataBytes))
    issues.push({
      rule: "F3",
      severity: "block",
      path: "data",
      message: "data is limited to 20 files of 256 KB",
    });
  if (files.reduce((s, f) => s + f.bytes.length, 0) > LIMITS.packageBytes)
    issues.push({ rule: "F3", severity: "block", path: ".", message: "the package is over 2 MB" });
  if (!standsAlone(m.description.model))
    issues.push({
      rule: "F4",
      severity: "block",
      path: "skill.json:description.model",
      message: "the first 57 characters must stand alone",
    });
  if (m.type === "strategy" && !byPath.has("evals/evals.yaml"))
    issues.push({
      rule: "F6",
      severity: "block",
      path: "evals/evals.yaml",
      message: "a strategy skill needs evals/evals.yaml",
    });
  for (const t of m.compatible_templates ?? [])
    if (!byPath.has(t.params))
      issues.push({
        rule: "F6",
        severity: "block",
        path: t.params,
        message: "the template's params file is missing",
      });
  const pkg: SkillPackage = {
    dir,
    manifest: m,
    files,
    contentHash: contentHashOf(files),
    manifestHash: sha256(canonical(m)),
    hermesName: `${HERMES_NAME_PREFIX}${m.id}`,
    skillMd: `${frontmatterFor(m)}${body}`,
  };
  return { pkg, issues };
}
