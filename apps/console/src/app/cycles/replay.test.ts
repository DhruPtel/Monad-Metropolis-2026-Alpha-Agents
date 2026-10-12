import { describe, expect, it } from "vitest";
import type { StageDetail } from "./cycles";
import { changedTexts, compareStages, storedInputSummary } from "./replay";

const text = (name: string, skillMd: string) => ({
  kind: "playbook" as const,
  name,
  title: name,
  skillMd,
  version: "1",
  savedVersions: 0,
});

const stage = (over: Partial<StageDetail>): StageDetail => ({
  stageRunId: "stage-run-1",
  seq: 1,
  stage: "SCAN",
  themeCode: null,
  model: "scan-cheap",
  caps: { turns: 10, paidCalls: 5, tokens: 300_000, seconds: 300 },
  ceilingUsdcE6: "300000",
  status: "completed",
  stopReason: "COMPLETED",
  modelCalls: 2,
  inputTokens: 12_000,
  outputTokens: 100,
  cacheReadTokens: 5_900,
  cacheWriteTokens: 5_900,
  chargedUsdcE6: "20000",
  absorbedUsdcE6: "0",
  outcome: null,
  startedAt: null,
  finishedAt: null,
  entry: null,
  record: { outcome: "DONE", candidates: [{ asset: "WMON" }], decision: null },
  modelCallRecords: [],
  toolCalls: [],
  notes: [],
  briefs: [
    {
      briefId: "b1",
      kind: "SCAN",
      status: "refused",
      body: {},
      reasons: ["12.4 does not appear"],
      at: "",
    },
    { briefId: "b2", kind: "SCAN", status: "accepted", body: {}, reasons: [], at: "" },
  ],
  ...over,
});

describe("the replay tool's page rules (UI-U2)", () => {
  it("sends only the texts the owner changed, as the replay mounts them", () => {
    const texts = [text("aa-playbook-scan", "# Scan\n"), text("aa-owner-notes", "# Notes\n")];
    expect(changedTexts(texts, { "aa-playbook-scan": "# Scan\n", "aa-owner-notes": "# Notes\n" })).toEqual(
      [],
    );
    expect(
      changedTexts(texts, { "aa-playbook-scan": "# Scan, edited\n", "aa-owner-notes": "# Notes\n" }),
    ).toEqual([{ kind: "playbook", name: "aa-playbook-scan", skillMd: "# Scan, edited\n" }]);
    // A text the page never showed is never sent.
    expect(changedTexts(texts, { "aa-playbook-dive": "x" })).toEqual([]);
  });

  it("counts the stored inputs a replay answers from, by tool, apart from the stage's own writes", () => {
    const input = (tool: string, stored: boolean) => ({
      callId: tool,
      server: "data",
      tool,
      input: {},
      stored,
      truncated: false,
    });
    expect(
      storedInputSummary([
        input("get_research_context", true),
        input("web_search", true),
        input("web_search", true),
        input("write_research_brief", false),
        input("complete_stage", false),
      ]),
    ).toEqual({
      stored: 3,
      writes: 2,
      byTool: [
        { tool: "get_research_context", count: 1 },
        { tool: "web_search", count: 2 },
      ],
    });
  });

  it("compares the old and new output row by row, marking what changed, and says when no replay ran", () => {
    const before = stage({});
    const rows = compareStages(before, null);
    expect(rows.map((r) => [r.label, r.before, r.after, r.changed])).toEqual([
      ["Ended", "completed (COMPLETED)", "not run yet", false],
      ["Cost", "0.0200 USDC", "not run yet", false],
      ["Model calls", "2 on scan-cheap", "not run yet", false],
      ["Tool calls", "0", "not run yet", false],
      ["Briefs", "SCAN accepted, SCAN refused", "not run yet", false],
      ["Record", "DONE, 1 candidate", "not run yet", false],
    ]);
    const after = stage({
      chargedUsdcE6: "18000",
      briefs: [{ briefId: "b3", kind: "SCAN", status: "accepted", body: {}, reasons: [], at: "" }],
      record: { outcome: "DONE", candidates: [], decision: { kind: "NO_CHANGE" } },
      toolCalls: [
        {
          callId: "c1",
          server: "data",
          tool: "web_search",
          input: {},
          status: "refused",
          errorCode: "NOT_STORED",
          chargeUsdcE6: "0",
          cacheHit: false,
          resultStored: false,
          resultTruncated: false,
          startedAt: "",
        },
      ],
    });
    const changed = compareStages(before, after);
    expect(changed.map((r) => [r.label, r.after, r.changed])).toEqual([
      ["Ended", "completed (COMPLETED)", false],
      ["Cost", "0.0180 USDC", true],
      ["Model calls", "2 on scan-cheap", false],
      ["Tool calls", "1 (1 refused)", true],
      ["Briefs", "SCAN accepted", true],
      ["Record", "DONE, NO_CHANGE", true],
    ]);
  });
});
