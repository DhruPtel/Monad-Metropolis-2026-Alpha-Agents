/**
 * What a research run did with the agent's plan (2026-10-17), read from the run's own records:
 * the cycle, its stages (the Test's checked drafts among them) and the proposal or no-change
 * record it wrote. One answer for the Research tab's finish strip, its run list and the Trading
 * tab's plan card, so the two tabs can never disagree about whether a plan waits for the owner.
 */
export const RUN_PLAN_OUTCOMES = [
  /** The run is still going. */
  "running",
  /** Its proposal waits for the owner's approval on the Trading tab. */
  "awaiting_approval",
  /** Its proposal became the plan: at once (the goal applies plan changes) or by approval. */
  "applied",
  /** It kept the plan in force. */
  "kept",
  /** The platform's checks refused its plan; nothing was offered. */
  "refused",
  /** The owner declined its proposal. */
  "declined",
  /** Its proposal waited 24 hours without approval. */
  "expired",
  /** A newer plan replaced its proposal before the owner decided. */
  "superseded",
  /** It made no plan: a step stopped or failed, or nothing was worth one. */
  "no_plan",
] as const;
export type RunPlanOutcomeKind = (typeof RUN_PLAN_OUTCOMES)[number];

/** A finding the platform's checks wrote, in its own words. */
export interface PlanFinding {
  readonly code: string;
  readonly message: string;
}

export interface RunPlanOutcome {
  readonly kind: RunPlanOutcomeKind;
  /** The run's proposal or no-change record, when it wrote one. */
  readonly proposalId: string | null;
  /** For an applied plan: set by the agent at once (apply and tell) or by the owner's approval. */
  readonly appliedBy: "agent" | "owner" | null;
  /** The reason as a code: the stop reason, the first finding's code or the kept reason. */
  readonly reasonCode: string | null;
  /** The reason in the owner's words; null for a plan waiting or applied. */
  readonly reason: string | null;
  /** For a refused plan: what the checks said. */
  readonly findings: readonly PlanFinding[];
}

/** A Test stage's record of one draft it checked (the Zoom out's complete_stage). */
export interface CheckedDraft {
  readonly passed: boolean;
  readonly codes: readonly string[];
  /** 2026-10-17: the findings in the Test's words; absent on older records. */
  readonly findings?: readonly { readonly code: string; readonly message?: string | null }[] | null;
}

/** The records a run's outcome is read from. */
export interface RunPlanRecords {
  readonly cycle: {
    readonly kind: string;
    readonly status: string;
    readonly stopReason: string | null;
  };
  readonly stages: readonly {
    readonly stage: string;
    readonly status: string;
    readonly stopReason: string | null;
    /** The Test stage's checked drafts, oldest first; null elsewhere. */
    readonly checked?: readonly CheckedDraft[] | null;
  }[];
  /** The newest proposal or no-change record the run wrote, if any. */
  readonly proposal: {
    readonly proposalId: string;
    readonly kind: "proposal" | "no_change";
    readonly status: string;
    readonly reasonCode: string | null;
    /** Set when the owner decided it (approved, declined, or refused at approval). */
    readonly decidedBy: string | null;
    readonly findings: readonly PlanFinding[];
  } | null;
}

/** Why a step or a run stopped, in the owner's words. */
export const STOP_REASON_TEXT: Readonly<Record<string, string>> = {
  COMPLETED: "finished",
  TASK_CAP: "the task reached its model spend cap",
  CEILING: "the step reached its cost ceiling",
  TURN_CAP: "the step used all its model turns",
  TOKEN_CAP: "the step used all its tokens",
  STAGE_CALL_CAP: "the step used all its paid data calls",
  DEADLINE: "the step ran out of time",
  BUDGET_SHORT: "the day's research budget could not cover the next step",
  CREDITS_SHORT: "the credits could not cover the next step",
  BILLING: "the credits ran out",
  PROVIDER_OUT_OF_CREDIT: "the model provider refused the call",
  NO_STAGE_RECORD: "the agent ended the step without recording it",
  NOTHING_MATERIAL: "nothing was worth a closer look",
  MARKET_UNAVAILABLE: "the pools and prices could not be read",
  FAILED: "the step failed",
  INTERRUPTED: "the platform restarted during the step",
  STALLED: "the sweep stopped moving for an hour (its worker was lost); start it again",
};

