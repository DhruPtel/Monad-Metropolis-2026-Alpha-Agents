import { cn } from "../../lib/utils";
import { Badge, type BadgeTone } from "../ui/badge";

/**
 * An agent's activity (P1-U7): the owner-readable entries the narrator writes
 * after each task, and the status of each tool call the agent made. Used by
 * the dev console's agents panel and, later, the agent profile and My Agents
 * page (FINAL_PLAN 4.10); shown on /design.
 */
export const TOOL_CALL_STATUSES = ["running", "succeeded", "failed", "refused"] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

export const TOOL_CALL_RENDERING: Readonly<
  Record<
    ToolCallStatus,
    { readonly label: string; readonly tone: BadgeTone; readonly meaning: string }
  >
> = {
  running: { label: "Running", tone: "detail", meaning: "Charged; waiting for the answer" },
  succeeded: { label: "Answered", tone: "positive", meaning: "Answered and charged" },
  failed: { label: "Failed", tone: "negative", meaning: "Not answered; the charge was reversed" },
  refused: { label: "Refused", tone: "warning", meaning: "Refused before it ran; not charged" },
};

/** A tool call's status; the refusal or failure code, if any, is its title. */
function ToolCallStatusBadge({ status, code }: { status: ToolCallStatus; code?: string | null }) {
  const r = TOOL_CALL_RENDERING[status];
  return (
    <Badge
      tone={r.tone}
      title={code ? `${r.meaning} (${code})` : r.meaning}
      data-tool-status={status}
    >
      {r.label}
    </Badge>
  );
}

export interface ActivityItem {
  readonly entryId: string;
  /** The entry's text: the narrator's, checked against its facts, or the fixed template's. */
  readonly text: string;
  /** ISO 8601. */
  readonly at: string;
  readonly renderedBy: "narrator" | "template";
}

/** A fixed, timezone-free rendering, so a page reads the same everywhere. */
const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** Activity entries, newest first, with when each was written and who wrote it. */
function ActivityFeed({
  entries,
  label,
  empty = "No activity yet.",
  className,
}: {
  entries: readonly ActivityItem[];
  /** Names the list for screen readers. */
  label: string;
  empty?: string;
  className?: string;
}) {
  if (entries.length === 0)
    return (
      <p className={cn("text-sm text-foreground-muted", className)} data-testid="activity-empty">
        {empty}
      </p>
    );
  return (
    <ol
      aria-label={label}
      className={cn("flex flex-col gap-3", className)}
      data-testid="activity-feed"
    >
      {entries.map((e) => (
        <li key={e.entryId} className="flex flex-col gap-1 border-l-2 border-border-strong pl-3">
          <p className="text-sm break-words text-foreground">{e.text}</p>
          <p className="flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
            <time dateTime={e.at} className="numeric">
              {when(e.at)}
            </time>
            <Badge
              tone="neutral"
              title={
                e.renderedBy === "narrator"
                  ? "Written by the narrator; every number checked against the agent's records"
                  : "Written from a fixed template, from the agent's records"
              }
            >
              {e.renderedBy === "narrator" ? "Narrator" : "Template"}
            </Badge>
          </p>
        </li>
      ))}
    </ol>
  );
}

export { ActivityFeed, ToolCallStatusBadge };
