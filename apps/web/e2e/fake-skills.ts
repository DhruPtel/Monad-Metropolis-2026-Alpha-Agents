import type { OwnerSkillJson, SkillFindingJson, SkillJson, SkillsJson } from "../src/api/client";

/**
 * The owner's skills as the fake API serves them (SK-U1): the built-in set
 * every agent mounts, the owner's own uploads this fake accepted, and a
 * scripted answer for the next upload (refused with findings, or mounted
 * with warnings). Served on the owner session alone, like the real route.
 */
export const BUILTIN_SKILLS: readonly SkillJson[] = [
  {
    id: "monad-assets-basics",
    name: "Monad assets basics",
    version: "1.0.2",
    description: "What MON, WMON and USDC are on Monad. Use when a token is unfamiliar.",
    kind: "skill",
    contentHash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    tools: ["data.web_search@1"],
  },
  {
    id: "deep-dive-research",
    name: "Deep dive research",
    version: "1.1.0",
    description: "Researches one token across sources. Use when a Dive is asked for.",
    kind: "skill",
    contentHash: "b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1",
    tools: ["data.web_search@1", "data.read_url@1", "data.x_search@1"],
  },
  {
    id: "playbook-scan",
    name: "Scan playbook",
    version: "2.0.0",
    description: "The Scan stage: broad and cheap. Use when asked to scan the market.",
    kind: "playbook",
    contentHash: "c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2",
    tools: ["data.web_search@1", "data.market_snapshot@1"],
  },
];

export const REFUSED_FINDINGS: readonly SkillFindingJson[] = [
  {
    rule: "S1",
    severity: "block",
    path: "SKILL.md:4",
    message: "shell or code execution",
    means: "The text asks for shell or code to run; a skill is text and declarations, never code.",
    next: "Remove shell blocks, commands and code execution; describe what the agent should do with the platform's tools instead.",
  },
  {
    rule: "F7",
    severity: "block",
    path: "skill.json:publisher.address",
    message: "publisher.address must be your wallet, 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    means: "The package's publisher is not you.",
    next: "Set publisher.address in skill.json to the wallet you are signed in with; publisher.id and key_id are yours to choose.",
  },
  {
    rule: "S13",
    severity: "warn",
    path: "references/notes.md:3",
    message: "0x1111111111111111111111111111111111111111 is not in the platform address book",
    means:
      "An address in the text is not in the platform's address book, so it may be an impostor.",
    next: "Use the registered token and contract addresses from the address book, or name the token by symbol and let the tools resolve it.",
  },
];

const WARNING: SkillFindingJson = {
  rule: "S5",
  severity: "warn",
  path: "SKILL.md:6",
  message: "a network endpoint in the text",
  means: "The text names an endpoint the skill did not declare.",
  next: "Use the declared data sources and the platform's tools; remove undeclared URLs and hosts.",
};

export function ownerSkillFixture(over: Partial<OwnerSkillJson> = {}): OwnerSkillJson {
  return {
    id: "owner-notes",
    name: "Owner notes on Monad",
    version: "1.0.0",
    description: "The owner's notes on Monad tokens. Use when scanning.",
    kind: "owner",
    contentHash: "d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3",
    manifestHash: "e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4",
    hermesName: "aa-owner-notes",
    tools: ["data.web_search@1"],
    warnings: [],
    uploadedAt: "2026-10-12T07:40:00.000Z",
    uploadedAtUtc: "2026-10-12 07:40 UTC",
    files: ["SKILL.md", "references/notes.md", "skill.json"],
    ...over,
  };
}

export class FakeSkills {
  owner: OwnerSkillJson[] = [];
  /** What the next upload answers: refused with findings, or mounted (with warnings when `warn`). */
  nextUpload: { refuse: true } | { refuse: false; warn: boolean } = { refuse: false, warn: false };
  /** Every upload the page sent: the paths, in order. */
  readonly uploads: string[][] = [];
  readonly removals: string[] = [];
  /** BC-U1: a task running now, so the page says a change joins the next one. */
  taskRunning = false;
  /** BC-U1: every check the editor asked for: the files' paths, in order. */
  readonly checks: string[][] = [];

  list(agentId: string): SkillsJson {
    return {
      agentId,
      builtin: BUILTIN_SKILLS,
      owner: this.owner,
      limits: { packageBytes: 2 * 1024 * 1024 },
      taskRunning: this.taskRunning,
    };
  }

  /**
   * BC-U1: the editor's live check. The fake judges the text itself, as the
   * platform's rules would: a shell command in SKILL.md blocks (S1), an
   * unknown address in the notes warns (S13); otherwise the package passes.
   */
  check(
    agentId: string,
    body: { files?: { path: string; content: string }[] } | null,
  ): { status: number; body: unknown } {
    const files = body?.files ?? [];
    this.checks.push(files.map((f) => f.path));
    const text = (path: string) => files.find((f) => f.path === path)?.content ?? "";
    const findings: SkillFindingJson[] = [];
    if (/curl|\bsh\b|```/.test(text("SKILL.md")))
      findings.push(REFUSED_FINDINGS[0] as SkillFindingJson);
    if (/0x1111111111111111111111111111111111111111/.test(files.map((f) => f.content).join("\n")))
      findings.push(REFUSED_FINDINGS[2] as SkillFindingJson);
    let skillId: string | null = null;
    let name: string | null = null;
    try {
      const m = JSON.parse(text("skill.json")) as { id?: string; name?: string };
      skillId = m.id ?? null;
      name = m.name ?? null;
    } catch {
      findings.push({
        rule: "F1",
        severity: "block",
        path: "skill.json",
        message: "skill.json is not valid JSON",
        means: "The manifest could not be read.",
        next: "Fix the JSON: every key and string in double quotes, commas between fields.",
      });
    }
    const blocked = findings.some((f) => f.severity === "block");
    return { status: 200, body: { agentId, blocked, findings, skillId, name } };
  }

  upload(
    agentId: string,
    body: { files?: { path: string; content: string }[] } | null,
  ): { status: number; body: unknown } {
    const files = body?.files ?? [];
    this.uploads.push(files.map((f) => f.path));
    if (this.nextUpload.refuse)
      return {
        status: 422,
        body: {
          error: "skill_refused",
          message: "The package was refused. Fix each blocking finding and upload it again.",
          blocked: true,
          findings: REFUSED_FINDINGS,
        },
      };
    const manifest = files.find((f) => f.path === "skill.json");
    let id = "owner-notes";
    let name = "Owner notes on Monad";
    try {
      const m = JSON.parse(manifest?.content ?? "{}") as { id?: string; name?: string };
      id = m.id ?? id;
      name = m.name ?? name;
    } catch {
      // the fake accepts what it was told to accept
    }
    const already = this.owner.some((o) => o.id === id);
    const skill = ownerSkillFixture({
      id,
      name,
      warnings: this.nextUpload.warn ? [WARNING] : [],
      files: files.map((f) => f.path).sort(),
    });
    this.owner = [...this.owner.filter((o) => o.id !== id), skill];
    return {
      status: already ? 200 : 201,
      body: {
        agentId,
        skill,
        blocked: false,
        findings: skill.warnings,
        already,
        mounted: "at the agent's next sandbox",
      },
    };
  }

  remove(agentId: string, skillId: string): { status: number; body: unknown } {
    this.removals.push(skillId);
    if (!this.owner.some((o) => o.id === skillId))
      return {
        status: 404,
        body: { error: "not_found", message: "This agent has no such skill of yours." },
      };
    this.owner = this.owner.filter((o) => o.id !== skillId);
    return { status: 200, body: { agentId, removed: skillId } };
  }
}
