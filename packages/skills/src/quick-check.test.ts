import { describe, expect, it } from "vitest";
import { quickFindings } from "./quick-check.ts";

const manifest = {
  schema_version: 1,
  id: "my-skill",
  name: "My skill",
  version: "1.0.0",
  type: "research",
  publisher: { id: "owner", address: "0x976EA74026E726554dB657fA54763abd0C3a0aa9", key_id: "k1" },
  description: {
    model: "Reads one public page and summarises it for the agent's notes in a few lines.",
    marketplace: "A reading skill.",
  },
  required_tools: ["data.read_url@1"],
  intents: [],
  data_sources: [],
  required_tier: "base",
  slot_cost: 1,
  synergy_tags: [],
  chains: ["eip155:143"],
  privacy: "public",
};

describe("the browser-side quick check (CL-U1)", () => {
  it("passes a well-formed package without a round trip", () => {
    const findings = quickFindings([
      { path: "skill.json", content: JSON.stringify(manifest) },
      { path: "SKILL.md", content: "# My skill\n\nRead the page, then write the note." },
    ]);
    expect(findings).toEqual([]);
  });

  it("names the missing files, bad JSON and a disallowed path with the platform's rules and words", () => {
    const findings = quickFindings([
      { path: "skill.json", content: "{ not json" },
      { path: "scripts/run.sh", content: "" },
    ]);
    expect(findings.map((f) => [f.rule, f.path])).toEqual([
      ["F2", "scripts/run.sh"],
      ["F1", "SKILL.md"],
      ["F1", "skill.json"],
    ]);
    for (const f of findings) {
      expect(f.severity).toBe("block");
      expect(f.means.length).toBeGreaterThan(0);
      expect(f.next.length).toBeGreaterThan(0);
    }
  });

  it("maps a manifest issue as the platform does and measures SKILL.md", () => {
    const findings = quickFindings([
      { path: "skill.json", content: JSON.stringify({ ...manifest, privacy: "private" }) },
      { path: "SKILL.md", content: `${"line\n".repeat(501)}` },
    ]);
    expect(findings.some((f) => f.rule === "F8" && f.path === "skill.json:privacy")).toBe(true);
    expect(findings.some((f) => f.rule === "F3" && f.path === "SKILL.md")).toBe(true);
  });
});