/** What each of the Test's codes means, in the owner's words. */
export const PLAN_CHECK_TEXT: Readonly<Record<string, string>> = {
  OUT_OF_BOUNDS: "a weight is outside what the plan may hold",
  TOKEN_NOT_REGISTERED: "a token is not registered for trading",
  TOKEN_NOT_BUYABLE: "a token cannot be bought now",
  NOT_OPTED_IN: "a screened token needs your opt-in",
  SCREEN_STALE: "a token's safety screen is out of date",
  ENVELOPE_POSITIONS: "it holds more positions than the goal allows",
  ENVELOPE_POSITION: "a position is above its cap",
  ENVELOPE_CLASS_A: "a position in an attested-price token is above its cap",
  ENVELOPE_CLASS_A_TOTAL: "too much is in attested-price tokens",
  ENVELOPE_STABLE: "too little is kept in USDC",
  CLASS_A_COST_BASIS: "an attested-price token has no cost basis yet",
  VALUES_UNUSABLE:
    "the trading account's values could not be read (or there is no trading account)",
  DEPTH: "a position is too large for its pools",
  TURNOVER: "moving to it trades more than the turnover limit allows",
  HARD_LIMIT: "it breaks a hard limit",
  COOLDOWN: "the agent changed the plan less than 24 hours ago",
  TEMPLATE_EVALS_FAIL: "it failed its template's checks",
  COST_HURDLE: "moving to it costs more than the plan's cost limit",
  STATE_CHANGED: "the account or the market changed since the research checked it",
  NO_ACCOUNT: "the agent has no trading account yet (open one on the Trading tab)",
  NO_GOAL: "the agent has no goal",
  NOT_ON_SET: "the agent is not on the platform's trading contracts",
};

/** What a kept plan's reason code means. */
const KEPT_TEXT: Readonly<Record<string, string>> = {
  NO_MATERIAL_CHANGE: "nothing material changed",
};

const words = (code: string) => code.toLowerCase().replaceAll("_", " ");
export const stopReasonText = (code: string | null): string | null =>
  code === null ? null : (STOP_REASON_TEXT[code] ?? words(code));
const checkText = (code: string) => PLAN_CHECK_TEXT[code] ?? words(code);
const STEP_WORD: Readonly<Record<string, string>> = {
  SCAN: "The market scan",
  DIVE: "A token's research",
  CHALLENGE: "The challenge",
  TEST: "The checks",
  ZOOM_OUT: "The plan step",
};
const DONE = new Set(["completed"]);
const ENDED_BADLY = new Set(["failed", "stopped", "skipped", "capped"]);

/** The findings of a checked draft: its own words when stored, else each code's meaning. */
function draftFindings(d: CheckedDraft): PlanFinding[] {
  if (d.findings && d.findings.length > 0)
    return d.findings.map((f) => ({ code: f.code, message: f.message ?? checkText(f.code) }));
  return [...new Set(d.codes)].map((code) => ({ code, message: checkText(code) }));
}

/** The findings' meanings in the owner's words, each once. */
const findingWords = (f: readonly PlanFinding[]) =>
  [...new Set(f.map((x) => checkText(x.code)))].join("; ");
const draftsWord = (n: number) =>
  n === 1 ? "the plan the agent drafted" : `the ${n} plans the agent drafted`;

