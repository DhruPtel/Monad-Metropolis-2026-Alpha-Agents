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

/** Where a claim's evidence comes from, strongest first (F-U8: the source hierarchy). */
export const CLAIM_CLASSES = ["onchain", "market", "primary", "news", "social"] as const;
export type ClaimClass = (typeof CLAIM_CLASSES)[number];

export const Claim = z.strictObject({
  text: text(240),
  class: z.enum(CLAIM_CLASSES),
  confidence: z.enum(["high", "medium", "low"]),
  sources: z.array(SourceRef).min(1).max(4),
  /** F-U8: when the figure or statement is from, as the tool gave it: a date, or an age such as "3 days old". */
  asOf: z.string().trim().min(1).max(40).optional(),
});
export type Claim = z.infer<typeof Claim>;

const TokenAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "a token's address");
const symbol = z.string().trim().min(1).max(32);

/** What a Scan theme is about: a token worth a Dive, a held position to review, or a market-wide change. */
export const THEME_SCOPES = ["TOKEN", "POSITION", "MARKET"] as const;
export type ThemeScope = (typeof THEME_SCOPES)[number];

export const ScanThemeSchema = z
  .strictObject({
    code: themeCode,
    materiality: z.enum(["high", "medium", "low"]),
    scope: z.enum(THEME_SCOPES),
    token: TokenAddress.nullable(),
    symbol: symbol.nullable(),
    whyNow: text(240),
    sources: z.array(SourceRef).min(1).max(4),
  })
  .refine((t) => (t.scope === "MARKET") === (t.token === null), {
    message: "a TOKEN or POSITION theme names its token's address, and a MARKET theme has none",
    path: ["token"],
  });
export type ScanThemeJson = z.infer<typeof ScanThemeSchema>;

export const ScanBrief = z.strictObject({
  kind: z.literal("SCAN"),
  summary: text(400),
  changes: z.array(Claim).max(6),
  themes: z.array(ScanThemeSchema).max(4),
  quiet: z.boolean(),
  dataGaps: z.array(text(160)).max(5),
});

/**
 * The fundamental analysis checklist of a Dive (F-U8), each item a finding
 * with its source class, confidence and age, or null when no tool reached it
 * (the brief's dataGaps or freshness says why).
 */
export const FUNDAMENTALS = [
  "usage",
  "feesRevenueVolume",
  "tvl",
  "holdersLiquidity",
  "supplyEmissions",
  "control",
  "catalysts",
  "relativeValue",
] as const;
export type Fundamental = (typeof FUNDAMENTALS)[number];

const Finding = Claim.nullable();
export const Fundamentals = z.strictObject({
  usage: Finding,
  feesRevenueVolume: Finding,
  tvl: Finding,
  holdersLiquidity: Finding,
  supplyEmissions: Finding,
  control: Finding,
  catalysts: Finding,
  relativeValue: Finding,
});
export type Fundamentals = z.infer<typeof Fundamentals>;

