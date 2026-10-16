import type { ResearchShortView } from "@alpha-agents/ui";
import type { ResearchJson } from "@/api/client";

/**
 * 2026-10-16 (owner): research never stops silently. A run stopped for want of credits or of
 * the day's research budget names the stage it stopped before and the numbers, from the
 * research view: the credits a run may spend against a full run's ceiling, or the day's budget.
 */
const SHORT = new Set(["CREDITS_SHORT", "BUDGET_SHORT"]);

type Cycle = ResearchJson["cycles"][number];

/** Why a run stopped short, and before which stage; null for any other end. */
export function stoppedShort(
  c: Cycle,
): { reason: "CREDITS_SHORT" | "BUDGET_SHORT"; stage: string | null } | null {
  const stage = c.stages.find((s) => s.stopReason && SHORT.has(s.stopReason));
  const reason = c.stopReason && SHORT.has(c.stopReason) ? c.stopReason : stage?.stopReason;
  if (!reason || !SHORT.has(reason)) return null;
  return { reason: reason as "CREDITS_SHORT" | "BUDGET_SHORT", stage: stage?.stage ?? null };
}

/** The notice for a run that stopped short, with today's numbers; null when it did not. */
export function shortNotice(research: ResearchJson, c: Cycle | null): ResearchShortView | null {
  const short = c ? stoppedShort(c) : null;
  if (!short) return null;
  if (short.reason === "CREDITS_SHORT")
    return research.credits
      ? {
          reason: "CREDITS_SHORT",
          availableUsdcE6: research.credits.availableUsdcE6,
          neededUsdcE6: research.credits.runNeedsUsdcE6,
          stage: short.stage,
        }
      : null;
  return research.budget
    ? {
        reason: "BUDGET_SHORT",
        usedUsdcE6: research.budget.usedTodayUsdcE6,
        budgetUsdcE6: research.budget.dailyBudgetUsdcE6,
        stage: short.stage,
      }
    : null;
}

/** Research now refused for credits (credits_short with its numbers, or none at all). */
export function refusedShort(
  code: string,
  body: unknown,
  research: ResearchJson | null,
): ResearchShortView | null {
  const b = (body ?? {}) as { availableUsdcE6?: unknown; neededUsdcE6?: unknown };
  if (
    code === "credits_short" &&
    typeof b.availableUsdcE6 === "string" &&
    typeof b.neededUsdcE6 === "string"
  )
    return {
      reason: "CREDITS_SHORT",
      availableUsdcE6: b.availableUsdcE6,
      neededUsdcE6: b.neededUsdcE6,
      stage: null,
    };
  if (code === "credits_exhausted" && research?.credits)
    return {
      reason: "CREDITS_SHORT",
      availableUsdcE6: "0",
      neededUsdcE6: research.credits.runNeedsUsdcE6,
      stage: null,
    };
  return null;
}

const STAGE_WORD: Readonly<Record<string, string>> = {
  SCAN: "Scan",
  DIVE: "Dive",
  CHALLENGE: "Challenge",
  TEST: "Test",
  ZOOM_OUT: "Zoom out",
};

/** Activity's words for a run that stopped short: "stopped at Scan: not enough credits". */
export function stoppedShortText(c: Cycle): string | null {
  const short = stoppedShort(c);
  if (!short) return null;
  const at = short.stage ? ` at ${STAGE_WORD[short.stage] ?? short.stage}` : "";
  return `stopped${at}: ${short.reason === "CREDITS_SHORT" ? "not enough credits" : "research budget used up"}`;
}
