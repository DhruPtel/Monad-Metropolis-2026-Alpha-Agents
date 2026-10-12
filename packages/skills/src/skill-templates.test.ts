import { SKILL_TEMPLATES } from "@alpha-agents/domain";
import { describe, expect, it } from "vitest";
import { checkOwnerSkill } from "./owner.ts";

const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

describe("the skill templates an owner starts from (BC-U1)", () => {
  it("every template passes every format and audit check unchanged, with the owner as its publisher", () => {
    expect(SKILL_TEMPLATES.map((t) => t.id)).toEqual(["notes", "watchlist"]);
    for (const t of SKILL_TEMPLATES) {
      const files = t.files(OWNER).map((f) => ({ path: f.path, content: f.content }));
      expect(files.map((f) => f.path)).toContain("skill.json");
      expect(files.map((f) => f.path)).toContain("SKILL.md");
      const checked = checkOwnerSkill(files, {
        reservedIds: ["monad-assets-basics"],
        owner: OWNER,
      });
      expect(checked.blocked, `${t.id}: ${JSON.stringify(checked.issues)}`).toBe(false);
      expect(checked.issues.filter((i) => i.severity === "warn")).toEqual([]);
      expect(checked.pkg?.manifest.publisher.address.toLowerCase()).toBe(OWNER.toLowerCase());
    }
  });

  it("is refused once the publisher is another wallet, so the editor shows F7 at once", () => {
    const t = SKILL_TEMPLATES[0];
    if (!t) throw new Error("no template");
    const files = t.files("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
    const checked = checkOwnerSkill(files, { reservedIds: [], owner: OWNER });
    expect(checked.blocked).toBe(true);
    expect(checked.issues.map((i) => i.rule)).toContain("F7");
  });
});
