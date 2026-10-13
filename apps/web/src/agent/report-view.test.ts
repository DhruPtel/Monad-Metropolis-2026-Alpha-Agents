import { describe, expect, it } from "vitest";
import type { ReportJson } from "@/api/client";
import { printReport, reportHref, reportListView, reportView } from "./report-view";

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
      title: "Agent #2: research report",
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