/** The run's outcome for the plan (pure). */
export function runPlanOutcome(r: RunPlanRecords): RunPlanOutcome {
  const none = { proposalId: null, appliedBy: null, findings: [] } as const;
  if (r.cycle.status === "queued" || r.cycle.status === "running")
    return { kind: "running", ...none, reasonCode: null, reason: null };
  const p = r.proposal;
  const drafts = r.stages.find((s) => s.stage === "TEST")?.checked ?? [];
  const last = drafts.at(-1) ?? null;
  // Every draft the plan step offered the Test was refused.
  const allRefused = last !== null && !drafts.some((d) => d.passed);
  if (p) {
    const base = { proposalId: p.proposalId, appliedBy: null, findings: [] } as const;
    if (p.kind === "no_change") {
      const why = p.reasonCode ? `: ${KEPT_TEXT[p.reasonCode] ?? words(p.reasonCode)}` : "";
      const refused = allRefused ? draftFindings(last) : [];
      return {
        kind: "kept",
        ...base,
        findings: refused,
        reasonCode: p.reasonCode,
        // A change the checks refused before the step settled on none is part of the why.
        reason: allRefused
          ? `The research decided against a change${why ? ` (${why.slice(2)})` : ""} after the platform's checks refused ${draftsWord(drafts.length)}: ${findingWords(refused)}.`
          : `The research decided against a change${why}.`,
      };
    }
    switch (p.status) {
      case "pending_owner":
        return { kind: "awaiting_approval", ...base, reasonCode: null, reason: null };
      case "applied":
        return {
          kind: "applied",
          ...base,
          appliedBy: p.decidedBy ? "owner" : "agent",
          reasonCode: null,
          reason: null,
        };
      case "rejected":
        return {
          kind: "refused",
          ...base,
          findings: p.findings,
          reasonCode: p.findings[0]?.code ?? "REFUSED",
          reason: `${p.decidedBy ? "At your approval the" : "The"} platform's checks refused the plan${
            p.findings.length > 0
              ? `: ${p.findings
                  .map((f) => checkText(f.code))
                  .filter((t, i, a) => a.indexOf(t) === i)
                  .join("; ")}`
              : ""
          }.`,
        };
      case "declined":
        return { kind: "declined", ...base, reasonCode: "DECLINED", reason: "You declined it." };
      case "expired":
        return p.reasonCode === "SUPERSEDED"
          ? {
              kind: "superseded",
              ...base,
              reasonCode: "SUPERSEDED",
              reason: "A newer plan replaced it before you decided.",
            }
          : {
              kind: "expired",
              ...base,
              reasonCode: "EXPIRED",
              reason: "It waited 24 hours without your approval.",
            };
    }
  }
  if (r.cycle.kind === "REPLAY")
    return {
      kind: "no_plan",
      ...none,
      reasonCode: "REPLAY",
      reason: "A replay runs one step again to compare; it never makes a plan.",
    };
  // No record: the run stopped or failed before a plan, or the plan step ended without one.
  const zoom = [...r.stages].reverse().find((s) => s.stage === "ZOOM_OUT") ?? null;
  // Every draft the plan step offered was refused, and the step ended without a plan (capped,
  // stopped, failed or done): the refusal is why there is no plan, whatever the run's status.
  if (zoom && allRefused) {
    const stopped = DONE.has(zoom.status) ? null : stopReasonText(zoom.stopReason ?? "FAILED");
    const findings = draftFindings(last);
    return {
      kind: "refused",
      ...none,
      findings,
      reasonCode: findings[0]?.code ?? "REFUSED",
      reason: `The platform's checks refused ${draftsWord(drafts.length)}: ${findingWords(findings)}${stopped ? `; then the plan step stopped: ${stopped}` : ""}.`,
    };
  }
  const ended = [...r.stages].reverse().find((s) => ENDED_BADLY.has(s.status)) ?? null;
  if (r.cycle.status !== "completed") {
    const code = r.cycle.stopReason ?? ended?.stopReason ?? "FAILED";
    const step = ended ? (STEP_WORD[ended.stage] ?? "A step") : "The run";
    return {
      kind: "no_plan",
      ...none,
      reasonCode: code,
      reason: `${step} stopped: ${stopReasonText(code)}.`,
    };
  }
  if (!zoom) {
    const code =
      r.cycle.stopReason && r.cycle.stopReason !== "COMPLETED"
        ? r.cycle.stopReason
        : "NO_PLAN_STEP";
    return {
      kind: "no_plan",
      ...none,
      reasonCode: code,
      reason:
        code === "NOTHING_MATERIAL"
          ? "Nothing was worth a closer look, so no plan step ran."
          : "The run ended before its plan step.",
    };
  }
  const stopped = DONE.has(zoom.status) ? null : stopReasonText(zoom.stopReason);
  return {
    kind: "no_plan",
    ...none,
    reasonCode: DONE.has(zoom.status) ? "NOT_RECORDED" : (zoom.stopReason ?? "NO_DECISION"),
    reason: stopped
      ? `The plan step stopped before it decided: ${stopped}.`
      : "The plan step ended, but no plan was recorded.",
  };
}

