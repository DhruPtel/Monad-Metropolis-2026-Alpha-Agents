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
    { tool: "get_research_context", result: { cycle: { stage: "SCAN" } } },
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
      scope: "MARKET",
      token: null,
      symbol: null,
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
    // Truncated is as faithful as rounded: 81.56 supports "81" and "82", never "80".
    expect(numberTraces("81", new Set(["81.56"]), [81.56])).toBe(true);
    expect(numberTraces("82", new Set(["81.56"]), [81.56])).toBe(true);
    expect(numberTraces("80", new Set(["81.56"]), [81.56])).toBe(false);
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
    expect(check.reasons.join(" ")).toMatch(
      /changes\[0\]\.text: 900 million, 12\.5 does not appear/,
    );
    expect(validateBrief(scan(), ctx).ok).toBe(true);
  });

  it("accepts a large figure written at a scale when a result rounds to it, and refuses one that does not", () => {
    const ok = validateBrief(
      scan({
        summary: "Monad TVL is 1.004B (1,004 million, 1004000 thousand) after a -6.8% week.",
      }),
      ctx,
    );
    expect(ok).toEqual({ ok: true, reasons: [] });
    const bad = validateBrief(scan({ summary: "Monad TVL is 1.2B after a -6.8% week." }), ctx);
    expect(bad.reasons.join(" ")).toContain("1.2B does not appear");
    // A scale after a range applies to both ends.
    expect(
      validateBrief(scan({ summary: "TVL moved within 1,004-1,004M after a -6.8% week." }), ctx)
        .reasons,
    ).toEqual([]);
    const range = validateBrief(scan({ summary: "TVL ranged 995-1004M after a -6.8% week." }), ctx);
    expect(range.reasons.join(" ")).toContain("995 (in 995-1004M) does not appear");
  });

  it("never reads a million as a month: 52.7M is checked as a figure", () => {
    const check = validateBrief(scan({ summary: "DEX volume was 52.7M after a -6.8% week." }), ctx);
    expect(check.reasons.join(" ")).toContain("52.7M does not appear");
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
          scope: "MARKET",
          token: null,
          symbol: null,
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
    // The full MCP name of a tool the cycle called is the same source.
    const named = scan({
      changes: [
        {
          text: "MON fell -3.2%.",
          class: "market",
          confidence: "low",
          sources: ["mcp__data__market_snapshot"],
        },
      ],
    });
    expect(validateBrief(named, ctx)).toEqual({ ok: true, reasons: [] });
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
      token: null,
      symbol: null,
      question: "Is the outflow rotation or exit?",
      whatItIs: "Monad's DEX liquidity as a whole.",
      whyNow: "A large weekly fall.",
      fundamentals: {
        usage: null,
        feesRevenueVolume: null,
        tvl: null,
        holdersLiquidity: null,
        supplyEmissions: null,
        control: null,
        catalysts: null,
        relativeValue: null,
      },
      evidenceFor: [],
      evidenceAgainst: [],
      risks: ["A price move read as an outflow."],
      freshness: "All figures from today.",
      screen: { verdict: "NOT_RUN", summary: "No token to screen." },
      fairWeightBps: null,
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
      portfolioView: "Nothing to change.",
      evidenceStrength: "weak",
      positions: [],
    });
    expect(rationale.ok ? "" : rationale.reasons.join(" ")).toContain("reasonCode");
  });

  it("refuses a claim whose class its sources cannot give, and names what they give (F-U8)", () => {
    const claim = (cls: "onchain" | "market" | "primary" | "news" | "social", sources: string[]) =>
      scan({
        changes: [
          { text: "Monad TVL is 1,004,000,000 USD.", class: cls, confidence: "high", sources },
        ],
      });
    expect(validateBrief(claim("market", ["market_snapshot"]), ctx).ok).toBe(true);
    const tagged = validateBrief(claim("onchain", ["market_snapshot"]), ctx);
    expect(tagged.ok).toBe(false);
    expect(tagged.reasons[0]).toContain(
      'changes[0]: class "onchain" is not what its sources give (market_snapshot: market)',
    );
    // A page is primary or news, never onchain; a mixed set is fine when one source gives the class.
    expect(validateBrief(claim("onchain", ["https://news.example/monad-tvl"]), ctx).ok).toBe(false);
    expect(validateBrief(claim("news", ["https://news.example/monad-tvl"]), ctx).ok).toBe(true);
    expect(validateBrief(claim("primary", ["https://blog.monad.xyz/update"]), ctx).ok).toBe(true);
    expect(
      validateBrief(
        claim("onchain", ["https://news.example/monad-tvl", "mcp__data__web_search"]),
        ctx,
      ).ok,
    ).toBe(false);
    // The platform's own records relay every class, so they constrain nothing.
    expect(validateBrief(claim("onchain", ["get_research_context"]), ctx).ok).toBe(true);
  });

  it("parses the Dive's per-token brief: a fair weight needs a thesis and a passing screen (F-U8)", () => {
    const wbtc = "0x0555e30da8f98308edb960aa94c0db47230d2b9c";
    const theme = (over: Record<string, unknown> = {}) =>
      parseBrief({
        kind: "THEME",
        themeCode: "WBTC_ADD",
        token: wbtc,
        symbol: "WBTC",
        question: "Does WBTC earn a place in this account?",
        whatItIs: "Wrapped bitcoin on Monad.",
        whyNow: "Its pool deepened this week.",
        fundamentals: {
          usage: null,
          feesRevenueVolume: null,
          tvl: null,
          holdersLiquidity: {
            text: "The deepest pool holds enough for this account's legs.",
            class: "onchain",
            confidence: "medium",
            sources: ["find_pools"],
            asOf: "today",
          },
          supplyEmissions: null,
          control: null,
          catalysts: null,
          relativeValue: null,
        },
        evidenceFor: [],
        evidenceAgainst: [],
        risks: ["Bridge risk on the wrapped supply."],
        freshness: "Pool figures are from today.",
        screen: { verdict: "PASSED", summary: "Every check passed." },
        thesis: {
          statement: "WBTC tracks bitcoin while its pool stays deep.",
          killCriterion: "The pool's liquidity halves.",
          horizonHours: 240,
          confidence: "medium",
        },
        noThesisReason: null,
        fairWeightBps: 1_500,
        weakestLink: "One pool carries the depth.",
        forThePlan: "A small position within the envelope.",
        ...over,
      });
    expect(theme().ok).toBe(true);
    const refused = theme({
      screen: { verdict: "REFUSED", summary: "The sell simulation failed." },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reasons.join(" ")).toContain("safety screen passed");
    const market = theme({
      token: null,
      symbol: null,
      screen: { verdict: "PASSED", summary: "n/a" },
    });
    expect(market.ok).toBe(false);
    if (!market.ok) expect(market.reasons.join(" ")).toContain("market theme has no token");
    const noThesis = theme({ thesis: null, noThesisReason: "Too thin.", fairWeightBps: 1_000 });
    expect(noThesis.ok).toBe(false);
    if (!noThesis.ok) expect(noThesis.reasons.join(" ")).toContain("needs a thesis");
    expect(theme({ thesis: null, noThesisReason: "Too thin.", fairWeightBps: null }).ok).toBe(true);
  });

  it("parses the Zoom out's rationale: weak evidence never proposes, and NO_CHANGE holds every position (F-U8)", () => {
    const wbtc = "0x0555e30da8f98308edb960aa94c0db47230d2b9c";
    const rationale = (over: Record<string, unknown> = {}) =>
      parseBrief({
        kind: "RATIONALE",
        decision: "PROPOSE",
        reasonCode: null,
        themeCodes: ["WBTC_ADD"],
        points: [],
        whatWouldChangeIt: "The pool thinning out.",
        portfolioView: "The account is all cash against a Balanced goal; one position fits.",
        evidenceStrength: "mixed",
        positions: [
          {
            token: wbtc,
            symbol: "WBTC",
            action: "ADD",
            themeCode: "WBTC_ADD",
            reason: "Deep pool.",
          },
        ],
        ...over,
      });
    expect(rationale().ok).toBe(true);
    const weak = rationale({ evidenceStrength: "weak" });
    expect(weak.ok).toBe(false);
    if (!weak.ok) expect(weak.reasons.join(" ")).toContain("weak evidence cannot carry a proposal");
    const held = rationale({ decision: "NO_CHANGE", reasonCode: "EVIDENCE_THIN" });
    expect(held.ok).toBe(false);
    if (!held.ok) expect(held.reasons.join(" ")).toContain("holds every position");
    expect(
      rationale({
        decision: "NO_CHANGE",
        reasonCode: "EVIDENCE_THIN",
        evidenceStrength: "weak",
        positions: [
          { token: wbtc, symbol: "WBTC", action: "HOLD", themeCode: null, reason: "Nothing new." },
        ],
      }).ok,
    ).toBe(true);
  });
});
