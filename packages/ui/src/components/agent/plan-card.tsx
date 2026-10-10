import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { SectionLabel } from "../ui/section-label";
import { Tag, type TagTone } from "../ui/tag";

/**
 * The plan card (F-U9): a proposed portfolio against the current one, each
 * position's thesis and exit plan, the evidence strength, the sources by
 * class, the skeptic's verdict, the evaluator's result and the estimated
 * cost to move to it. Every figure comes from the stored proposal; no skill
 * text is ever shown.
 */
export type ProposalAction = "ADD" | "HOLD" | "TRIM" | "EXIT";
export type ProposalStatus =
  "pending_owner" | "applied" | "rejected" | "declined" | "expired" | "recorded";
export type EvidenceStrength = "strong" | "mixed" | "weak";

export interface PlanCardPosition {
  readonly token: string;
  readonly symbol: string;
  readonly targetWeightBps: number;
  readonly bandBps: number;
  readonly currentWeightBps: number | null;
  readonly action: ProposalAction;
  readonly thesis: string | null;
  readonly killCriterion: string;
  readonly recheckAt: string;
  readonly trimAboveBps: number | null;
  readonly confidence: "high" | "medium" | "low" | null;
  readonly sources: {
    readonly onchain: number;
    readonly market: number;
    readonly primary: number;
    readonly news: number;
    readonly social: number;
  };
  readonly verdict: "STANDS" | "WEAKENED" | "REJECTED" | null;
  readonly reason: string;
}

export interface PlanCardView {
  readonly proposalId: string;
  readonly status: ProposalStatus;
  readonly needsApproval: boolean;
  readonly cashTargetBps: number | null;
  readonly currentCashBps: number | null;
  readonly positions: readonly PlanCardPosition[];
  /** Positions the plan in force holds that the proposal leaves, by symbol. */
  readonly leaving: readonly { readonly symbol: string; readonly currentWeightBps: number }[];
  readonly portfolioView: string;
  readonly evidenceStrength: EvidenceStrength;
  readonly whatWouldChangeIt: string;
  readonly evaluation: {
    readonly passed: boolean;
    readonly checkedAt: string;
    readonly findings: readonly { readonly code: string; readonly message: string }[];
    readonly cost: {
      readonly legs: number;
      readonly turnoverUsdcE6: string;
      readonly estimatedCostUsdcE6: string;
      readonly costBps: number;
    } | null;
  } | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly decidedAt: string | null;
}

const percent = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const usdc = (e6: string) => `${(Number(e6) / 1e6).toFixed(2)} USDC`;
const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export const PROPOSAL_STATUS_LABELS: Readonly<Record<ProposalStatus, string>> = {
  pending_owner: "Waiting for your approval",
  applied: "Applied",
  rejected: "Rejected by the platform's checks",
  declined: "Declined by you",
  expired: "Expired",
  recorded: "Recorded",
};
const STATUS_TONE: Readonly<Record<ProposalStatus, TagTone>> = {
  pending_owner: "warning",
  applied: "accent",
  rejected: "warning",
  declined: "neutral",
  expired: "neutral",
  recorded: "neutral",
};
const ACTION_LABELS: Readonly<Record<ProposalAction, string>> = {
  ADD: "Add",
  HOLD: "Hold",
  TRIM: "Trim",
  EXIT: "Exit",
};
const VERDICT_LABELS = {
  STANDS: "Skeptic: stands",
  WEAKENED: "Skeptic: weakened",
  REJECTED: "Skeptic: rejected",
} as const;
const VERDICT_TONE: Readonly<Record<keyof typeof VERDICT_LABELS, TagTone>> = {
  STANDS: "accent",
  WEAKENED: "warning",
  REJECTED: "warning",
};
const STRENGTH_TONE: Readonly<Record<EvidenceStrength, TagTone>> = {
  strong: "accent",
  mixed: "neutral",
  weak: "warning",
};

/** The sources a thesis rests on, by class, strongest first; only the classes with a count. */
function SourcesByClass({ sources }: { sources: PlanCardPosition["sources"] }) {
  const rows = (
    [
      ["onchain", "onchain"],
      ["market", "market"],
      ["primary", "primary"],
      ["news", "news"],
      ["social", "social"],
    ] as const
  ).filter(([k]) => sources[k] > 0);
  if (rows.length === 0) return <span className="text-foreground-muted">No sources recorded</span>;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Sources by class">
      {rows.map(([k, label]) => (
        <li key={k}>
          <Tag tone={k === "social" ? "warning" : "neutral"}>
            <span className="numeric">{sources[k]}</span> {label}
          </Tag>
        </li>
      ))}
    </ul>
  );
}

function Position({ p }: { p: PlanCardPosition }) {
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border p-3"
      data-testid="plan-position"
      data-action={p.action}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{p.symbol}</span>
          <Tag tone={p.action === "EXIT" || p.action === "TRIM" ? "warning" : "accent"}>
            {ACTION_LABELS[p.action]}
          </Tag>
        </div>
        <span className="numeric text-sm">
          {p.currentWeightBps === null ? "new" : percent(p.currentWeightBps)}
          <span className="text-foreground-muted"> to </span>
          {p.action === "EXIT" ? "0.00%" : percent(p.targetWeightBps)}
          <span className="text-foreground-muted"> (band {percent(p.bandBps)})</span>
        </span>
      </div>
      {p.thesis ? (
        <p className="text-sm">{p.thesis}</p>
      ) : (
        <p className="text-sm text-foreground-muted">No thesis recorded for this position.</p>
      )}
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex flex-col">
          <dt className="text-xs text-foreground-muted">Exit plan</dt>
          <dd>
            {p.killCriterion} Recheck by <span className="numeric">{p.recheckAt.slice(0, 10)}</span>
            {p.trimAboveBps !== null ? (
              <>
                ; trim above <span className="numeric">{percent(p.trimAboveBps)}</span>
              </>
            ) : null}
            .
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-foreground-muted">Evidence</dt>
          <dd className="flex flex-wrap items-center gap-1.5">
            <SourcesByClass sources={p.sources} />
            {p.confidence ? <Tag>{p.confidence} confidence</Tag> : null}
            {p.verdict ? (
              <Tag tone={VERDICT_TONE[p.verdict]}>{VERDICT_LABELS[p.verdict]}</Tag>
            ) : null}
          </dd>
        </div>
      </dl>
      {p.reason ? <p className="text-sm text-foreground-muted">Why: {p.reason}</p> : null}
    </li>
  );
}

