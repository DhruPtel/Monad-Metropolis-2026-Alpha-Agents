import { validateManifest } from "./manifest.ts";

/**
 * The format rules that need nothing but the files' text (CL-U1): the
 * presence of skill.json and SKILL.md (F1), skill.json as JSON and as a
 * manifest (F1, F5, F8, exactly as `checkPackage` maps the validator's
 * issues), every path (F2) and SKILL.md's size (F3). No hashing, no file
 * system, no registry beyond the manifest schema's own, so the web app runs
 * it in the browser before each round trip to the platform's full check,
 * which stays the one that decides (the audit, the sizes of the other files,
 * the version lock). A finding here is one the platform would give too.
 */
export interface PackageIssue {
  readonly rule: string;
  readonly severity: "block" | "warn";
  readonly path: string;
  readonly message: string;
}

export const ALLOWED_TOP: ReadonlySet<string> = new Set(["skill.json", "SKILL.md", "CHANGELOG.md"]);
export const ALLOWED_DIRS: Readonly<Record<string, RegExp>> = {
  references: /^[A-Za-z0-9_.-]+\.md$/,
  data: /^[A-Za-z0-9_.-]+\.(json|csv|ya?ml)$/,
  examples: /^[A-Za-z0-9_.-]+\.(md|json|ya?ml)$/,
  evals: /^evals\.ya?ml$/,
};
export const SKILL_MD_LIMITS = { lines: 500, chars: 40_000 } as const;

/**
 * F2 for one path, wherever the file came from (a folder on disk or an
 * upload, SK-U1): dotfiles, folders a package may not hold, nesting deeper
 * than one level, and file names outside each folder's allowed kinds.
 */
export function pathIssues(rel: string): PackageIssue[] {
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".."))
    return [{ rule: "F2", severity: "block", path: rel, message: "the path is malformed" }];
  if (parts.some((p) => p.startsWith(".")))
    return [{ rule: "F2", severity: "block", path: rel, message: "a dotfile is not allowed" }];
  if (parts.length > 2)
    return [
      {
        rule: "F2",
        severity: "block",
        path: rel,
        message: "this folder is not allowed in a skill package",
      },
    ];
  const [top, file] = parts.length === 2 ? (parts as [string, string]) : [null, parts[0] ?? ""];
  if (top !== null && !(top in ALLOWED_DIRS))
    return [
      {
        rule: "F2",
        severity: "block",
        path: rel,
        message: "this folder is not allowed in a skill package",
      },
    ];
  const allowed = top === null ? ALLOWED_TOP.has(file) : ALLOWED_DIRS[top]?.test(file) === true;
  return allowed
    ? []
    : [
        {
          rule: "F2",
          severity: "block",
          path: rel,
          message: "this file is not allowed in a skill package",
        },
      ];
}

/** What each rule means and what to do about it, in the owner's words (the page shows these beside the finding). */
export const RULE_WORDS: Readonly<
  Record<string, { readonly means: string; readonly next: string }>
> = {
  F1: {
    means: "The package's shape or its skill.json is not what the format expects.",
    next: "Check skill.json against the format: every required field, an id that is a lowercase slug equal to the folder name, a semantic version, and SKILL.md beside it.",
  },
  F2: {
    means: "A file or folder in the package is not one a skill may hold.",
    next: "Keep skill.json, SKILL.md and CHANGELOG.md at the top, Markdown under references, JSON, CSV or YAML under data, examples under examples, and evals.yaml under evals.",
  },
  F3: {
    means: "The package or one of its files is too large.",
    next: "Keep SKILL.md under 500 lines and 40,000 characters, references under 100 KB each and 40 files, data under 256 KB each and 20 files, and the package under 2 MB.",
  },
  F4: {
    means:
      "The description the model reads does not say in its first 57 characters what the skill is for.",
    next: "Start description.model with a sentence that stands on its own: what the skill does and when to use it.",
  },
  F5: {
    means: "The skill names a tool or an intent the platform does not have.",
    next: "Use only the tool and intent IDs the platform lists; a retired research ID has a replacement in the tool registry.",
  },
  F6: {
    means: "A strategy skill is missing its evals or a template's params file.",
    next: "Add evals/evals.yaml with at least one case, and for a template skill the params file its template needs.",
  },
  F7: {
    means: "The frontmatter in SKILL.md does not match skill.json.",
    next: "Leave the frontmatter out: the platform writes it from skill.json when the package is mounted.",
  },
  F8: {
    means: "The privacy setting does not fit the skill's type.",
    next: "Only a strategy skill can be private; set privacy to public for a protocol or research skill.",
  },
};

export interface QuickFinding extends PackageIssue {
  readonly means: string;
  readonly next: string;
}

/** A finding with the rule's words, as the platform's check reports them. */
export function withWords(issue: PackageIssue): QuickFinding {
  const words = RULE_WORDS[issue.rule] ?? RULE_WORDS.F1;
  return {
    ...issue,
    means: words?.means ?? "",
    next: words?.next ?? "",
  };
}

/** Strips a leading YAML frontmatter block, as the platform does before measuring SKILL.md. */
function withoutFrontmatter(md: string): string {
  if (!md.startsWith("---\n")) return md;
  const end = md.indexOf("\n---", 4);
  return end === -1 ? md : md.slice(end + 4).replace(/^\n/, "");
}

/**
 * The browser-side first pass over a package's files as text. Blocking
 * findings here are certain: the platform's check gives the same ones, so
 * the editor shows them at once and sends nothing until they are fixed.
 */
export function quickFindings(
  files: readonly { readonly path: string; readonly content: string }[],
): QuickFinding[] {
  const issues: PackageIssue[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path))
      issues.push({ rule: "F2", severity: "block", path: f.path, message: "the path is repeated" });
    seen.add(f.path);
    issues.push(...pathIssues(f.path));
  }
  const manifest = files.find((f) => f.path === "skill.json");
  const skillMd = files.find((f) => f.path === "SKILL.md");
  if (!manifest)
    issues.push({
      rule: "F1",
      severity: "block",
      path: "skill.json",
      message: "skill.json is required",
    });
  if (!skillMd)
    issues.push({
      rule: "F1",
      severity: "block",
      path: "SKILL.md",
      message: "SKILL.md is required",
    });
  if (manifest) {
    let raw: unknown;
    let parsed = true;
    try {
      raw = JSON.parse(manifest.content);
    } catch {
      parsed = false;
      issues.push({
        rule: "F1",
        severity: "block",
        path: "skill.json",
        message: "skill.json is not valid JSON",
      });
    }
    if (parsed) {
      const v = validateManifest(raw);
      if (!v.ok)
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
    }
  }
  if (skillMd) {
    const body = withoutFrontmatter(skillMd.content);
    if (body.split("\n").length > SKILL_MD_LIMITS.lines || body.length > SKILL_MD_LIMITS.chars)
      issues.push({
        rule: "F3",
        severity: "block",
        path: "SKILL.md",
        message: "SKILL.md is over 500 lines or 40,000 characters",
      });
  }
  return issues.map(withWords);
}
