import { describe, expect, it } from "vitest";
import type { TerminalEventJson } from "@/api/client";
import { levelOf, phases, plain, sourceCounts } from "./research-run";

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
