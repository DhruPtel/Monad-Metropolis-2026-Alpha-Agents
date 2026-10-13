import { describe, expect, it } from "vitest";
import type { StoredReportJson, TerminalEventJson } from "@/api/client";
import {
  branches,
  factPhases,
  factSummaries,
  levelOf,
  phases,
  plain,
  sourceCounts,
} from "./research-run";

let seq = 0;
const ev = (
  at: string,
  stage: string | null,
  kind: string,
  text: string,
  tone: TerminalEventJson["tone"] = "info",
): TerminalEventJson => ({ seq: ++seq, at: `2026-10-13T${at}.000Z`, kind, stage, text, tone });

const RATIONALE =
  "Rationale: propose a plan; the evidence is mixed. Use the two-asset band plan: WMON at the 20% target within a 500 bps band, rest in USDC.";
const events: TerminalEventJson[] = [
  ev("17:46:39", null, "cycle", "Activation research started, reasoning on research-medium."),
  ev("17:46:41", "SCAN", "stage", "Scan started on research-low; it may cost up to 0.5 USDC."),
  ev(
    "17:46:41",
    "SCAN",
    "universe",
    "Universe: 253 tokens seen, 3 buyable for this account (TALPHA, TBETA, WMON).",
  ),
  ev("17:46:42", "SCAN", "universe", "Not buyable: AAVE (Base): research only."),
  ev("17:46:54", "SCAN", "tool", "market_snapshot: reading the market snapshot"),
  ev("17:46:59", "SCAN", "tool", "market_snapshot: answered; charged 0.001 USDC.", "ok"),
  ev("17:47:00", "SCAN", "tool", "list_tokens: listing the registry's tokens"),
  ev("17:47:01", "SCAN", "tool", 'web_search: searching the web for "MON unlock"'),
  ev("17:47:50", "SCAN", "stage", "Scan finished.", "ok"),
  ev(
    "17:48:12",
    "ZOOM_OUT",
    "brief",
    "Overview: Fresh account holding only USDC. Monad is stable but MON is weak.",
    "ok",
  ),
  ev("17:48:12", "ZOOM_OUT", "brief", RATIONALE, "ok"),
  ev(
    "17:48:12",
    "ZOOM_OUT",
    "plan",
    "Why this much is invested: Invested share of about 20% is below the expected 50% to 85%: no Dive produced a thesis, MON is down with 100% annualiz…",
  ),
  ev("17:48:20", "ZOOM_OUT", "brief", RATIONALE, "ok"),
  ev("17:48:27", "ZOOM_OUT", "brief", RATIONALE, "ok"),
  ev(
    "17:48:29",
    "ZOOM_OUT",
    "decision",
    "Decision: propose a plan with 0 positions; it goes to the Test and then to the owner.",
    "ok",
  ),
  ev("17:48:34", "ZOOM_OUT", "stage", "Zoom out finished.", "ok"),
  ev("17:48:35", "ZOOM_OUT", "withheld", "[a line was withheld: it carried playbook text]", "warn"),
  ev(
    "17:48:40",
    null,
    "cycle",
    "Activation research completed (completed): 0.406133 USDC in total.",
    "ok",
  ),
  ev("19:50:38", "TEST", "check", "Test checks: the plan passed every limit.", "ok"),
  ev("19:50:38", "ZOOM_OUT", "plan", "The plan was approved."),
];
const FINISHED = "2026-10-13T17:48:40.967Z";

