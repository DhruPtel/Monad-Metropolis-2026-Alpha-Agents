import { describe, expect, it } from "vitest";
import {
  LAUNCH_SKILL_MANIFESTS,
  type SkillManifest,
  allowedTools,
  buildFits,
  validateManifest,
} from "./index.ts";

const launch = LAUNCH_SKILL_MANIFESTS.map((m) => {
  const r = validateManifest(m);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.manifest;
});
const band = LAUNCH_SKILL_MANIFESTS[2] as Record<string, unknown>;
const research = LAUNCH_SKILL_MANIFESTS[4] as Record<string, unknown>;
const omit = (m: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(m).filter(([k]) => k !== key));

describe("launch skills (FINAL_PLAN 4.5.4)", () => {
  it("all nine validate against the registry", () => {
    expect(launch).toHaveLength(9);
  });

  it("cost eleven slot points in total, so no tier holds them all", () => {
    expect(launch.reduce((s, m) => s + m.slot_cost, 0)).toBe(11);
    expect(buildFits("pro", launch).fits).toBe(false);
  });

  it("let a base agent hold three slot points and no more", () => {
    const [assets, swap, , dca] = launch as [
      SkillManifest,
      SkillManifest,
      SkillManifest,
      SkillManifest,
    ];
    expect(buildFits("base", [assets, dca])).toMatchObject({ fits: true, used: 3, slots: 3 });
    expect(buildFits("base", [assets, swap, dca]).fits).toBe(false);
  });

  it("refuses a build whose skill needs a higher tier", () => {
    const pro = { ...launch[0], required_tier: "pro" } as SkillManifest;
    expect(buildFits("medium", [pro])).toMatchObject({
      fits: false,
      tierNotMet: ["monad-assets-basics"],
    });
  });

  it("adds the implicit tools to what a skill may call", () => {
    expect(allowedTools(launch[0] as SkillManifest)).toContain("platform.get_goals_and_limits@1");
  });
});

describe("manifest validation", () => {
  const issues = (m: unknown) => {
    const r = validateManifest(m);
    return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
  };

  it.each([
    [
      "a tool outside the registry",
      { required_tools: ["chain.send_transaction@1"] },
      /not in the tool registry/,
    ],
    ["a retired research ID", { required_tools: ["data.dex_quote"] }, /retired research ID/],
    [
      "the reserved premium pattern",
      { required_tools: ["data.premium_*@1"] },
      /not in the tool registry/,
    ],
    [
      "a tool at a major version that does not exist",
      { required_tools: ["chain.get_quote@2"] },
      /not in the tool registry/,
    ],
    [
      "an intent outside the intent subset",
      { intents: ["chain.propose_swap@1"] },
      /not a registry intent/,
    ],
    [
      "a duplicated tool",
      { required_tools: ["data.x_search@1", "data.x_search@1"] },
      /more than once/,
    ],
    ["private on a research skill", { privacy: "private" }, /private requires type strategy/],
    ["slot cost 4", { slot_cost: 4 }, /slot_cost/],
    ["another chain", { chains: ["eip155:1"] }, /chains/],
    ["a platform-computed field", { content_hash: "0xabc" }, /Unrecognized key/],
    ["an upper-case ID", { id: "Deep-Dive" }, /id/],
    [
      "a long model description",
      { description: { model: "x".repeat(161), marketplace: "m" } },
      /description.model/,
    ],
  ])("rejects %s", (_, patch, message) => {
    const found = issues({ ...research, ...patch });
    expect(found.length).toBeGreaterThan(0);
    expect(found.join("\n")).toMatch(message);
  });

  it("requires a strategy skill to name its templates", () => {
    expect(issues(omit(band, "compatible_templates")).join("\n")).toMatch(
      /must name its templates/,
    );
  });

  it("defaults required_tier to base", () => {
    const r = validateManifest(omit(research, "required_tier"));
    expect(r.ok && r.manifest.required_tier).toBe("base");
  });
});
