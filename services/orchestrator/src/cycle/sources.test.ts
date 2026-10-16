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

  it("on a testnet counts only the research market's tokens, and takes no reason for fewer (2026-10-16)", () => {
    const testnet = { standIns: new Set(["0xwmon", "0xtalpha"]) };
    // The reported run: a POSITION theme on the held stand-in and two market themes.
    expect(
      scanTokenShortfall(
        {
          themes: [theme("0xwmon", "POSITION"), theme(null, "MARKET"), theme(null, "MARKET")],
          fewerTokensReason: "Only MON matters this week.",
        },
        3,
        testnet,
      ),
    ).toMatch(/the Scan chose 0 real ones: on a testnet choose 3 TOKEN themes/);
    expect(
      scanTokenShortfall({ themes: [theme("0xwmon"), theme("0xa"), theme("0xb")] }, 3, testnet),
    ).toMatch(/chose 2 real ones/);
    expect(
      scanTokenShortfall(
        { themes: [theme("0xwmon", "POSITION"), theme("0xa"), theme("0xb"), theme("0xc")] },
        3,
        testnet,
      ),
    ).toBeNull();
  });

  it("on the dev stack counts only the tokens it can trade, and takes no reason for fewer (2026-10-16)", () => {
    const dev = { tradable: new Set(["0xa", "0xb", "0xc"]) };
    expect(
      scanTokenShortfall(
        {
          themes: [theme("0xa"), theme("0xmainnet"), theme(null, "MARKET")],
          fewerTokensReason: "quiet",
        },
        3,
        dev,
      ),
    ).toMatch(
      /the Scan chose 1 this stack can trade: choose 3 TOKEN themes among the tokens get_prices marks buyable/,
    );
    expect(
      scanTokenShortfall({ themes: [theme("0xa"), theme("0xb"), theme("0xc")] }, 3, dev),
    ).toBeNull();
  });
});
