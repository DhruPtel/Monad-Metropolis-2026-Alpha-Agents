/**
 * The discovery loop's stages as data (P3-U4, D-093, D-285, A-51): which model
 * each stage runs on, its work caps and its ceiling, which themes earn a Dive,
 * and whether the day's research budget lets a stage start. Everything here is
 * pure, so each rule is tested on its own.
 */
export const STAGES = ["SCAN", "DIVE", "CHALLENGE", "TEST", "ZOOM_OUT"] as const;
export type Stage = (typeof STAGES)[number];

export const CYCLE_KINDS = ["ROUTINE", "TRIGGERED", "ACTIVATION"] as const;
export type CycleKind = (typeof CYCLE_KINDS)[number];

/** The Scan's model for every agent (D-285); the other model stages use the goal's reasoning model. */
export const SCAN_MODEL = "scan-cheap";
export const REASONING_ALIASES = ["research-strong", "research-deep"] as const;
export type ReasoningAlias = (typeof REASONING_ALIASES)[number];

/** Every alias a cycle's runs may use, so the rendered provider lists them all. */
export const CYCLE_MODEL_ALIASES = [SCAN_MODEL, ...REASONING_ALIASES] as const;

export function isReasoningAlias(alias: string): alias is ReasoningAlias {
  return (REASONING_ALIASES as readonly string[]).includes(alias);
}

/** The model a stage runs on; null for the deterministic Test (D-282). */
export function stageModel(stage: Stage, reasoning: ReasoningAlias): string | null {
  if (stage === "TEST") return null;
  return stage === "SCAN" ? SCAN_MODEL : reasoning;
}

export interface StageCaps {
  /** Model calls (Hermes turns) the stage may make. */
  readonly turns: number;
  /** Paid data calls; a cached answer is free and does not count (D-322). */
  readonly paidCalls: number;
  /** Fresh tokens across the stage's model calls: input not read from the cache, plus output (A-59). */
  readonly tokens: number;
  /** The orchestrator's deadline for the stage's run. */
  readonly seconds: number;
}

const NO_CAPS: StageCaps = { turns: 0, paidCalls: 0, tokens: 0, seconds: 0 };

/**
 * Caps per stage (A-51; tokens from A-59). An activation cycle's Scan is the
 * wide Scan of the sweep. Prompt caching makes repeated context cheap, so the
 * token caps bound runaway loops rather than normal work.
 */
export function stageCaps(stage: Stage, kind: CycleKind): StageCaps {
  switch (stage) {
    case "SCAN":
      return kind === "ACTIVATION"
        ? { turns: 16, paidCalls: 10, tokens: 450_000, seconds: 8 * 60 }
        : { turns: 10, paidCalls: 5, tokens: 300_000, seconds: 5 * 60 };
    case "DIVE":
      return { turns: 16, paidCalls: 8, tokens: 600_000, seconds: 10 * 60 };
    case "CHALLENGE":
      return { turns: 6, paidCalls: 2, tokens: 200_000, seconds: 4 * 60 };
    case "ZOOM_OUT":
      return { turns: 10, paidCalls: 2, tokens: 350_000, seconds: 6 * 60 };
    case "TEST":
      return NO_CAPS;
  }
}

const usdc = (whole: number) => BigInt(Math.round(whole * 1_000_000));

/**
 * The most a stage may charge to credits (A-51, D-298), shown before it runs.
 * Opus 5.5 (research-deep) doubles the reasoning stages; the Scan runs on the
 * cheap model either way; the Test is free.
 */
export function stageCeilingUsdcE6(
  stage: Stage,
  kind: CycleKind,
  reasoning: ReasoningAlias,
): bigint {
  const deep = reasoning === "research-deep" ? 2 : 1;
  switch (stage) {
    case "SCAN":
      return usdc(kind === "ACTIVATION" ? 0.5 : 0.3);
    case "DIVE":
      return usdc(1.2 * deep);
    case "CHALLENGE":
      return usdc(0.3 * deep);
    case "ZOOM_OUT":
      return usdc(0.6 * deep);
    case "TEST":
      return 0n;
  }
}

