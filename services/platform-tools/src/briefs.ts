import { z } from "zod";

/**
 * Typed research briefs (P3-U4, D-284): the only research an owner ever reads.
 * Each stage writes its brief through `write_research_brief` with bounded
 * fields; the platform then checks every number against the tool results the
 * cycle recorded, every URL against the pages and links it retrieved, and the
 * text against the mounted skills and the cycle's canary, before it is stored
 * or shown. Raw stage notes (`write_thesis`) stay platform-only.
 */
export const BRIEF_KINDS = ["SCAN", "THEME", "CHALLENGE", "OVERVIEW", "RATIONALE"] as const;
export type BriefKind = (typeof BRIEF_KINDS)[number];

/** Which brief each stage writes: the Zoom out writes its rationale, and an overview in an activation. */
export const STAGE_BRIEFS = {
  SCAN: ["SCAN"],
  DIVE: ["THEME"],
  CHALLENGE: ["CHALLENGE"],
  ZOOM_OUT: ["RATIONALE", "OVERVIEW"],
  TEST: [],
} as const satisfies Record<string, readonly BriefKind[]>;

/** The brief a stage must have written before complete_stage accepts it. */
export const REQUIRED_BRIEF = {
  SCAN: "SCAN",
  DIVE: "THEME",
  CHALLENGE: "CHALLENGE",
  ZOOM_OUT: "RATIONALE",
} as const;

export const themeCode = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{2,39}$/, "an upper-case theme code of 3 to 40 characters");
const text = (max: number) => z.string().trim().min(3).max(max);

/**
 * Where a claim comes from: a URL this cycle retrieved (a page it read, or a
 * link a search returned), or the name of a tool this cycle called, such as
 * `market_snapshot`.
 */
export const SourceRef = z.string().trim().min(3).max(2_048);

export const Claim = z.strictObject({
  text: text(240),
  class: z.enum(["market", "onchain", "primary", "news", "social"]),
  confidence: z.enum(["high", "medium", "low"]),
  sources: z.array(SourceRef).min(1).max(4),
});
export type Claim = z.infer<typeof Claim>;

export const ScanBrief = z.strictObject({
  kind: z.literal("SCAN"),
  summary: text(400),
  changes: z.array(Claim).max(6),
  themes: z
    .array(
      z.strictObject({
        code: themeCode,
        materiality: z.enum(["high", "medium", "low"]),
        asset: z.enum(["USDC", "WMON"]),
        whyNow: text(240),
        sources: z.array(SourceRef).min(1).max(4),
      }),
    )
    .max(4),
  quiet: z.boolean(),
  dataGaps: z.array(text(160)).max(5),
});

export const ThemeBrief = z
  .strictObject({
    kind: z.literal("THEME"),
    themeCode,
    question: text(240),
    evidenceFor: z.array(Claim).max(6),
    evidenceAgainst: z.array(Claim).max(6),
    freshness: text(300),
    thesis: z
      .strictObject({
        statement: text(300),
        killCriterion: text(240),
        horizonHours: z.int().min(1).max(720),
        confidence: z.enum(["high", "medium", "low"]),
      })
      .nullable(),
    noThesisReason: text(300).nullable(),
    weakestLink: text(240),
    forThePlan: text(300),
  })
  .refine((b) => (b.thesis === null) !== (b.noThesisReason === null), {
    message: "give either a thesis or a noThesisReason, not both and not neither",
    path: ["thesis"],
  });

export const ChallengeBrief = z.strictObject({
  kind: z.literal("CHALLENGE"),
  themeCode,
  objections: z
    .array(
      z.strictObject({
        rank: z.int().min(1).max(5),
        text: text(280),
        severity: z.enum(["high", "medium", "low"]),
        sources: z.array(SourceRef).max(4),
      }),
    )
    .min(1)
    .max(5),
  verdict: z.enum(["STANDS", "WEAKENED", "REJECTED"]),
  summary: text(300),
});

export const OverviewBrief = z.strictObject({
  kind: z.literal("OVERVIEW"),
  summary: text(600),
  points: z.array(Claim).min(1).max(6),
});

/** "Why the plan did not change" codes (BUILD_PLAN Phase 3; P3-U6's evaluator adds its own). */
export const NO_CHANGE_REASONS = [
  "NO_MATERIAL_CHANGE",
  "EVIDENCE_THIN",
  "CHALLENGE_REJECTED",
  "COOLDOWN",
  "COST_HURDLE",
  "LIMITS_BIND",
  "BUDGET_SHORT",
] as const;

export const RationaleBrief = z
  .strictObject({
    kind: z.literal("RATIONALE"),
    decision: z.enum(["NO_CHANGE", "PROPOSE"]),
    reasonCode: z.enum(NO_CHANGE_REASONS).nullable(),
    themeCodes: z.array(themeCode).max(4),
    points: z.array(Claim).max(5),
    whatWouldChangeIt: text(240),
  })
  .refine((b) => (b.decision === "NO_CHANGE") === (b.reasonCode !== null), {
    message: "a NO_CHANGE decision needs a reasonCode, and a PROPOSE decision has none",
    path: ["reasonCode"],
  });

