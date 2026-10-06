import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

/**
 * An agent's runtime (P1-U5): whether the orchestrator has provisioned it
 * (config rendered, LiteLLM key created), and the outcome of a task run in its
 * sandbox. Used by the dev console's agents panel; shown on /design.
 */
export const RUNTIME_STATUSES = [
  "not_provisioned",
  "provisioning",
  "ready",
  "deprovisioning",
  "deprovisioned",
  "failed",
] as const;
export type RuntimeStatus = (typeof RUNTIME_STATUSES)[number];

export const RUNTIME_STATUS_RENDERING: Readonly<
  Record<
    RuntimeStatus,
    { readonly label: string; readonly tone: BadgeTone; readonly meaning: string }
  >
> = {
  not_provisioned: {
    label: "Not provisioned",
    tone: "neutral",
    meaning: "Waiting for its reveal, or for the orchestrator",
  },
  provisioning: { label: "Provisioning", tone: "warning", meaning: "Config and key being set up" },
  ready: { label: "Provisioned", tone: "positive", meaning: "Config rendered and key created" },
  deprovisioning: { label: "Deprovisioning", tone: "warning", meaning: "Key being deleted" },
  deprovisioned: { label: "Deprovisioned", tone: "neutral", meaning: "Key deleted" },
  failed: { label: "Provisioning failed", tone: "negative", meaning: "Retried automatically" },
};

function RuntimeStatusBadge({ status }: { status: RuntimeStatus }) {
  const r = RUNTIME_STATUS_RENDERING[status];
  return (
    <Badge tone={r.tone} title={r.meaning} data-runtime-status={status}>
      {r.label}
    </Badge>
  );
}

export const TASK_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const TASK_RENDERING: Readonly<Record<TaskStatus, { label: string; tone: BadgeTone }>> = {
  queued: { label: "Queued", tone: "warning" },
  running: { label: "Running", tone: "detail" },
  succeeded: { label: "Succeeded", tone: "positive" },
  failed: { label: "Failed", tone: "negative" },
};

export interface TaskResultField {
  readonly label: string;
  readonly value: ReactNode;
}

export interface TaskResultProps {
  readonly title: string;
  readonly description?: string;
  readonly status: TaskStatus;
  /** The structured result, one row each; shown when there is one. */
  readonly fields?: readonly TaskResultField[];
  /** Plain words for a failure. */
  readonly error?: string | null;
  readonly className?: string;
}

/** A task's status and structured result: a badge, label and value rows, and the error. */
function TaskResult({ title, description, status, fields, error, className }: TaskResultProps) {
  const r = TASK_RENDERING[status];
  return (
    <Card className={className} data-testid="task-result" data-task-status={status}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{title}</CardTitle>
          <Badge tone={r.tone}>{r.label}</Badge>
        </div>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {fields && fields.length > 0 ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            {fields.map((f) => (
              <div key={f.label} className="contents">
                <dt className="text-foreground-muted">{f.label}</dt>
                <dd className="numeric break-words">{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {error ? (
          <p role="status" className="text-sm text-negative" data-testid="task-error">
            {error}
          </p>
        ) : null}
        {status === "queued" || status === "running" ? (
          <p className="text-sm text-foreground-muted" role="status">
            {status === "queued"
              ? "Waiting for a worker."
              : "Starting the sandbox and running the task."}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export { RuntimeStatusBadge, TaskResult };
