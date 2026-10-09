/**
 * The console's research cycles (P3-U4): the orchestrator's cycle routes as
 * the page reads them, and the small rules the page renders with, kept here
 * so they are tested without a browser.
 */
export interface StageCaps {
  readonly turns: number;
  readonly paidCalls: number;
  readonly tokens: number;
  readonly seconds: number;
}

export interface PlannedStage {
  readonly stage: string;
  readonly count: number;
  readonly model: string | null;
  readonly caps: StageCaps;
  readonly ceilingUsdcE6: string;
}

export interface CyclePlan {
  readonly kind: "ROUTINE" | "ACTIVATION";
  readonly reasoning: string;
  readonly stages: readonly PlannedStage[];
  readonly maxUsdcE6: string;
}

export interface StageJson {
  readonly stageRunId: string;
  readonly seq: number;
  readonly stage: "SCAN" | "DIVE" | "CHALLENGE" | "TEST" | "ZOOM_OUT";
  readonly themeCode: string | null;
  readonly model: string | null;
  readonly caps: StageCaps;
  readonly ceilingUsdcE6: string;
  readonly status: string;
  readonly stopReason: string | null;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly chargedUsdcE6: string;
  readonly absorbedUsdcE6: string;
  readonly outcome: Record<string, unknown> | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface CycleJson {
  readonly cycleId: string;
  readonly taskId: string;
  readonly kind: string;
  readonly status: string;
  readonly stopReason: string | null;
  readonly reasoning: string;
  readonly chargedUsdcE6: string;
  readonly absorbedUsdcE6: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly stages: readonly StageJson[];
}

export interface AgentCyclesJson {
  readonly agentId: string;
  readonly goal: {
    readonly reasoning: string | null;
    readonly intensity: string;
    readonly divesPerDay: number;
    readonly dailyBudgetUsdcE6: string;
    readonly creditReserveUsdcE6: string;
  } | null;
  readonly today: { readonly usedUsdcE6: string; readonly divesToday: number };
  readonly plans: { readonly ROUTINE: CyclePlan; readonly ACTIVATION: CyclePlan } | null;
  readonly cycles: readonly CycleJson[];
}

export interface StageDetail extends StageJson {
  readonly entry: { readonly text: string; readonly rendered_by: string } | null;
  readonly record: {
    readonly outcome: string;
    readonly candidates: unknown[];
    readonly decision: Record<string, unknown> | null;
  } | null;
  readonly modelCallRecords: readonly {
    readonly requestId: string;
    readonly model: string;
    readonly status: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly costUsd: number;
    readonly at: string;
  }[];
  readonly toolCalls: readonly {
    readonly callId: string;
    readonly server: string;
    readonly tool: string;
    readonly input: Record<string, unknown>;
    readonly status: string;
    readonly errorCode: string | null;
    readonly chargeUsdcE6: string;
    readonly cacheHit: boolean;
    readonly resultStored: boolean;
    readonly resultTruncated: boolean;
    readonly startedAt: string;
  }[];
  readonly notes: readonly {
    readonly title: string;
    readonly notes: string;
    readonly sources: string[];
    readonly at: string;
  }[];
  readonly briefs: readonly {
    readonly briefId: string;
    readonly kind: string;
    readonly status: "accepted" | "refused";
    readonly body: Record<string, unknown>;
    readonly reasons: string[];
    readonly at: string;
  }[];
}

export interface CycleDetailJson {
  readonly cycle: Omit<CycleJson, "stages">;
  readonly stages: readonly StageDetail[];
}

export const STAGE_LABELS: Readonly<Record<StageJson["stage"], string>> = {
  SCAN: "Scan",
  DIVE: "Dive",
  CHALLENGE: "Challenge",
  TEST: "Test",
  ZOOM_OUT: "Zoom out",
};

/** Micro-USDC as USDC with four decimals, truncated, never overstated (L-80). */
export function usdc(e6: string | number | bigint): string {
  const v = BigInt(e6);
  const whole = v / 1_000_000n;
  const frac = ((v < 0n ? -v : v) % 1_000_000n).toString().padStart(6, "0").slice(0, 4);
  return `${whole}.${frac} USDC`;
}

/** A use against its cap as a meter's fill, in basis points (0 to 10,000). */
export function fillBps(used: number | bigint, cap: number | bigint): number {
  const u = Number(used);
  const c = Number(cap);
  if (c <= 0) return 0;
  return Math.min(10_000, Math.round((u / c) * 10_000));
}

/** How a stage or cycle status reads as a badge. */
export function statusTone(status: string): "positive" | "negative" | "warning" | "neutral" {
  if (status === "completed") return "positive";
  if (status === "capped" || status === "stopped" || status === "skipped") return "warning";
  if (status === "failed") return "negative";
  return "neutral";
}

/** Share of a stage's input tokens read from the prompt cache, as a whole percent. */
export function cacheShare(s: Pick<StageJson, "inputTokens" | "cacheReadTokens">): string {
  if (s.inputTokens <= 0) return "0%";
  return `${Math.round((s.cacheReadTokens / s.inputTokens) * 100)}%`;
}

/** Paid tool calls a stage made (cached answers are free and do not count). */
export function paidCalls(s: Pick<StageDetail, "toolCalls">): number {
  return s.toolCalls.filter((c) => BigInt(c.chargeUsdcE6) > 0n && c.status !== "refused").length;
}

/** What a tool call asked for, in a few words: a query, a host, a topic, or nothing. */
export function callSubject(input: Record<string, unknown>): string {
  if (typeof input.query === "string") return input.query.slice(0, 80);
  if (typeof input.url === "string")
    try {
      return new URL(input.url).hostname;
    } catch {
      return "invalid URL";
    }
  if (typeof input.topic === "string") return input.topic;
  if (typeof input.kind === "string") return input.kind;
  if (typeof input.stage === "string") return input.stage;
  return "";
}

/** True while a cycle may still change, so the page refreshes itself. */
export const isLive = (status: string) => status === "queued" || status === "running";
