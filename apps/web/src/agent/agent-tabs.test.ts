import { describe, expect, it } from "vitest";
import { activeAgentTab, agentTabs } from "./agent-tabs";

describe("the agent pages' tabs (UI-FAST)", () => {
  it("lists the six tabs in order, Overview at the agent's own path", () => {
    expect(agentTabs(4n).map((t) => [t.label, t.href])).toEqual([
      ["Overview", "/agents/4"],
      ["Trading", "/agents/4/trading"],
      ["Research", "/agents/4/research"],
      ["Vault", "/agents/4/vault"],
      ["Skills", "/agents/4/skills"],
      ["Keys", "/agents/4/settings"],
    ]);
  });

  it("marks the tab a path belongs to, a report under Research, and none for the goal form", () => {
    expect(activeAgentTab("/agents/4", 4n)).toBe("overview");
    expect(activeAgentTab("/agents/4/trading", 4n)).toBe("trading");
    expect(activeAgentTab("/agents/4/research/reports/cycle-1", 4n)).toBe("research");
    expect(activeAgentTab("/agents/4/goal", 4n)).toBeNull();
    expect(activeAgentTab("/agents/4/window", 4n)).toBeNull();
  });
});
