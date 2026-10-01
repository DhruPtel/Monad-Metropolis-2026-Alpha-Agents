import * as domain from "@alpha-agents/domain";
import { describe, expect, it } from "vitest";
import * as skills from "./index.ts";

// D-153: the tool registry is defined once, in packages/domain, and
// packages/skills re-exports it rather than keeping a copy.
describe("tool registry location", () => {
  it("re-exports the registry objects defined in packages/domain", () => {
    expect(skills.TOOL_REGISTRY).toBe(domain.TOOL_REGISTRY);
    expect(skills.TOOL_IDS).toBe(domain.TOOL_IDS);
    expect(skills.INTENT_REGISTRY).toBe(domain.INTENT_REGISTRY);
    expect(skills.isToolId).toBe(domain.isToolId);
  });
});
