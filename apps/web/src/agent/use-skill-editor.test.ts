import { describe, expect, it } from "vitest";
import { checkStateOf, templateFiles } from "./use-skill-editor";

const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

describe("the skill editor's text and check state (BC-U1)", () => {
  it("starts from a template with the owner as the publisher", () => {
    const files = templateFiles("watchlist", OWNER);
    expect(files.map((f) => f.path)).toEqual(["skill.json", "SKILL.md", "references/watchlist.md"]);
    const manifest = JSON.parse(files[0]?.content ?? "{}") as {
      id: string;
      publisher: { address: string };
    };
    expect(manifest.id).toBe("my-watchlist");
    expect(manifest.publisher.address).toBe(OWNER);
    // An unknown template falls back to the first one.
    expect(templateFiles("nope", OWNER)[0]?.content).toContain('"my-notes"');
  });

  it("reads the platform's answer as passed with its warnings, or refused with the blocking count", () => {
    const warn = {
      rule: "S13",
      severity: "warn" as const,
      path: "p",
      message: "m",
      means: "",
      next: "",
    };
    const block = {
      rule: "S1",
      severity: "block" as const,
      path: "p",
      message: "m",
      means: "",
      next: "",
    };
    expect(
      checkStateOf({
        agentId: "7",
        blocked: false,
        findings: [warn],
        skillId: "my-notes",
        name: "n",
      }),
    ).toEqual({ state: "passed", skillId: "my-notes", warnings: 1 });
    expect(
      checkStateOf({
        agentId: "7",
        blocked: true,
        findings: [block, block, warn],
        skillId: null,
        name: null,
      }),
    ).toEqual({ state: "refused", blocking: 2 });
  });
});
