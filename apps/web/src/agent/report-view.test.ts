import { describe, expect, it } from "vitest";
import type { ReportJson } from "@/api/client";
import { figure, printReport, reportHref, reportListView, reportView } from "./report-view";

const report: ReportJson["report"] = {
  cycleId: "cycle-0123abcd-0000-4000-8000-0000000000aa",
  status: "written",
  reason: null,
  createdAt: "2026-10-13T07:44:10.000Z",
  model: "research-medium",
  chargedUsdcE6: "182000",
  ceilingUsdcE6: "300000",
  checks: { removedSentences: 2, droppedSources: 1 },
  body: {
    version: 1,
    cycle: {
      cycleId: "cycle-0123abcd-0000-4000-8000-0000000000aa",
      kind: "ACTIVATION",
      status: "completed",
      stopReason: "COMPLETED",
      createdAt: "2026-10-13T07:35:00.000Z",
    },
    stages: [
      {
        stage: "SCAN",
        themeCode: null,
        status: "completed",
        stopReason: "COMPLETED",
        chargedUsdcE6: "174422",
      },
      {
        stage: "DIVE",
        themeCode: "MON_SUPPLY_UNLOCK",
        status: "skipped",
        stopReason: "BUDGET_SHORT",
        chargedUsdcE6: "0",
      },
    ],
    report: {
      executiveSummary: "Hold USDC.",
      recommendation: "Keep the plan.",
      market: { overview: "Mixed.", snapshot: [] },
      universeSummary: "150 tokens.",
      tokens: [],
      skeptic: [],
      portfolio: { stance: "no_change", summary: "Stay.", positions: [] },
    },
    universe: [
      {
        symbol: "WMON",
        buyable: true,
        whyNot: null,
        themeCode: "T",
        themeReason: "chosen for a Dive",
        researched: true,
        proposed: false,
        droppedReason: null,
      },
      {
        symbol: "AERO (Base)",
        buyable: false,
        whyNot: "research only: on Base",
        themeCode: null,
        themeReason: "seen at the Scan",
        researched: false,
        proposed: false,
        droppedReason: null,
      },
      {
        symbol: "USDC",
        buyable: true,
        whyNot: null,
        themeCode: null,
        themeReason: null,
        researched: false,
        proposed: false,
        droppedReason: "the account's cash",
      },
    ],
    sources: [{ source: "market_snapshot", kind: "tool", classes: ["market"], calls: 1 }],
  },
};

