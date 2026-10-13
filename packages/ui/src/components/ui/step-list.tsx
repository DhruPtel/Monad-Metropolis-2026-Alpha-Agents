import { Circle, CircleAlert, CircleCheck, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/** Where one step stands: done, the one to do now, or waiting on an earlier one. */
export type StepListState = "done" | "current" | "blocked";

export interface StepListItem {
  readonly key: string;
  readonly label: string;
  readonly state: StepListState;
  /** One plain line under the label: what the step does, or why it cannot start yet. */
  readonly detail?: ReactNode;
  /** The step's own button, shown while it is the current one. */
  readonly action?: ReactNode;
}

const ICON: Readonly<Record<StepListState, LucideIcon>> = {
  done: CircleCheck,
  current: Circle,
  blocked: CircleAlert,
};
const TONE: Readonly<Record<StepListState, string>> = {
  done: "text-positive",
  current: "text-primary",
  blocked: "text-foreground-subtle",
};
const WORD: Readonly<Record<StepListState, string>> = {
  done: "done",
  current: "to do now",
  blocked: "waiting on an earlier step",
};

/**
 * An owner's actions in the order they must happen ("stake, then open
 * deposits"): each numbered, marked done, current or blocked, with one line
 * saying why a blocked step cannot start, and the current step's button.
 */
function StepList({
  steps,
  label,
  className,
}: {
  steps: readonly StepListItem[];
  label: string;
  className?: string;
}) {
  return (
    <ol
      aria-label={label}
      data-slot="step-list"
      className={cn("flex flex-col divide-y divide-border", className)}
    >
      {steps.map((s, i) => {
        const Icon = ICON[s.state];
        return (
          <li
            key={s.key}
            className="flex gap-3 py-2"
            data-testid="step-list-item"
            data-step={s.key}
            data-state={s.state}
          >
            <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", TONE[s.state])} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span
                className={cn(
                  "text-sm",
                  s.state === "blocked" ? "text-foreground-muted" : "font-medium",
                )}
              >
                {i + 1}. {s.label}
                <span className="sr-only">: {WORD[s.state]}</span>
              </span>
              {s.detail ? <p className="text-sm text-foreground-muted">{s.detail}</p> : null}
              {s.action && s.state === "current" ? (
                <div className="flex flex-wrap gap-2">{s.action}</div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export { StepList };
