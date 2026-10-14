import { describe, expect, it } from "vitest";
import { REQUIRED_SOURCES, missingSources } from "./research.ts";

describe("the sources a stage must call (2026-10-13)", () => {
  it("asks a Scan and each Dive for a web search and an X search, and nothing of the other stages", () => {
    expect(missingSources("SCAN", new Set(["market_snapshot", "list_tokens"]))).toEqual([
      "web_search",
      "x_search",
    ]);
    expect(missingSources("DIVE", new Set(["web_search"]))).toEqual(["x_search"]);
    expect(missingSources("DIVE", new Set(["web_search", "x_search"]))).toEqual([]);
    expect(missingSources("CHALLENGE", new Set())).toEqual([]);
    expect(missingSources("ZOOM_OUT", new Set())).toEqual([]);
    // Without the rule (as the scripted cycle tests run), nothing is required.
    expect(missingSources("SCAN", new Set(), {})).toEqual([]);
    expect(REQUIRED_SOURCES.SCAN).toEqual(["web_search", "x_search"]);
  });
});
