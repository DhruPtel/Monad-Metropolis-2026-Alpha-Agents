import { describe, expect, it } from "vitest";
import { pickProblem, pickedPath, stripSharedRoot } from "./skill-upload";

const f = (path: string, bytes = 100) => ({ path, content: "x", bytes });

describe("the skill upload's shape (SK-U1)", () => {
  it("takes a file's place in the picked folder, or its name, with forward slashes", () => {
    expect(pickedPath({ name: "skill.json", webkitRelativePath: "my-skill/skill.json" })).toBe(
      "my-skill/skill.json",
    );
    expect(pickedPath({ name: "skill.json", webkitRelativePath: "" })).toBe("skill.json");
    expect(pickedPath({ name: "a.md", webkitRelativePath: "my-skill\\references\\a.md" })).toBe(
      "my-skill/references/a.md",
    );
  });

  it("drops the shared root folder and leaves plain or mixed paths alone", () => {
    expect(
      stripSharedRoot([f("my-skill/skill.json"), f("my-skill/references/a.md")]).map((x) => x.path),
    ).toEqual(["skill.json", "references/a.md"]);
    expect(stripSharedRoot([f("skill.json"), f("SKILL.md")]).map((x) => x.path)).toEqual([
      "skill.json",
      "SKILL.md",
    ]);
    expect(stripSharedRoot([f("a/skill.json"), f("b/SKILL.md")]).map((x) => x.path)).toEqual([
      "a/skill.json",
      "b/SKILL.md",
    ]);
  });

  it("says what stops a pick from being sent: nothing picked, too many files, too big, a missing file", () => {
    expect(pickProblem([])).toMatch(/Pick the skill's folder/);
    expect(pickProblem(Array.from({ length: 81 }, (_, i) => f(`references/${i}.md`)))).toMatch(
      /at most 80/,
    );
    expect(pickProblem([f("skill.json", 4 * 1024 * 1024), f("SKILL.md")])).toMatch(/over 3 MB/);
    expect(pickProblem([f("SKILL.md")])).toMatch(/skill.json is missing/);
    expect(pickProblem([f("skill.json")])).toMatch(/SKILL.md is missing/);
    expect(pickProblem([f("skill.json"), f("SKILL.md")])).toBeNull();
  });
});