describe("the research report's view (RP-U1)", () => {
  it("names the kind, the time, the cost against the ceiling and what the checks removed", () => {
    const v = reportView(report, "Agent #2");
    expect(v).toMatchObject({
      title: "Research report",
      byline: "Agent #2",
      kindLabel: "Activation sweep",
      writtenAt: "2026-10-13 07:44 UTC",
      checksNote:
        "The checks removed 2 sentences the records could not support. 1 cited source was dropped as not retrieved by the cycle.",
    });
    expect(v?.costLine).toContain("0.182 USDC of credits (ceiling 0.30 USDC)");
  });

  it("gives every universe row its reason: why researched, why not buyable, or why dropped", () => {
    const v = reportView(report, "Agent #2");
    expect(v?.universe.map((u) => [u.symbol, u.why])).toEqual([
      ["WMON", "chosen for a Dive"],
      ["AERO (Base)", "research only: on Base"],
      ["USDC", "the account's cash"],
    ]);
  });

  it("numbers the sources in the order the text first cites them, then the ones it never cites", () => {
    const body = report.body;
    if (!body) throw new Error("fixture has a body");
    const cited: typeof report = {
      ...report,
      body: {
        ...body,
        report: {
          ...body.report,
          market: {
            overview: "Mixed.",
            snapshot: [{ label: "MON price", value: "0.02504364702970262", source: "get_prices" }],
          },
          tokens: [
            {
              symbol: "WMON",
              chain: "Monad",
              whatItIs: "Wrapped MON.",
              fundamentals: [],
              evidenceFor: [{ text: "Deep pools.", sources: ["find_pools", "get_prices"] }],
              evidenceAgainst: [{ text: "Unlock due.", sources: ["https://tokenomist.ai/monad/"] }],
              risks: [],
              thesis: "Wait.",
              killCondition: "TVL recovers.",
              confidence: "low",
            },
          ],
        },
        sources: [
          { source: "market_snapshot", kind: "tool", classes: ["market"], calls: 3 },
          { source: "find_pools", kind: "tool", classes: ["onchain", "market"], calls: 1 },
          {
            source: "https://tokenomist.ai/monad/",
            kind: "url",
            classes: ["primary", "news"],
            calls: 1,
          },
        ],
      },
    };
    const v = reportView(cited, "Agent #2");
    expect(v?.title).toBe("Research report: WMON");
    expect(v?.market.snapshot).toEqual([{ label: "MON price", value: "0.02504", cites: [1] }]);
    expect(v?.tokens[0]?.evidenceFor[0]?.cites).toEqual([1, 2]);
    expect(v?.tokens[0]?.evidenceAgainst[0]?.cites).toEqual([3]);
    expect(v?.references.map((r) => [r.n, r.label, r.href, r.cited])).toEqual([
      [1, "get_prices", null, true],
      [2, "find_pools", null, true],
      [3, "tokenomist.ai/monad", "https://tokenomist.ai/monad/", true],
      [4, "market_snapshot", null, false],
    ]);
    expect(v?.references[3]?.detail).toBe("Tool record, market data, 3 calls");
    // The researched token counts as researched even when the Scan's row says not.
    expect(v?.universe.find((u) => u.symbol === "WMON")?.researched).toBe(true);
  });

  it("groups the universe by outcome and reason, researched first", () => {
    expect(
      reportView(report, "Agent #2")?.universeGroups.map((g) => [g.outcome, g.symbols]),
    ).toEqual([
      ["researched", ["WMON"]],
      ["buyable", ["USDC"]],
      ["not buyable", ["AERO (Base)"]],
    ]);
  });

  it("reads a bare number at a sensible precision and keeps any other text", () => {
    expect(figure("0.02504364702970262")).toBe("0.02504");
    expect(figure("-4.48722235")).toBe("-4.49");
    expect(figure("1009846222")).toBe("1,009,846,222");
    expect(figure("102.5%")).toBe("102.5%");
    expect(figure("33.34M USD, up 39.87%")).toBe("33.34M USD, up 39.87%");
  });

  it("words each step's result and its charge", () => {
    expect(reportView(report, "Agent #2")?.stages).toEqual([
      { label: "Scan", result: "finished", charged: "0.1744 USDC" },
      { label: "Dive (MON_SUPPLY_UNLOCK)", result: "skipped: budget short", charged: "0.00 USDC" },
    ]);
  });

  it("has no view for a report that was not written", () => {
    expect(reportView({ ...report, status: "skipped", body: null }, "Agent #2")).toBeNull();
  });

  it("links each written report from the list", () => {
    const [item] = reportListView(2n, [
      {
        cycleId: report.cycleId,
        kind: "ROUTINE",
        status: "written",
        reason: null,
        createdAt: report.createdAt,
        chargedUsdcE6: "1",
        ceilingUsdcE6: "1",
        tokens: 0,
        summary: "s",
      },
    ]);
    expect(item).toMatchObject({
      href: reportHref(2n, report.cycleId),
      kindLabel: "Routine research cycle",
    });
    expect(item?.href).toBe(
      "/agents/2/research/reports/cycle-0123abcd-0000-4000-8000-0000000000aa",
    );
  });
});

describe("Download as PDF (RP-U1)", () => {
  it("prints under the report's own title, so the PDF is named after it, and restores the page's", () => {
    const seen: string[] = [];
    const target = {
      document: { title: "Research report · Vivarium" },
      print() {
        seen.push(this.document.title);
      },
    };
    const title = printReport(target, "Agent #2", report.cycleId);
    expect(seen).toEqual(["Vivarium research report, Agent #2, 0123abcd"]);
    expect(title).toBe(seen[0]);
    expect(target.document.title).toBe("Research report · Vivarium");
  });
});

describe("the report's decision (2026-10-13)", () => {
  it("leads with what the agent would buy, and on testnet says how the plan executes there", () => {
    const body = report.body as NonNullable<typeof report.body>;
    const withMain: ReportJson["report"] = {
      ...report,
      body: {
        ...body,
        report: {
          ...body.report,
          mainDecision: {
            summary: "The agent would hold WETH and USDC.",
            positions: [
              { symbol: "WETH", weight: "30%", why: "Deep pools." },
              { symbol: "USDC", weight: "70%", why: "Cash." },
            ],
          },
          portfolio: {
            stance: "propose",
            summary: "",
            positions: [{ symbol: "WMON", weight: "30%", why: "" }],
          },
        },
      },
    };
    const testnet = reportView(withMain, "Agent #4", "testnet");
    expect(testnet?.mainDecision?.positions.map((x) => x.symbol)).toEqual(["WETH", "USDC"]);
    expect(testnet?.testnet).toEqual({ network: "Monad Testnet", executesAs: "WMON 30%." });
    expect(reportView(withMain, "Agent #4", "beta")?.testnet).toBeNull();
    expect(reportView(report, "Agent #4", "testnet")?.testnet).toBeNull();
  });
});
