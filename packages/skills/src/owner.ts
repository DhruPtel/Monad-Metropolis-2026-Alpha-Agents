import { isAddressEqual } from "viem";
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

/** The words for a rule the table does not know (never expected): the rule's own message stands. */
export function ruleWords(rule: string): { means: string; next: string } {
  return (
    RULE_WORDS[rule] ?? {
      means: "A rule of the skill format was not met.",
      next: "Read the finding and change the package accordingly.",
    }
  );
}
