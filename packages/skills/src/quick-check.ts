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
    next: "Check skill.json against the format: every required field, an id that is a lowercase slug, a semver version; keep the same id and bump the version when the content changes.",
  },
  F2: {
    means: "A file or folder in the package is not one a skill may hold.",
    next: "Keep skill.json, SKILL.md and CHANGELOG.md at the top, Markdown under references/, JSON, CSV or YAML under data/, examples/ and evals/evals.yaml; remove dotfiles, scripts, executables and anything else.",
  },
  F3: {
    means: "The package or one of its files is too large.",
    next: "Keep SKILL.md under 500 lines and 40,000 characters, references under 40 files of 100 KB, data under 20 files of 256 KB, and the whole package under 2 MB.",
  },
  F4: {
    means:
      "The model sees only the first 57 characters of the description, and they do not stand alone.",
    next: 'Rewrite description.model so its first 57 characters end at a word, in the form "Does X. Use when Y."',
  },
  F5: {
    means: "The skill names a tool or an intent the platform does not have.",
    next: "Use only registry tool IDs with a major version, such as data.web_search@1, and registry intents; drop retired research IDs.",
  },
  F6: {
    means: "A strategy skill is missing its evals or a template's params file.",
    next: "Add evals/evals.yaml and the params file each compatible template names, or make the skill a research or protocol skill.",
  },
  F7: {
    means: "The package's publisher is not you.",
    next: "Set publisher.address in skill.json to the wallet you are signed in with; publisher.id and key_id are yours to choose.",
  },
  F8: {
    means: "A private skill must be a strategy skill.",
    next: 'Set privacy to "public", or make the skill a strategy skill with its evals.',
  },
  S1: {
    means: "The text asks for shell or code to run; a skill is text and declarations, never code.",
    next: "Remove shell blocks, commands and code execution; describe what the agent should do with the platform's tools instead.",
  },
  S2: {
    means: "The text asks to install something; nothing is installed in an agent's sandbox.",
    next: "Remove install steps (npm, pip, brew, skills add, MCP servers); the platform's tools are already there.",
  },
  S3: {
    means: "The text loads instructions from the network at run time, which no skill may do.",
    next: "Put the instructions in the package itself; drop links to Markdown, llms.txt, raw repositories and re-fetching.",
  },
  S4: {
    means: "The text mentions credentials or secrets; a skill never holds or asks for them.",
    next: "Remove every key, mnemonic, token or password and anything that asks the agent for one.",
  },
  S5: {
    means: "The text names an endpoint the skill did not declare.",
    next: "Use the declared data sources and the platform's tools; remove undeclared URLs and hosts.",
  },
  S6: {
    means: "The text asks the agent to sign or send on its own.",
    next: "Trades go through typed intents the Executor checks; remove signing, raw transactions and calldata.",
  },
  S7: {
    means: "The text asks for an unlimited approval or a delegation.",
    next: "Remove approvals, allowances and delegations; the account's contracts set what may move.",
  },
  S8: {
    means:
      "The text schedules work or keeps state across runs, which belongs to a workflow, not a skill.",
    next: "Remove cron, timers, loops that wait, and files meant to persist between runs.",
  },
  S9: {
    means: "The text tries to get around the owner's approval or the hard limits.",
    next: "Remove anything that skips approval, raises caps or tells the agent to ignore a refusal.",
  },
  S10: {
    means: "The text hides its own instructions or asks the agent to conceal what it does.",
    next: "Say plainly what the skill does; remove instructions to hide, obfuscate or keep from the owner.",
  },
  S11: {
    means: "The text contains an override phrase that tries to replace the agent's instructions.",
    next: 'Remove phrases such as "ignore previous instructions" and "you are now"; a skill adds knowledge, it does not take over.',
  },
  S12: {
    means: "The text has hidden content: invisible characters, HTML comments or zero-width marks.",
    next: "Remove comments, zero-width and control characters; everything in a skill is meant to be read.",
  },
  S13: {
    means:
      "An address in the text is not in the platform's address book, so it may be an impostor.",
    next: "Use the registered token and contract addresses from the address book, or name the token by symbol and let the tools resolve it.",
  },
  S14: {
    means: "The text asks the agent to change itself, its skills or its configuration.",
    next: "Remove self-modification: skills are read-only in the sandbox and configuration changes come from the owner.",
  },
  S15: {
    means: "The name claims to be the platform's or impersonates someone.",
    next: "Name the skill as yours; the platform's brand and other publishers' names are not for a skill to claim.",
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