/**
 * The card itself. `actions` holds the owner's buttons when the proposal
 * waits; `status` the shared status line of the action in flight.
 */
function PlanCard({
  view: v,
  actions,
  status,
  className,
}: {
  view: PlanCardView;
  actions?: ReactNode;
  status?: ReactNode;
  className?: string;
}) {
  const waiting = v.status === "pending_owner";
  return (
    <section
      aria-label={waiting ? "Proposed portfolio awaiting your approval" : "Proposed portfolio"}
      className={cn(
        "flex flex-col gap-4 rounded-md border p-4",
        waiting ? "border-warning" : "border-border",
        className,
      )}
      data-testid="plan-card"
      data-status={v.status}
      data-proposal={v.proposalId}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionLabel as="h4">
          {waiting ? "The agent proposes this portfolio" : "Proposed portfolio"}
        </SectionLabel>
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag tone={STRENGTH_TONE[v.evidenceStrength]}>{v.evidenceStrength} evidence</Tag>
          <Tag tone={STATUS_TONE[v.status]}>{PROPOSAL_STATUS_LABELS[v.status]}</Tag>
        </div>
      </div>
      <p className="text-sm" data-testid="plan-portfolio-view">
        {v.portfolioView}
      </p>
      <ul className="flex flex-col gap-2" aria-label="Proposed positions">
        {v.positions.map((p) => (
          <Position key={p.token} p={p} />
        ))}
        {v.leaving.map((l) => (
          <li
            key={l.symbol}
            className="flex items-center justify-between rounded-md border border-border p-3 text-sm"
            data-testid="plan-position"
            data-action="EXIT"
          >
            <span className="flex items-center gap-2">
              <span className="font-semibold">{l.symbol}</span>
              <Tag tone="warning">Exit</Tag>
            </span>
            <span className="numeric">
              {percent(l.currentWeightBps)}
              <span className="text-foreground-muted"> to </span>0.00%
            </span>
          </li>
        ))}
      </ul>
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div className="flex flex-col">
          <dt className="text-xs text-foreground-muted">Cash target</dt>
          <dd className="numeric">
            {v.currentCashBps === null ? "now unknown" : percent(v.currentCashBps)}
            <span className="text-foreground-muted"> to </span>
            {v.cashTargetBps === null ? "unchanged" : percent(v.cashTargetBps)}
          </dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-foreground-muted">Estimated cost to move</dt>
          <dd className="numeric" data-testid="plan-cost">
            {v.evaluation?.cost
              ? v.evaluation.cost.legs === 0
                ? "nothing moves"
                : `${usdc(v.evaluation.cost.estimatedCostUsdcE6)} over ${v.evaluation.cost.legs} ${v.evaluation.cost.legs === 1 ? "leg" : "legs"} (${percent(v.evaluation.cost.costBps)} of ${usdc(v.evaluation.cost.turnoverUsdcE6)})`
              : "not estimated"}
          </dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-foreground-muted">
            {v.status === "pending_owner" ? "Approval expires" : "Proposed"}
          </dt>
          <dd className="numeric">
            {v.status === "pending_owner" && v.expiresAt ? when(v.expiresAt) : when(v.createdAt)}
          </dd>
        </div>
      </dl>
      <div className="flex flex-col gap-1 text-sm" data-testid="plan-evaluation">
        <span className="text-xs text-foreground-muted">The platform's checks</span>
        {v.evaluation ? (
          v.evaluation.passed ? (
            <p>
              Passed every check at <span className="numeric">{when(v.evaluation.checkedAt)}</span>:
              the registry, the safety screens, your goal&apos;s envelope and limits, depth,
              turnover and the cooldown.
            </p>
          ) : (
            <ul className="flex flex-col gap-1" aria-label="Findings">
              {v.evaluation.findings.map((f, i) => (
                <li key={`${f.code}-${i}`} className="text-warning">
                  <span className="numeric">{f.code}</span>: {f.message}
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="text-foreground-muted">Not checked.</p>
        )}
      </div>
      <p className="text-sm text-foreground-muted">What would change it: {v.whatWouldChangeIt}</p>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      {status}
    </section>
  );
}

/** "Why the plan did not change": the Zoom out's reason code and its plain explanation. */
function NoChangeNotice({
  reasonCode,
  explanation,
  at,
  className,
}: {
  reasonCode: string;
  explanation: string;
  at: string;
  className?: string;
}) {
  return (
    <section
      aria-label="Why the plan did not change"
      className={cn("flex flex-col gap-2 rounded-md border border-border p-4", className)}
      data-testid="plan-no-change"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel as="h4">Why the plan did not change</SectionLabel>
        <span className="numeric text-xs text-foreground-muted">{when(at)}</span>
      </div>
      <p className="text-sm">
        <Tag tone="neutral">{reasonCode.toLowerCase().replaceAll("_", " ")}</Tag>{" "}
        <span>{explanation}</span>
      </p>
    </section>
  );
}

export { NoChangeNotice, PlanCard };
