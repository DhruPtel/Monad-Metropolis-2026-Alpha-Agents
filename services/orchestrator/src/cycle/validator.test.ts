import { type ResearchBrief, parseBrief } from "@alpha-agents/platform-tools";
import { describe, expect, it } from "vitest";
import { builtinSet } from "../hermes/materialize.ts";
import { numberTraces, skillRuns, validateBrief } from "./validator.ts";

const runs = skillRuns(
  builtinSet().packages.flatMap((p) =>
    p.files.filter((f) => f.path.endsWith(".md")).map((f) => f.bytes.toString("utf8")),
  ),
);

const ctx = {
  results: [
    {
      tool: "market_snapshot",
      result: {
        mon: { priceUsd: 0.024095, change24hPct: -3.2145 },
        monadTvl: { usd: 1004000000, change7dPct: -6.8 },
        asOf: "2026-10-09T12:00:00.000Z",
      },
    },
    {
      tool: "web_search",
      result: {
        results: [{ url: "https://news.example/monad-tvl", title: "TVL", snippet: "down 7%" }],
      },
    },
    { tool: "read_url", result: { url: "https://blog.monad.xyz/update", content: "text" } },
  ],
  urls: ["https://news.example/monad-tvl", "https://blog.monad.xyz/update"],
  skillRuns: runs,
  canary: "AACANARY-0123456789abcdef",
};

const scan = (over: Partial<Extract<ResearchBrief, { kind: "SCAN" }>> = {}): ResearchBrief => ({
  kind: "SCAN",
  summary: "MON fell -3.2145% over the 24-hour window while Monad TVL moved -6.8% over 7d.",
  changes: [
    {
      text: "Monad TVL is 1,004,000,000 USD, down -6.8% in seven days.",
      class: "market",
      confidence: "high",
      sources: ["market_snapshot"],
    },
  ],
  themes: [
    {
      code: "TVL_OUTFLOW",
      materiality: "high",
      asset: "WMON",
      whyNow: "Outflows reported at https://news.example/monad-tvl match the snapshot.",
      sources: ["https://news.example/monad-tvl", "market_snapshot"],
    },
  ],
  quiet: false,
  dataGaps: [],
  ...over,
});

describe("the brief validator (D-284, P3-U4)", () => {
  it("accepts a brief whose numbers, URLs and sources all come from this cycle", () => {
    expect(validateBrief(scan(), ctx)).toEqual({ ok: true, reasons: [] });
  });

  it("accepts a figure rounded from a result, never one moved past rounding", () => {
    const known = new Set(["3.2145", "0.024095"]);
    const values = [3.2145, 0.024095];
    expect(numberTraces("3.21", known, values)).toBe(true);
    expect(numberTraces("3.2", known, values)).toBe(true);
    expect(numberTraces("3", known, values)).toBe(true);
    expect(numberTraces("3.3", known, values)).toBe(false);
    expect(numberTraces("0.0241", known, values)).toBe(true);
    expect(numberTraces("0.025", known, values)).toBe(false);
  });

  it("refuses an invented number and says which field holds it, then accepts the corrected brief", () => {
    const bad = scan({
      changes: [
        {
          text: "Monad TVL fell 12.5% this week to 900 million.",
          class: "market",
          confidence: "high",
          sources: ["market_snapshot"],
        },
      ],
    });
    const check = validateBrief(bad, ctx);
    expect(check.ok).toBe(false);
    expect(check.reasons.join(" ")).toMatch(/changes\[0\]\.text: 12\.5, 900 does not appear/);
    expect(validateBrief(scan(), ctx).ok).toBe(true);
  });

  it("ignores time windows such as 24-hour and 7d, which are not facts", () => {
    const b = scan({ summary: "Over 48 hours and 30-day windows MON fell -3.2%." });
    expect(validateBrief(b, ctx)).toEqual({ ok: true, reasons: [] });
  });

  it("refuses a URL the cycle never retrieved, in text and in sources", () => {
    const b = scan({
      themes: [
        {
          code: "TVL_OUTFLOW",
          materiality: "high",
          asset: "WMON",
          whyNow: "See https://evil.example/pump for details.",
          sources: ["https://evil.example/pump"],
        },
      ],
    });
    const check = validateBrief(b, ctx);
    expect(check.ok).toBe(false);
    expect(check.reasons.join(" ")).toContain(
      "themes[0].whyNow: https://evil.example/pump is not a URL",
    );
    expect(check.reasons.join(" ")).toContain("themes[0].sources[0]");
  });

  it("refuses a source that names a tool the cycle never called", () => {
    const check = validateBrief(
      scan({
        changes: [
          { text: "MON fell -3.2%.", class: "market", confidence: "low", sources: ["coingecko"] },
        ],
      }),
      ctx,
    );
    expect(check.reasons.join(" ")).toMatch(
      /"coingecko" is neither a URL this cycle retrieved nor a tool/,
    );
  });

  it("refuses eight words copied from a mounted skill, but not the skill's single terms", () => {
    const skill = builtinSet().packages.find((p) => p.manifest.id === "playbook-scan");
    const md = skill?.files.find((f) => f.path === "SKILL.md")?.bytes.toString("utf8") ?? "";
    // Eight consecutive words of the Scan playbook's opening paragraph.
    const opening = md.split("\n").find((l) => l.startsWith("The Scan is")) ?? "";
    const words = opening.split(/\s+/).slice(0, 10);
    expect(words).toHaveLength(10);
    const copied = scan({ summary: `${words.join(" ")} and MON fell -3.2%.` });
    const check = validateBrief(copied, ctx);
    expect(check.ok).toBe(false);
    expect(check.reasons.join(" ")).toContain("repeats a skill's wording");
    expect(
      validateBrief(scan({ summary: "A wide, cheap look at what changed: MON fell -3.2%." }), ctx)
        .ok,
    ).toBe(true);
  });

  it("refuses the cycle's canary, or any platform marker, anywhere in the brief", () => {
    for (const marker of [ctx.canary, "AACANARY-ffffffffffffffff"]) {
      const check = validateBrief(scan({ summary: `Note ${marker} and MON fell -3.2%.` }), ctx);
      expect(check.ok).toBe(false);
      expect(check.reasons.join(" ")).toContain("internal marker");
    }
  });

  it("refuses a brief outside its schema: too long, a thesis and no-thesis together, no reason code", () => {
    expect(parseBrief({ ...scan(), summary: "x".repeat(401) })).toMatchObject({ ok: false });
    const theme = {
      kind: "THEME",
      themeCode: "TVL_OUTFLOW",
      question: "Is the outflow rotation or exit?",
      evidenceFor: [],
      evidenceAgainst: [],
      freshness: "All figures from today.",
      thesis: {
        statement: "TVL keeps falling.",
        killCriterion: "TVL rises.",
        horizonHours: 72,
        confidence: "low",
      },
      noThesisReason: "Evidence is thin.",
      weakestLink: "One source.",
      forThePlan: "None.",
    };
    const both = parseBrief(theme);
    expect(both.ok).toBe(false);
    expect(both.ok ? "" : both.reasons.join(" ")).toContain("either a thesis or a noThesisReason");
    expect(parseBrief({ ...theme, noThesisReason: null }).ok).toBe(true);
    const rationale = parseBrief({
      kind: "RATIONALE",
      decision: "NO_CHANGE",
      reasonCode: null,
      themeCodes: [],
      points: [],
      whatWouldChangeIt: "A thesis that survives the Challenge.",
    });
    expect(rationale.ok ? "" : rationale.reasons.join(" ")).toContain("reasonCode");
  });
});
