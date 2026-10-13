import { readFileSync } from "node:fs";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReportList, type ReportView, ResearchReportDocument } from "./report";

const view: ReportView = {
  title: "Agent #7: research report",
  kindLabel: "Activation sweep",
  writtenAt: "2026-10-13 07:44 UTC",
  costLine: "Written for 0.18 USDC of credits (ceiling 0.30 USDC).",
  executiveSummary: "Hold USDC through the unlock.",
  recommendation: "Keep the plan.",
  market: {
    overview: "Mixed.",
    snapshot: [{ label: "MON price", value: "0.0248 USD", source: "market_snapshot" }],
  },
  universeSummary: "Three tokens seen.",
  universe: [
    {
      symbol: "USDC",
      buyable: true,
      researched: false,
      proposed: false,
      themeCode: null,
      why: "cash",
    },
    {
      symbol: "WMON",
      buyable: true,
      researched: true,
      proposed: false,
      themeCode: "T",
      why: "chosen for a Dive",
    },
    {
      symbol: "AERO (Base)",
      buyable: false,
      researched: false,
      proposed: false,
      themeCode: null,
      why: "research only: on Base",
    },
  ],
  tokens: [
    {
      symbol: "WMON",
      chain: "Monad",
      whatItIs: "Wrapped MON.",
      fundamentals: [{ item: "Supply", finding: "Unlock due.", status: "concern" }],
      evidenceFor: [{ text: "Volume rose.", sources: ["market_snapshot"] }],
      evidenceAgainst: [],
      risks: ["Unlock selling"],
      thesis: "Wait.",
      killCondition: "TVL recovers.",
      confidence: "medium",
    },
  ],
  skeptic: [{ theme: "T", objection: "Priced in.", answer: "No position depends on it." }],
  portfolio: { stance: "no_change", summary: "Stay in USDC.", positions: [] },
  sources: [
    { source: "market_snapshot", kind: "tool", classes: ["market"], calls: 1 },
    { source: "https://x.com/monad/status/1", kind: "url", classes: ["social"], calls: 1 },
  ],
  stages: [{ label: "Scan", result: "finished", charged: "0.17 USDC" }],
  checksNote: null,
};

describe("the research report document (RP-U1)", () => {
  it("lays out every section in order, as a document", () => {
    render(<ResearchReportDocument view={view} />);
    const ids = [...screen.getByTestId("research-report").querySelectorAll("section")].map((s) =>
      s.getAttribute("data-testid"),
    );
    expect(ids).toEqual([
      "report-summary",
      "report-market",
      "report-universe",
      "report-tokens",
      "report-skeptic",
      "report-portfolio",
      "report-sources",
      "report-method",
    ]);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Agent #7: research report",
    );
    expect(screen.getByTestId("report-recommendation")).toHaveTextContent("Keep the plan.");
  });

  it("counts the universe and lists every token with its reason", () => {
    render(<ResearchReportDocument view={view} />);
    const universe = screen.getByTestId("report-universe");
    expect(universe).toHaveTextContent(
      "3 tokens seen, 2 buyable by this account, 1 researched in depth.",
    );
    expect(within(universe).getAllByTestId("report-universe-row")).toHaveLength(3);
    expect(universe).toHaveTextContent("research only: on Base");
  });

  it("gives each researched token its checklist, evidence, risks, thesis, kill condition and confidence", () => {
    render(<ResearchReportDocument view={view} />);
    const token = screen.getByTestId("report-token");
    for (const text of [
      "Supply",
      "Concern",
      "Volume rose.",
      "Unlock selling",
      "Wait.",
      "TVL recovers.",
      "medium confidence",
    ])
      expect(token).toHaveTextContent(text);
  });

  it("groups the sources by class", () => {
    render(<ResearchReportDocument view={view} />);
    const classes = screen
      .getAllByTestId("report-source-class")
      .map((c) => c.getAttribute("data-class"));
    expect(classes).toEqual(["market", "social"]);
  });

  it("marks the page's actions to be left out of the PDF", () => {
    render(
      <ResearchReportDocument
        view={view}
        actions={<button type="button">Download as PDF</button>}
      />,
    );
    const actions = screen.getByRole("button", { name: "Download as PDF" }).parentElement;
    expect(actions).toHaveAttribute("data-print", "hide");
  });

  it("links each written report and says why one was skipped", () => {
    render(
      <ReportList
        items={[
          {
            cycleId: "c1",
            href: "/r/1",
            kindLabel: "Activation sweep",
            writtenAt: "x",
            status: "written",
            summary: "Hold.",
            reason: null,
            tokens: 1,
          },
          {
            cycleId: "c2",
            href: "/r/2",
            kindLabel: "Routine",
            writtenAt: "y",
            status: "skipped",
            summary: null,
            reason: "no brief",
            tokens: 0,
          },
        ]}
      />,
    );
    expect(screen.getByTestId("report-link")).toHaveAttribute("href", "/r/1");
    expect(screen.getByTestId("report-list")).toHaveTextContent("no brief");
  });
});

describe("the report's print styling, which the PDF uses (RP-U1)", () => {
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const print = css.slice(css.indexOf("@media print"));

  it("puts a report page on paper tokens and hides the app's header, navigation, banner and actions", () => {
    expect(print).toMatch(/:root:has\(\.report-document\)/);
    expect(print).toMatch(/--background: var\(--palette-paper\)/);
    expect(print).toMatch(/--foreground: var\(--palette-ink\)/);
    for (const hidden of ["nav", '[data-slot="beta-banner"]', '[data-print="hide"]'])
      expect(print).toContain(`body:has(.report-document) ${hidden}`);
  });

  it("keeps a token's section on one page", () => {
    expect(print).toMatch(/\.report-token,[\s\S]*break-inside: avoid/);
  });
});
