import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Hourglass,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { StatBar } from "../stat-bar";
import { Badge, type BadgeTone } from "../ui/badge";
import { SectionLabel } from "../ui/section-label";
import { Tag, type TagTone } from "../ui/tag";

/**
 * The activation sweep's panel (F-U10, D-279): the eight steps the owner
 * watches while the agent builds its first plan, each with its state, its
 * one-line result (a fixed template over records, never model text), its
 * cost against its ceiling and, while it runs, how long it has run; the
 * sweep's cost against the ceiling shown before it started; and what
 * happened and what the owner can do once it ends. The checks before a
 * sweep may start are their own list, and the sweep's status is a tag the
 * agent viewer wears.
 */
export type ActivationStepState = "pending" | "running" | "done" | "failed" | "skipped" | "capped";

export interface ActivationStepView {
  readonly key: string;
  readonly label: string;
  readonly state: ActivationStepState;
  readonly result: string | null;
  readonly reason: string | null;
  readonly chargedUsdcE6: string;
  readonly ceilingUsdcE6: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export const ACTIVATION_STATUSES = [
  "running",
  "plan_ready",
  "active",
  "off",
  "declined",
  "expired",
  "no_plan",
  "failed",
  "capped",
  "out_of_credits",
] as const;
export type ActivationStatus = (typeof ACTIVATION_STATUSES)[number];

export interface ActivationPanelView {
  readonly activationId: string;
  readonly status: ActivationStatus;
  readonly tier: { readonly label: string; readonly model: string };
  readonly ceilingUsdcE6: string;
  readonly chargedUsdcE6: string;
  readonly steps: readonly ActivationStepView[];
  readonly outcome: {
    readonly title: string;
    readonly message: string;
    readonly action: "approve" | "retry" | "add_credits" | "none";
  };
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface ActivationCheckView {
  readonly code: string;
  readonly ok: boolean;
  readonly message: string;
  readonly blocking: boolean;
}

const usdc = (e6: string) => (Number(e6) / 1e6).toFixed(2);

/** The sweep's status in the owner's words, with the tone status badges use. */
export const ACTIVATION_STATUS_RENDERING: Readonly<
  Record<ActivationStatus, { readonly label: string; readonly tone: BadgeTone }>
> = {
  running: { label: "Activating", tone: "detail" },
  plan_ready: { label: "Plan ready for approval", tone: "warning" },
  active: { label: "Active", tone: "positive" },
  off: { label: "Turned off", tone: "neutral" },
  declined: { label: "Plan declined", tone: "neutral" },
  expired: { label: "Plan expired", tone: "neutral" },
  no_plan: { label: "No plan yet", tone: "neutral" },
  failed: { label: "Did not finish", tone: "negative" },
  capped: { label: "Stopped at a limit", tone: "warning" },
  out_of_credits: { label: "Out of credits", tone: "negative" },
};

const STEP_ICON: Readonly<Record<ActivationStepState, LucideIcon>> = {
  pending: Circle,
  running: LoaderCircle,
  done: CircleCheck,
  failed: CircleAlert,
  skipped: CircleDashed,
  capped: Hourglass,
};
const STEP_TONE: Readonly<Record<ActivationStepState, string>> = {
  pending: "text-foreground-subtle",
  running: "text-primary",
  done: "text-positive",
  failed: "text-negative",
  skipped: "text-foreground-subtle",
  capped: "text-warning",
};
const STEP_WORD: Readonly<Record<ActivationStepState, string>> = {
  pending: "waiting",
  running: "running",
  done: "done",
  failed: "failed",
  skipped: "skipped",
  capped: "stopped at a limit",
};

/** How long a step has run, from its start to `now`: "12 s", "3 min 05 s". */
export function elapsedText(startedAt: string, now: string): string {
  const seconds = Math.max(0, Math.floor((Date.parse(now) - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
}

function Step({ step, now }: { step: ActivationStepView; now: string }) {
  const Icon = STEP_ICON[step.state];
  const paid = step.ceilingUsdcE6 !== "0" || step.chargedUsdcE6 !== "0";
  return (
    <li
      className="flex gap-3 py-2"
      data-testid="activation-step"
      data-step={step.key}
      data-state={step.state}
    >
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0",
          STEP_TONE[step.state],
          step.state === "running" && "motion-safe:animate-spin",
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span
            className={cn(
              "text-sm",
              step.state === "pending" || step.state === "skipped"
                ? "text-foreground-muted"
                : "font-medium",
            )}
          >
            {step.label}
            <span className="sr-only">: {STEP_WORD[step.state]}</span>
          </span>
          <span className="numeric text-xs text-foreground-muted">
            {step.state === "running" && step.startedAt && step.key !== "active" ? (
              <span data-elapsed="">running for {elapsedText(step.startedAt, now)}</span>
            ) : paid ? (
              <>
                {usdc(step.chargedUsdcE6)} of at most {usdc(step.ceilingUsdcE6)} USDC
              </>
            ) : step.state === "done" ? (
              "free"
            ) : null}
          </span>
        </div>
        {step.result ? <p className="text-sm text-foreground-muted">{step.result}</p> : null}
        {step.reason ? (
          <p
            className={cn(
              "text-sm",
              step.state === "failed" || step.state === "capped"
                ? "text-warning"
                : "text-foreground-muted",
            )}
          >
            {step.state === "skipped" ? "Skipped: " : ""}
            {step.reason}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The panel. `now` is the moment the elapsed times count to, passed in so a
 * page ticks it and a specimen holds it still. `actions` holds the owner's
 * buttons for the outcome (approve, try again, add credits), `status` the
 * shared status line of the action in flight.
 */
function ActivationPanel({
  view: v,
  now,
  actions,
  status,
  terminal,
  className,
}: {
  view: ActivationPanelView;
  now: string;
  actions?: ReactNode;
  status?: ReactNode;
  /** P3-U10: the agent terminal while the sweep runs, below the steps. */
  terminal?: ReactNode;
  className?: string;
}) {
  const r = ACTIVATION_STATUS_RENDERING[v.status];
  const charged = BigInt(v.chargedUsdcE6);
  const ceiling = BigInt(v.ceilingUsdcE6);
  const fillBps = ceiling > 0n ? Number((charged * 10_000n) / ceiling) : 0;
  return (
    <section
      aria-label="Activation sweep"
      className={cn("flex flex-col gap-4 rounded-md border border-border p-4", className)}
      data-testid="activation-panel"
      data-status={v.status}
      data-activation={v.activationId}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionLabel as="h4">Activation sweep</SectionLabel>
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag>
            {v.tier.label} tier · {v.tier.model}
          </Tag>
          <Badge tone={r.tone} data-testid="activation-status">
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            {r.label}
          </Badge>
        </div>
      </div>
      <StatBar
        label="Cost against the ceiling"
        value={`${usdc(v.chargedUsdcE6)} of at most ${usdc(v.ceilingUsdcE6)} USDC`}
        fillBps={fillBps}
      />
      <ol aria-label="Activation steps" className="flex flex-col divide-y divide-border">
        {v.steps.map((s) => (
          <Step key={s.key} step={s} now={now} />
        ))}
      </ol>
      {terminal}
      <div
        className={cn(
          "flex flex-col gap-1 rounded-md border p-3",
          v.status === "active"
            ? "border-positive"
            : v.status === "plan_ready"
              ? "border-warning"
              : v.status === "failed" || v.status === "out_of_credits"
                ? "border-negative"
                : "border-border",
        )}
        data-testid="activation-outcome"
        data-action={v.outcome.action}
      >
        <p className="text-sm font-medium">{v.outcome.title}</p>
        <p className="text-sm text-foreground-muted">{v.outcome.message}</p>
        {actions ? <div className="mt-2 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {status}
    </section>
  );
}

/**
 * The checks before a sweep may start, each with whether it passed and one
 * line the owner reads, and the sweep's ceiling on the goal's tier.
 */
function ActivationChecks({
  checks,
  ceilingUsdcE6,
  tierLabel,
  actions,
  notes,
  className,
}: {
  checks: readonly ActivationCheckView[];
  ceilingUsdcE6: string;
  tierLabel: string;
  /** UI-U1: the exact action for an unmet item, by check code, shown beside it. */
  actions?: Readonly<Record<string, ReactNode>>;
  /** UI-U1: plain words for an unmet item, by check code, in place of the platform's line. */
  notes?: Readonly<Record<string, string>>;
  className?: string;
}) {
  const blocked = checks.filter((c) => !c.ok && c.blocking);
  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="activation-checks">
      <p className="text-sm text-foreground-muted">
        Turning on automatic trading runs one activation sweep on the {tierLabel} tier, costing at
        most <span className="numeric text-foreground">{usdc(ceilingUsdcE6)}</span> USDC of credits.
        The agent reads the market, researches in depth, checks the risks and builds a plan; nothing
        is traded until you approve it.
      </p>
      <ul aria-label="Before the sweep" className="flex flex-col gap-1">
        {checks.map((c) => {
          const Icon = c.ok ? CircleCheck : c.blocking ? CircleAlert : Circle;
          const action = c.ok ? null : (actions?.[c.code] ?? null);
          const message = c.ok ? c.message : (notes?.[c.code] ?? c.message);
          return (
            <li
              key={c.code}
              className="flex flex-col gap-1 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-3"
              data-testid="activation-check"
              data-check={c.code}
              data-ok={c.ok ? "true" : "false"}
            >
              <span className="flex items-start gap-2">
                <Icon
                  aria-hidden
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    c.ok ? "text-positive" : c.blocking ? "text-warning" : "text-foreground-subtle",
                  )}
                />
                <span className={c.ok || !c.blocking ? "text-foreground-muted" : "text-warning"}>
                  {message}
                </span>
              </span>
              {action ? <span className="shrink-0 sm:pl-6">{action}</span> : null}
            </li>
          );
        })}
      </ul>
      {blocked.length > 0 ? (
        <p role="alert" className="text-sm text-warning" data-testid="activation-blocked">
          {blocked.length === 1
            ? "One thing to do before turning trading on."
            : `${blocked.length} things to do before turning trading on.`}
        </p>
      ) : null}
    </div>
  );
}

const STATUS_TAG_TONE: Readonly<Record<ActivationStatus, TagTone>> = {
  running: "accent",
  plan_ready: "warning",
  active: "accent",
  off: "neutral",
  declined: "neutral",
  expired: "neutral",
  no_plan: "neutral",
  failed: "warning",
  capped: "warning",
  out_of_credits: "warning",
};

/** The sweep's status as a small tag, for the agent viewer's badge on /configure. */
function ActivationStatusTag({
  status,
  className,
}: {
  status: ActivationStatus;
  className?: string;
}) {
  return (
    <Tag
      tone={STATUS_TAG_TONE[status]}
      size="md"
      className={cn("gap-1.5", className)}
      data-testid="activation-status-tag"
      data-status={status}
    >
      {status === "running" ? (
        <span
          aria-hidden
          className="size-1.5 rounded-full bg-primary motion-safe:animate-status-pulse"
        />
      ) : null}
      {ACTIVATION_STATUS_RENDERING[status].label}
    </Tag>
  );
}

export { ActivationChecks, ActivationPanel, ActivationStatusTag };