/** What the plan card shows (the API's plan card, reduced to what decides it). */
export interface PlanCardRefs {
  /** The proposal waiting for the owner's approval, as the card shows it. */
  readonly pendingId: string | null;
  /** The proposal that set the plan in force, when one did. */
  readonly inForceId: string | null;
  /** Whether a plan is in force at all. */
  readonly planInForce: boolean;
}

/** The plan card's main content: the proposal waiting, else the plan in force, else none. */
export function planCardShows(card: PlanCardRefs): "pending" | "in_force" | "none" {
  if (card.pendingId) return "pending";
  return card.planInForce ? "in_force" : "none";
}

/** The finish strip's button: each leads to the plan card's #plan, which shows what it names. */
export type FinishButton = "review_plan" | "view_plan" | "view_current_plan";

export interface FinishView {
  /** "done": the run ended with a plan waiting, applied or kept; "attention": it made none. */
  readonly tone: "done" | "attention";
  readonly line: string;
  readonly button: FinishButton | null;
  /** Another run's plan waits for the owner: a second "Review plan" leads to it. */
  readonly otherWaiting: boolean;
}

/**
 * The Research tab's finish strip for a run (pure): "Review plan" only when this run's proposal
 * is the one the plan card shows waiting, "View plan" once it applied, "View current plan" when
 * the plan was kept, and the reason when the run made no plan.
 */
export function finishView(o: RunPlanOutcome, card: PlanCardRefs): FinishView {
  const shows = planCardShows(card);
  const otherWaiting = shows === "pending" && card.pendingId !== o.proposalId;
  const current: FinishButton | null = shows === "in_force" ? "view_current_plan" : null;
  switch (o.kind) {
    case "running":
      return { tone: "done", line: "Running", button: null, otherWaiting: false };
    case "awaiting_approval":
      return card.pendingId === o.proposalId
        ? {
            tone: "done",
            line: "Plan ready: it waits for your approval",
            button: "review_plan",
            otherWaiting: false,
          }
        : {
            tone: "attention",
            line: "Its plan no longer waits for you",
            button: current,
            otherWaiting,
          };
    case "applied":
      return {
        tone: "done",
        line:
          card.inForceId !== null && card.inForceId !== o.proposalId
            ? "Plan applied; a newer plan has replaced it since"
            : o.appliedBy === "agent"
              ? "Plan applied: your goal applies plan changes at once"
              : "Plan approved and in force",
        button: shows === "none" ? null : "view_plan",
        otherWaiting,
      };
    case "kept":
      // With no plan in force there is nothing unchanged to point at: say why there is none.
      return card.planInForce
        ? { tone: "done", line: "Plan unchanged", button: current, otherWaiting }
        : {
            tone: "attention",
            line: `No plan: ${lower(o.reason ?? "the research decided against one.")}`,
            button: null,
            otherWaiting,
          };
    case "refused":
      return {
        tone: "attention",
        line: `No plan: ${lower(o.reason ?? "the platform's checks refused it.")}`,
        button: current,
        otherWaiting,
      };
    case "declined":
    case "expired":
    case "superseded":
      return {
        tone: "attention",
        line: `${o.kind === "declined" ? "Plan declined" : o.kind === "expired" ? "Plan expired" : "Plan replaced"}: ${lower(o.reason ?? "")}`.replace(
          /: $/,
          "",
        ),
        button: current,
        otherWaiting,
      };
    case "no_plan":
      return {
        tone: "attention",
        line: `No plan: ${lower(o.reason ?? "the run made none.")}`,
        button: current,
        otherWaiting,
      };
  }
}

/** "The plan step stopped." as it reads after "No plan: ". */
function lower(s: string): string {
  return s.length > 0 ? `${s[0]?.toLowerCase()}${s.slice(1)}` : s;
}