describe("a research run in plain words (UI-FAST)", () => {
  it("counts each source and names the stages that finished", () => {
    expect(sourceCounts(events)).toEqual({
      webSearches: 1,
      pagesRead: 0,
      xPosts: 0,
      onchainReads: 1,
      marketCalls: 1,
      stages: ["Scan", "Zoom out"],
    });
  });

  it("groups the run into phases with plain sentences, the approval after the run its own phase", () => {
    const p = phases(events, FINISHED);
    expect(p.map((x) => x.title)).toEqual(["Market overview", "Scan", "Zoom out", "Approval"]);
    expect(p[1]?.summary[0]).toBe(
      "Looked at 253 tokens across Monad and Base and screened them for safety and liquidity; 3 can be bought by this account (TALPHA, TBETA, WMON).",
    );
    expect(p[2]?.summary).toEqual([
      "Chose WMON at 20% of the account, the rest in USDC.",
      "Why: Invested share of about 20% is below the expected 50% to 85%.",
    ]);
    expect(p[3]?.summary[0]).toMatch(/^You approved the plan on 2026-10-13 at 19:50 UTC/);
  });

  it("shows a line written three times once, and never a withheld line, in Details", () => {
    const zoom = phases(events, FINISHED).find((x) => x.id === "zoom");
    expect(zoom?.details.filter((d) => d.text === RATIONALE)).toHaveLength(1);
    expect(zoom?.details.some((d) => d.text.includes("withheld"))).toBe(false);
  });

  it("translates the jargon: basis points to percent, the band to a range", () => {
    expect(plain("WMON at the 20% target within a 500 bps band")).toBe(
      "WMON at the 20% target within a 5% range",
    );
    expect(levelOf("research-medium")).toBe("Medium");
  });
});

// Agent #4's activation report on testnet (2026-10-13), cut to its structured parts.
const universe = [
  ...Array.from({ length: 240 }, (_, i) => ({
    symbol: `T${i}`,
    buyable: false,
    whyNot:
      i < 100
        ? "research only: on Base, where this owner has no trading account (D-384)"
        : "research only: not in this account's token registry, so not buyable here yet",
    themeCode: null,
    themeReason: null,
    researched: false,
    proposed: false,
    droppedReason: null,
  })),
  ...["TALPHA", "TBETA"].map((symbol) => ({
    symbol,
    buyable: true,
    whyNot: null,
    themeCode: null,
    themeReason: null,
    researched: false,
    proposed: false,
    droppedReason: null,
  })),
  {
    symbol: "WMON",
    buyable: true,
    whyNot: null,
    themeCode: "DEX_VOL_SPIKE",
    themeReason: null,
    researched: true,
    proposed: true,
    droppedReason: null,
  },
  {
    symbol: "WETH",
    buyable: false,
    whyNot: "research only: not in this account's token registry, so not buyable here yet",
    themeCode: "WETH_MONAD_ENTRY",
    themeReason: null,
    researched: true,
    proposed: false,
    droppedReason: null,
  },
  ...Array.from({ length: 9 }, (_, i) => ({
    symbol: `U${i}`,
    buyable: false,
    whyNot: "research only: not in this account's token registry, so not buyable here yet",
    themeCode: null,
    themeReason: null,
    researched: false,
    proposed: false,
    droppedReason: null,
  })),
];
const body = {
  version: 1,
  cycle: {
    cycleId: "cycle-1",
    kind: "ACTIVATION",
    status: "completed",
    stopReason: null,
    createdAt: "",
  },
  stages: [
    { stage: "SCAN", themeCode: null, status: "completed", stopReason: null, chargedUsdcE6: "0" },
    {
      stage: "DIVE",
      themeCode: "DEX_VOL_SPIKE",
      status: "completed",
      stopReason: null,
      chargedUsdcE6: "0",
    },
    {
      stage: "CHALLENGE",
      themeCode: null,
      status: "completed",
      stopReason: null,
      chargedUsdcE6: "0",
    },
    { stage: "TEST", themeCode: null, status: "completed", stopReason: null, chargedUsdcE6: "0" },
    {
      stage: "ZOOM_OUT",
      themeCode: null,
      status: "completed",
      stopReason: null,
      chargedUsdcE6: "0",
    },
  ],
  report: {
    executiveSummary: "model prose, never shown here",
    recommendation: "",
    market: {
      overview: "model prose",
      snapshot: [
        { label: "MON price (USD)", value: "0.024484", source: "market_snapshot" },
        { label: "MON 24h change (%)", value: "-2.08", source: "market_snapshot" },
        {
          label: "Monad DEX volume, 24h (USD)",
          value: "33,337,989 (+39.87%)",
          source: "market_snapshot",
        },
        { label: "Monad TVL (USD)", value: "1,031,240,420", source: "market_snapshot" },
        {
          label: "MON realized volatility, 24h annualized",
          value: "79.93%",
          source: "market_snapshot",
        },
      ],
    },
    universeSummary: "",
    tokens: [
      {
        symbol: "WETH",
        chain: "Monad",
        whatItIs: "",
        fundamentals: [],
        evidenceFor: [
          { text: "a", sources: [] },
          { text: "b", sources: [] },
          { text: "c", sources: [] },
        ],
        evidenceAgainst: [
          { text: "d", sources: [] },
          { text: "e", sources: [] },
        ],
        risks: [],
        thesis: "",
        killCondition: "",
        confidence: "medium",
      },
    ],
    skeptic: [
      { theme: "DEX_VOL_SPIKE", objection: "x", answer: "y" },
      { theme: "WETH_MONAD_ENTRY", objection: "x", answer: "y" },
    ],
    portfolio: {
      stance: "propose",
      summary: "model prose",
      positions: [
        { symbol: "WMON", weight: "30%", why: "model prose" },
        { symbol: "USDC", weight: "70%", why: "model prose" },
      ],
    },
  },
  universe,
  sources: [],
} as unknown as StoredReportJson;