/** The largest turn cap and deadline of a cycle's stages, for the cycle's Hermes config. */
export function cycleEnvelope(kind: CycleKind): { maxTurns: number; runBudgetSeconds: number } {
  const caps = STAGES.map((s) => stageCaps(s, kind));
  return {
    maxTurns: Math.max(...caps.map((c) => c.turns)),
    runBudgetSeconds: Math.max(...caps.map((c) => c.seconds)),
  };
}

export type Materiality = "low" | "medium" | "high";

export interface ScanTheme {
  readonly code: string;
  readonly materiality: Materiality;
  readonly asset: "USDC" | "WMON";
}

const RANK: Readonly<Record<Materiality, number>> = { high: 3, medium: 2, low: 1 };

/**
 * The themes a cycle Dives on, most material first (BUILD_PLAN Phase 3 loop
 * table): in a routine or triggered cycle a high theme, or a medium one not
 * dived in the last 48 hours, up to the Dives the day has left; an activation
 * cycle Dives on its two most material themes whatever their level (the sweep).
 */
export function divesFor(o: {
  readonly kind: CycleKind;
  readonly themes: readonly ScanTheme[];
  readonly divesPerDay: number;
  readonly divesToday: number;
  /** Theme codes dived in the last 48 hours. */
  readonly recentlyDived: readonly string[];
}): ScanTheme[] {
  const sorted = [...o.themes].sort((a, b) => RANK[b.materiality] - RANK[a.materiality]);
  const unique = sorted.filter((t, i) => sorted.findIndex((u) => u.code === t.code) === i);
  if (o.kind === "ACTIVATION") return unique.slice(0, 2);
  const left = Math.max(0, o.divesPerDay - o.divesToday);
  return unique
    .filter(
      (t) =>
        t.materiality === "high" ||
        (t.materiality === "medium" && !o.recentlyDived.includes(t.code)),
    )
    .slice(0, left);
}

export type BudgetCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "BUDGET_SHORT" | "CREDITS_SHORT";
      readonly message: string;
    };

const fmt = (e6: bigint) => {
  const s = (Number(e6) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return `${s} USDC`;
};

/**
 * Whether a stage may start (D-285, D-293): its whole ceiling must fit in the
 * day's research budget, after what the day has charged and what running
 * stages have reserved, and in the credits the agent can spend above its
 * reserve for gas. A free stage always may.
 */
export function stageMayStart(o: {
  readonly ceilingUsdcE6: bigint;
  readonly dailyBudgetUsdcE6: bigint;
  /** Charged today by finished stages plus the ceilings running stages hold. */
  readonly usedTodayUsdcE6: bigint;
  readonly spendableUsdcE6: bigint;
  readonly creditReserveUsdcE6: bigint;
}): BudgetCheck {
  if (o.ceilingUsdcE6 === 0n) return { ok: true };
  const left = o.dailyBudgetUsdcE6 - o.usedTodayUsdcE6;
  if (left < o.ceilingUsdcE6)
    return {
      ok: false,
      code: "BUDGET_SHORT",
      message: `The day's research budget has ${fmt(left > 0n ? left : 0n)} left of ${fmt(o.dailyBudgetUsdcE6)}; this stage may cost up to ${fmt(o.ceilingUsdcE6)}. It waits for tomorrow's budget.`,
    };
  const usable = o.spendableUsdcE6 - o.creditReserveUsdcE6;
  if (usable < o.ceilingUsdcE6)
    return {
      ok: false,
      code: "CREDITS_SHORT",
      message: `The agent can spend ${fmt(usable > 0n ? usable : 0n)} of credits above its ${fmt(o.creditReserveUsdcE6)} reserve; this stage may cost up to ${fmt(o.ceilingUsdcE6)}. Its owner adds USDC to its funding address.`,
    };
  return { ok: true };
}

/** The start of the UTC day a time falls in: the research budget is per UTC day. */
export function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Splits a model call's provider charge against what is left of its stage's
 * ceiling (D-298): the agent pays at most the rest, the platform absorbs the
 * excess.
 */
export function chargeWithinCeiling(
  charge: bigint,
  chargedSoFar: bigint,
  ceiling: bigint,
): { charged: bigint; absorbed: bigint } {
  const left = ceiling > chargedSoFar ? ceiling - chargedSoFar : 0n;
  const charged = charge < left ? charge : left;
  return { charged, absorbed: charge - charged };
}
