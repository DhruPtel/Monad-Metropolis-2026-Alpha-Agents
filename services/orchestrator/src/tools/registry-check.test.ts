import { TOOL_DEFERRALS, TOOL_REGISTRY, checkToolRegistry } from "@alpha-agents/domain";
import { LAUNCH_SKILL_MANIFESTS } from "@alpha-agents/skills";
import { describe, expect, it } from "vitest";
import { liveToolNames, registryReport } from "./registry-check.ts";

describe("the registry check against the live servers (P3-U9)", () => {
  it("resolves every registry ID to a live tool or a named deferral, and every launch skill's tools", async () => {
    const report = await registryReport();
    expect(report.problems).toEqual([]);
    // The tools this unit adds are live, not deferred.
    for (const id of [
      "data.x_search@1",
      "data.dune_query@1",
      "chain.read_contract@1",
      "chain.balance@1",
      "chain.get_code@1",
    ]) {
      expect(report.resolved).toContain(id);
    }
    expect(report.deferred.find((d) => d.id === "data.unlocks@1")?.reason).toMatch(/D-302/);
    expect(report.resolved.length + report.deferred.length).toBe(TOOL_REGISTRY.length);
  });

  it("fails when a registry ID is added with no tool and no deferral", async () => {
    const live = await liveToolNames();
    const problems = checkToolRegistry({
      registry: [
        ...TOOL_REGISTRY,
        { id: "data.brand_new@1", server: "data", tier: "baseline", purpose: "unbuilt" },
      ],
      deferrals: TOOL_DEFERRALS,
      live,
    });
    expect(problems).toEqual([
      {
        id: "data.brand_new@1",
        problem: "has no tool on the data server and no deferral naming its unit",
      },
    ]);
  });

  it("fails when a launch skill declares a tool outside the registry", async () => {
    const live = await liveToolNames();
    const declared = (LAUNCH_SKILL_MANIFESTS as { id: string; required_tools: string[] }[]).map(
      (m) => ({
        skill: m.id,
        tools:
          m.id === "deep-dive-research"
            ? [...m.required_tools, "data.sql_anything@1"]
            : m.required_tools,
      }),
    );
    expect(
      checkToolRegistry({ registry: TOOL_REGISTRY, deferrals: TOOL_DEFERRALS, live, declared }),
    ).toEqual([
      {
        id: "data.sql_anything@1",
        problem: "is declared by deep-dive-research but is not in the registry",
      },
    ]);
  });
});