describe("the branch chart's lines (2026-10-13)", () => {
  it("draws one line per stage that ran and per source used, each call in time order with what it read", () => {
    const lines = branches(events);
    expect(lines.map((l) => [l.label, l.kind, l.calls.length])).toEqual([
      ["Scan", "stage", 3],
      ["Zoom out", "stage", 0],
      ["Web", "source", 1],
      ["Onchain", "source", 1],
      ["Market data", "source", 1],
    ]);
    expect(lines[0]?.calls.map((c) => c.label)).toEqual([
      "Reading the market snapshot",
      "Listing the registry's tokens",
      'Searching the web for "MON unlock"',
    ]);
  });
});

describe("What happened, from the report's facts (2026-10-13)", () => {
  it("writes each phase from the structured facts, never the model's prose", () => {
    const f = factSummaries(body);
    expect(f.overview).toEqual([
      "Read the market: Monad's total value locked is about $1.0B, MON fell 2.1% today, DEX trading was $33.3M over the last day, up 39.9% and MON's price swings about 80% a year.",
    ]);
    expect(f.scan).toEqual([
      "Screened 253 tokens across Monad and Base; 3 can be bought by this account (TALPHA, TBETA, WMON).",
      "Picked 2 themes to research: DEX vol spike and WETH monad entry.",
    ]);
    expect(f.dive).toEqual([
      "Researched WETH in depth: 3 points for, 2 against, with medium confidence.",
    ]);
    expect(f.challenge).toEqual([
      "A skeptic raised 2 objections about DEX vol spike and WETH monad entry, each answered in the report.",
    ]);
    expect(f.test).toEqual(["Checked the plan against every limit; it passed."]);
    expect(f.zoom).toEqual([
      "Chose WMON for 30% of the account and kept 70% in USDC, because MON is volatile and no other token had a strong enough case (TALPHA, TBETA were left out).",
    ]);
    expect(JSON.stringify(f)).not.toContain("model prose");
  });

  it("says so in one line when a phase has no facts, or the run has no report yet", () => {
    const none = factPhases(events, "2026-10-13T17:48:40.000Z", null);
    expect(none.find((p) => p.id === "scan")?.summary).toEqual([
      "The facts for this phase come with the report when the run ends.",
    ]);
    const thin = factPhases(events, "2026-10-13T17:48:40.000Z", {
      ...body,
      report: { ...body.report, skeptic: [], tokens: [] },
      stages: [],
    } as StoredReportJson);
    expect(thin.find((p) => p.id === "scan")?.summary[0]).toMatch(/^Screened 253 tokens/);
    expect(thin.find((p) => p.id === "challenge")).toBeUndefined();
  });
});
