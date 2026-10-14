import { describe, expect, it } from "vitest";
import type { SkillJson } from "@/api/client";
import { skillCards, toolWord } from "./skill-cards";

const skill = (over: Partial<SkillJson>): SkillJson => ({
  id: "x",
  name: "X",
  version: "1.0.0",
  description: "Does a thing.",
  kind: "skill",
  contentHash: "0x",
  tools: [],
  ...over,
});

describe("the configure page's skill cards (2026-10-13)", () => {
  it("takes each card from the skill's real record: category, publisher, stage and tools", () => {
    const [risk, dive, mine] = skillCards([
      skill({
        id: "token-risk-screen",
        name: "Token risk screen",
        description: "Reads a token's safety screen. Use when a Dive weighs a token.",
        tools: ["data.screen_token@1", "data.lookup_token@1"],
      }),
      skill({ id: "playbook-dive", name: "Dive playbook", kind: "playbook", version: "2.1.0" }),
      skill({ id: "my-trader", name: "My trader", kind: "owner", tools: ["trade.propose_swap@1"] }),
    ]);
    expect(risk).toMatchObject({
      category: "Research",
      publisher: "Vivarium",
      verified: true,
      stage: "Dive",
      tools: ["safety screen", "token lookup"],
    });
    expect(dive).toMatchObject({ category: "Research", stage: "Dive", version: "2.1.0" });
    expect(mine).toMatchObject({
      category: "Execution",
      publisher: "You",
      verified: false,
      stage: null,
    });
    expect(skillCards([skill({ id: "uniswap-v4-swap" })])[0]?.category).toBe("Protocol");
    expect(skillCards([skill({ id: "portfolio-construction" })])[0]?.category).toBe("Strategy");
    expect(toolWord("data.x_search@1")).toBe("X search");
  });
});
