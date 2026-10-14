import { describe, expect, it } from "vitest";
import { REQUIRED_SOURCES, missingSources, scanTokenShortfall } from "./research.ts";

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

describe("the Scan's token count (2026-10-13)", () => {
  const theme = (token: string | null, scope = "TOKEN") => ({ scope, token });
  it("asks for exactly the run's Dives in tokens, or a reason for fewer", () => {
    const three = [theme("0xa"), theme("0xb"), theme("0xc")];
    expect(scanTokenShortfall({ themes: three }, 3)).toBeNull();
    expect(scanTokenShortfall({ themes: [theme("0xa")] }, 3)).toMatch(
      /the Scan chose 1: choose 3 tokens/,
    );
    expect(
      scanTokenShortfall(
        { themes: [theme("0xa")], fewerTokensReason: "Only one growth token has a pool." },
        3,
      ),
    ).toBeNull();
    expect(scanTokenShortfall({ themes: [...three, theme("0xd")] }, 3)).toMatch(
      /choose exactly 3 TOKEN themes, not 4/,
    );
    // The same token twice, or a market theme, does not count twice.
    expect(
      scanTokenShortfall({ themes: [theme("0xa"), theme("0xA"), theme(null, "MARKET")] }, 2),
    ).toMatch(/chose 1/);
  });
});