export const ResearchBrief = z.union([
  ScanBrief,
  ThemeBrief,
  ChallengeBrief,
  OverviewBrief,
  RationaleBrief,
]);
export type ResearchBrief = z.infer<typeof ResearchBrief>;

/** The tool's input: one brief, its shape chosen by `kind`, so errors name the right fields. */
export const WriteResearchBriefInput = z.strictObject({
  brief: z.discriminatedUnion("kind", [
    ScanBrief,
    ThemeBrief,
    ChallengeBrief,
    OverviewBrief,
    RationaleBrief,
  ]),
});
export type WriteResearchBriefInput = z.infer<typeof WriteResearchBriefInput>;

export const BRIEF_SCHEMAS = {
  SCAN: ScanBrief,
  THEME: ThemeBrief,
  CHALLENGE: ChallengeBrief,
  OVERVIEW: OverviewBrief,
  RATIONALE: RationaleBrief,
} as const;

/** Parses a brief by its kind; the issues are worded so the agent can fix them. */
export function parseBrief(
  raw: Record<string, unknown>,
): { ok: true; brief: ResearchBrief } | { ok: false; reasons: string[] } {
  const kind = raw.kind;
  if (typeof kind !== "string" || !(BRIEF_KINDS as readonly string[]).includes(kind))
    return { ok: false, reasons: [`brief.kind must be one of ${BRIEF_KINDS.join(", ")}`] };
  const parsed = BRIEF_SCHEMAS[kind as BriefKind].safeParse(raw);
  if (parsed.success) return { ok: true, brief: parsed.data };
  return {
    ok: false,
    reasons: parsed.error.issues
      .slice(0, 8)
      .map((i) => `${["brief", ...i.path].join(".")}: ${i.message}`),
  };
}

export const WriteResearchBriefOutput = z.strictObject({
  briefId: z.string().regex(/^brief-[0-9a-f-]{36}$/),
  kind: z.enum(BRIEF_KINDS),
  accepted: z.literal(true),
});
export type WriteResearchBriefOutput = z.infer<typeof WriteResearchBriefOutput>;

export const GetResearchContextInput = z.strictObject({});

const bps = z.int().min(0).max(10_000);

/** One bounded digest of what this stage needs (D-287), and nothing from another stage's session. */
export const GetResearchContextOutput = z.strictObject({
  cycle: z.strictObject({
    kind: z.enum(["ROUTINE", "TRIGGERED", "ACTIVATION"]),
    stage: z.enum(["SCAN", "DIVE", "CHALLENGE", "TEST", "ZOOM_OUT"]),
    themeCode: themeCode.nullable(),
    briefsToWrite: z.array(z.enum(BRIEF_KINDS)),
  }),
  plan: z
    .strictObject({
      template: z.string(),
      params: z.record(z.string(), z.union([z.string(), z.number()])),
      setAt: z.string(),
    })
    .nullable(),
  latestOverview: z
    .strictObject({ at: z.string(), summary: z.string(), points: z.array(z.string()) })
    .nullable(),
  openThemes: z.array(
    z.strictObject({
      code: themeCode,
      materiality: z.string(),
      lastStage: z.string(),
      verdict: z.string().nullable(),
      at: z.string(),
    }),
  ),
  /** Briefs this cycle has accepted that this stage builds on (typed records, never sessions). */
  fromThisCycle: z.array(
    z.strictObject({ kind: z.enum(BRIEF_KINDS), body: z.record(z.string(), z.unknown()) }),
  ),
  /** For the Zoom out: what the deterministic Test found the plan may be changed within. */
  testEnvelope: z.record(z.string(), z.unknown()).nullable(),
  lastStages: z.array(
    z.strictObject({
      stage: z.string(),
      status: z.string(),
      stopReason: z.string().nullable(),
      at: z.string(),
    }),
  ),
  rules: z.array(z.string()),
});
export type GetResearchContextOutput = z.infer<typeof GetResearchContextOutput>;

/** A Zoom out's decision in complete_stage (P3-U4; P3-U6 turns a proposal into a plan card). */
export const ZoomOutDecision = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("NO_CHANGE"), reasonCode: z.enum(NO_CHANGE_REASONS) }),
  z.strictObject({
    kind: z.literal("PROPOSE"),
    template: z.literal("rebalance_bands@1"),
    params: z.strictObject({
      targetWmonBps: bps,
      bandHalfWidthBps: bps,
      minTradeUsdc: z.string().regex(/^\d+(\.\d{1,6})?$/, "a USDC amount"),
      volatilityBrakeBps: z.int().min(0).max(100_000),
      costHurdleBps: bps,
      maxLegBps: bps,
    }),
  }),
]);
export type ZoomOutDecision = z.infer<typeof ZoomOutDecision>;