/** The Dive's brief per token (F-U8): what it is, why now, the checklist, the evidence, the risks, the screen and the thesis. */
export const ThemeBrief = z
  .strictObject({
    kind: z.literal("THEME"),
    themeCode,
    /** The token the Dive is about (its address and symbol); both null for a market-wide theme. */
    token: TokenAddress.nullable(),
    symbol: symbol.nullable(),
    question: text(240),
    whatItIs: text(300),
    whyNow: text(300),
    fundamentals: Fundamentals,
    evidenceFor: z.array(Claim).max(6),
    evidenceAgainst: z.array(Claim).max(6),
    risks: z.array(text(200)).min(1).max(6),
    freshness: text(300),
    /** The token safety screen's verdict as screen_token gave it, with what its checks said. */
    screen: z.strictObject({
      verdict: z.enum(["PASSED", "REFUSED", "NOT_RUN"]),
      summary: text(300),
    }),
    thesis: z
      .strictObject({
        statement: text(300),
        killCriterion: text(240),
        horizonHours: z.int().min(1).max(720),
        confidence: z.enum(["high", "medium", "low"]),
      })
      .nullable(),
    noThesisReason: text(300).nullable(),
    /** A fair position weight given the pool's depth and the envelope; the Test caps it, the runner sizes legs. */
    fairWeightBps: z.int().min(0).max(10_000).nullable(),
    weakestLink: text(240),
    forThePlan: text(300),
  })
  .refine((b) => (b.thesis === null) !== (b.noThesisReason === null), {
    message: "give either a thesis or a noThesisReason, not both and not neither",
    path: ["thesis"],
  })
  .refine((b) => b.thesis !== null || b.fairWeightBps === null, {
    message: "a fair weight needs a thesis; without one it is null",
    path: ["fairWeightBps"],
  })
  .refine((b) => !((b.fairWeightBps ?? 0) > 0 && b.screen.verdict !== "PASSED"), {
    message: "a fair weight above 0 needs a token whose safety screen passed",
    path: ["fairWeightBps"],
  })
  .refine((b) => b.token !== null || b.screen.verdict === "NOT_RUN", {
    message: "a market theme has no token to screen; its screen verdict is NOT_RUN",
    path: ["screen", "verdict"],
  })
  .refine((b) => (b.token === null) === (b.symbol === null), {
    message: "a token theme names the token's address and symbol; a market theme has neither",
    path: ["symbol"],
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

/** What the Zoom out decides for one position (F-U8, FINAL_PLAN 0.7). */
export const POSITION_ACTIONS = ["ADD", "HOLD", "TRIM", "EXIT"] as const;
export type PositionAction = (typeof POSITION_ACTIONS)[number];

export const PositionCall = z.strictObject({
  token: TokenAddress,
  symbol,
  action: z.enum(POSITION_ACTIONS),
  /** The Dive's theme the call rests on; null for a hold with nothing new. */
  themeCode: themeCode.nullable(),
  reason: text(200),
});
export type PositionCall = z.infer<typeof PositionCall>;

export const EVIDENCE_STRENGTHS = ["strong", "mixed", "weak"] as const;

export const RationaleBrief = z
  .strictObject({
    kind: z.literal("RATIONALE"),
    decision: z.enum(["NO_CHANGE", "PROPOSE"]),
    reasonCode: z.enum(NO_CHANGE_REASONS).nullable(),
    themeCodes: z.array(themeCode).max(4),
    points: z.array(Claim).max(5),
    whatWouldChangeIt: text(240),
    /** F-U8: the whole portfolio weighed against the owner's goal, in plain words. */
    portfolioView: text(400),
    /** How strong the cycle's evidence is overall; weak evidence never carries a proposal. */
    evidenceStrength: z.enum(EVIDENCE_STRENGTHS),
    /** One call per position held or proposed: add, hold, trim or exit. */
    positions: z.array(PositionCall).max(12),
  })
  .refine((b) => (b.decision === "NO_CHANGE") === (b.reasonCode !== null), {
    message: "a NO_CHANGE decision needs a reasonCode, and a PROPOSE decision has none",
    path: ["reasonCode"],
  })
  .refine((b) => b.decision === "PROPOSE" || b.positions.every((p) => p.action === "HOLD"), {
    message:
      "a NO_CHANGE decision holds every position; an ADD, TRIM or EXIT needs a PROPOSE decision",
    path: ["positions"],
  })
  .refine((b) => !(b.evidenceStrength === "weak" && b.decision === "PROPOSE"), {
    message:
      "weak evidence cannot carry a proposal: decide NO_CHANGE with EVIDENCE_THIN and say what would change it",
    path: ["evidenceStrength"],
  })
  .refine(
    (b) => new Set(b.positions.map((p) => p.token.toLowerCase())).size === b.positions.length,
    { message: "one call per token", path: ["positions"] },
  );

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
    /** F-U8: the token a Dive is about, from the Scan's theme; null for a market theme or another stage. */
    token: z.strictObject({ address: z.string(), symbol: z.string().nullable() }).nullable(),
    briefsToWrite: z.array(z.enum(BRIEF_KINDS)),
  }),
  plan: z
    .strictObject({
      template: z.string(),
      /** The two-asset plan's figures, or a target portfolio's positions and cash target (F-U6). */
      params: z.record(z.string(), z.unknown()),
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
const usdcAmount = z.string().regex(/^\d+(\.\d{1,6})?$/, "a USDC amount");

/** F-U6 (D-344): a target portfolio as the Zoom out drafts it, checked by the Test stage v2. */
export const PortfolioPositionInput = z.strictObject({
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "a token's address"),
  targetWeightBps: bps,
  bandBps: bps,
  thesisId: z.string().min(1).max(64),
  exit: z.strictObject({
    killCriterion: z.string().min(1).max(280),
    recheckAt: z.string().min(1).max(40),
    trimAboveBps: bps.optional(),
  }),
});

// A plain union: two PROPOSE shapes share the kind and differ by template (F-U6).
export const ZoomOutDecision = z.union([
  z.strictObject({ kind: z.literal("NO_CHANGE"), reasonCode: z.enum(NO_CHANGE_REASONS) }),
  z.strictObject({
    kind: z.literal("PROPOSE"),
    template: z.literal("rebalance_bands@1"),
    params: z.strictObject({
      targetWmonBps: bps,
      bandHalfWidthBps: bps,
      minTradeUsdc: usdcAmount,
      volatilityBrakeBps: z.int().min(0).max(100_000),
      costHurdleBps: bps,
      maxLegBps: bps,
    }),
  }),
  z.strictObject({
    kind: z.literal("PROPOSE"),
    template: z.literal("target_portfolio@1"),
    params: z.strictObject({
      positions: z.array(PortfolioPositionInput).max(12),
      cashTargetBps: bps,
      minTradeUsdc: usdcAmount,
      volatilityBrakeBps: z.int().min(0).max(100_000),
      costHurdleBps: bps,
      maxLegBps: bps,
    }),
  }),
]);
export type ZoomOutDecision = z.infer<typeof ZoomOutDecision>;
