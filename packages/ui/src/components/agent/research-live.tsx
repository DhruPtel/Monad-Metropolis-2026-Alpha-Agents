"use client";

import { CircleCheck, FileText, LoaderCircle } from "lucide-react";
import { type ComponentType, type ReactNode, useId } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

/**
 * UI-FAST: the Research page's view of one run: the run picker, a bubble per
 * source sized by its count, the run told in phases with their raw entries
 * behind Details, and every report as a document. Presentational: the app gives every mark, figure and line, all
 * from the run's guarded records.
 */

type LinkComponent = ComponentType<{ href: string; className?: string; children?: ReactNode }>;

export interface RunOptionView {
  readonly id: string;
  /** "2026-10-13 17:46". */
  readonly date: string;
  /** "Activation", "Routine". */
  readonly kind: string;
  /** "Medium", or "–". */
  readonly level: string;
  /** "0.41 USDC", or "–". */
  readonly spend: string;
  /** One line: the run's outcome. */
  readonly outcome: string;
  readonly live: boolean;
}

/** The runs to look at, newest first; the chosen one is pressed. */
function RunPicker({
  runs,
  selected,
  onSelect,
  className,
}: {
  runs: readonly RunOptionView[];
  selected: string | null;
  onSelect: (id: string) => void;
  className?: string;
}) {
  if (runs.length === 0)
    return <p className={cn("text-sm text-foreground-muted", className)}>No research runs yet.</p>;
  return (
    <div
      role="group"
      aria-label="Research runs"
      className={cn("flex gap-2 overflow-x-auto pb-1", className)}
      data-testid="run-picker"
    >
      {runs.map((r) => (
        <button
          key={r.id}
          type="button"
          aria-pressed={r.id === selected}
          onClick={() => onSelect(r.id)}
          data-testid="run-option"
          className={cn(
            "flex w-60 shrink-0 flex-col gap-1 rounded-md border p-2.5 text-left text-xs outline-none transition-colors is-focus:focus-ring",
            r.id === selected
              ? "border-primary bg-surface-raised"
              : "border-border hover:border-border-strong",
          )}
        >
          <span className="flex items-center gap-2">
            <span className="numeric font-medium">{r.date}</span>
            {r.live ? <Badge tone="positive">Live</Badge> : null}
          </span>
          <span className="text-foreground-muted">
            {r.kind} · {r.level} · <span className="numeric">{r.spend}</span>
          </span>
          <span className="line-clamp-1 text-foreground-muted" title={r.outcome}>
            {r.outcome}
          </span>
        </button>
      ))}
    </div>
  );
}

export interface BubbleView {
  readonly label: string;
  readonly count: number;
  /** Names under the count, as the stages completed. */
  readonly names?: readonly string[];
}

/** One bubble per source, its size by its count, each labelled; no lines between them. */
function SourceBubbles({ items, className }: { items: readonly BubbleView[]; className?: string }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <ul
      className={cn(
        "flex flex-wrap items-end justify-around gap-x-6 gap-y-4 rounded-md border border-border p-4",
        className,
      )}
      aria-label="The run's sources"
      data-testid="source-bubbles"
    >
      {items.map((i) => {
        // Area follows the count: the diameter grows with its square root, from 2.5rem to 6rem.
        const size = i.count === 0 ? 2.5 : 2.5 + 3.5 * Math.sqrt(i.count / max);
        return (
          <li
            key={i.label}
            className="flex w-28 flex-col items-center gap-1.5 text-center"
            data-testid="source-bubble"
          >
            <span
              className={cn(
                "flex items-center justify-center rounded-full border text-sm font-semibold",
                i.count === 0
                  ? "border-dashed border-border text-foreground-subtle"
                  : "border-primary-muted bg-primary/10 text-foreground",
              )}
              style={{ width: `${size}rem`, height: `${size}rem` }}
            >
              <span className="numeric">{i.count}</span>
            </span>
            <span className="text-xs text-foreground-muted">{i.label}</span>
            {i.names && i.names.length > 0 ? (
              <span className="text-2xs text-foreground-subtle">{i.names.join(", ")}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export interface PhaseCardView {
  readonly id: string;
  readonly title: string;
  readonly explainer: string;
  readonly summary: readonly string[];
  /** "17:46". */
  readonly time: string;
  readonly details: readonly {
    readonly id: string;
    readonly time: string;
    readonly text: string;
    readonly tone: "info" | "ok" | "warn" | "bad";
  }[];
}

const DOT = {
  info: "bg-primary",
  ok: "bg-positive",
  warn: "bg-warning",
  bad: "bg-negative",
} as const;

/** The run as phases: each named and explained, said in one or two sentences, its raw entries behind Details. */
function PhaseList({
  phases,
  empty,
  className,
}: {
  phases: readonly PhaseCardView[];
  empty: string;
  className?: string;
}) {
  if (phases.length === 0)
    return <p className={cn("text-sm text-foreground-muted", className)}>{empty}</p>;
  return (
    <ol className={cn("flex flex-col gap-3", className)} data-testid="phase-list">
      {phases.map((p, n) => (
        <li
          key={p.id}
          className="flex gap-3 rounded-md border border-border p-4"
          data-testid="phase"
          data-phase={p.id}
        >
          <span className="numeric flex size-6 shrink-0 items-center justify-center rounded-full border border-border-strong text-xs">
            {n + 1}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <h3 className="text-sm font-semibold">{p.title}</h3>
              <span className="text-xs text-foreground-muted">{p.explainer}</span>
              <span className="numeric ml-auto text-xs text-foreground-subtle">{p.time}</span>
            </div>
            {p.summary.map((t, i) => (
              <p key={i} className="text-sm">
                {t}
              </p>
            ))}
            {p.details.length > 0 ? (
              <details className="group text-xs">
                <summary className="w-fit cursor-pointer text-foreground-muted outline-none hover:text-foreground is-focus:focus-ring">
                  Details ({p.details.length})
                </summary>
                <ol className="mt-2 flex flex-col gap-1">
                  {p.details.map((d) => (
                    <li key={d.id} className="flex items-start gap-2">
                      <span
                        aria-hidden
                        className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", DOT[d.tone])}
                      />
                      <span className="min-w-0 flex-1 break-words text-foreground-muted">
                        {d.text}
                      </span>
                      <span className="numeric shrink-0 text-foreground-subtle">{d.time}</span>
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface DocumentRowView {
  readonly id: string;
  readonly title: string;
  /** "Activation", "Routine". */
  readonly type: string;
  /** "2026-10-13". */
  readonly date: string;
  /** Null for a report that was not written. */
  readonly href: string | null;
  /** Why there is no document, when there is none; or which run it came from. */
  readonly note?: string | null;
  /** 2026-10-13: "New" until the owner opens it. */
  readonly badge?: string | null;
}

/** Every report as a document, newest first: title, type, date, View. */
function DocumentList({
  rows,
  empty,
  linkAs,
  className,
}: {
  rows: readonly DocumentRowView[];
  empty: string;
  linkAs?: LinkComponent;
  className?: string;
}) {
  const LinkAs = linkAs ?? "a";
  if (rows.length === 0)
    return <p className={cn("text-sm text-foreground-muted", className)}>{empty}</p>;
  return (
    <ul
      className={cn(
        "flex flex-col divide-y divide-border rounded-md border border-border",
        className,
      )}
      data-testid="document-list"
    >
      {rows.map((r) => (
        <li
          key={r.id}
          className="flex items-center gap-3 px-3 py-2.5 text-sm"
          data-testid="document-row"
        >
          <FileText aria-hidden className="size-4 shrink-0 text-foreground-muted" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium" title={r.title}>
              {r.title}
              {r.badge ? (
                <Badge tone="positive" className="ml-2 align-middle">
                  {r.badge}
                </Badge>
              ) : null}
            </span>
            {r.note ? (
              <span className="block truncate text-xs text-foreground-muted">{r.note}</span>
            ) : null}
          </span>
          <Badge tone="neutral" className="hidden sm:inline-flex">
            {r.type}
          </Badge>
          <span className="numeric shrink-0 text-xs text-foreground-muted">{r.date}</span>
          {r.href ? (
            <Button asChild size="sm" variant="secondary">
              <LinkAs href={r.href}>View</LinkAs>
            </Button>
          ) : (
            <span className="w-12 text-center text-xs text-foreground-subtle">–</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * 2026-10-13: when the next research is due, at the top of the Research tab,
 * with the owner's Research now beside it and its status under it.
 */
function NextResearchStrip({
  line,
  action,
  status,
  className,
}: {
  /** "Next research: 2026-10-14 05:47 UTC", or "Scheduled research is off." */
  line: string;
  action?: ReactNode;
  status?: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label="Next research"
      className={cn("flex flex-col gap-2 rounded-md border border-border px-4 py-3", className)}
      data-testid="next-research"
    >
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm font-medium">{line}</p>
        {action ? <span className="ml-auto flex flex-wrap gap-2">{action}</span> : null}
      </div>
      {status}
    </section>
  );
}

/** One line of the branch chart: a stage that ran or a source used, and each call on it in time order. */
export interface ResearchBranchView {
  readonly id: string;
  readonly label: string;
  readonly kind: "stage" | "source";
  readonly calls: readonly { readonly id: string; readonly label: string }[];
}

const ROW = 30;
const ROOT_R = 22;
const LINE_X = 120;
const CHART_W = 640;
const TICK = 7;

/**
 * 2026-10-13: a research run as branches. The agent's art is the root on the
 * left; from it one straight line runs right per stage that ran and per
 * source used, with a short sub-branch for every call on it in time order
 * (its label on hover or focus) and the count at the line's end. It grows as
 * a live run adds calls.
 */
function ResearchBranchChart({
  art,
  branches,
  empty,
  selected = null,
  onSelectBranch,
  onSelectCall,
  className,
}: {
  /** The agent's art for the root; null draws a plain circle. */
  art: string | null;
  branches: readonly ResearchBranchView[];
  empty: string;
  /** 2026-10-13: the branch or call picked, drawn heavier. */
  selected?: string | null;
  /** A click on a line (its label or the line itself). */
  onSelectBranch?: (id: string) => void;
  /** A click on one call's sub-branch. */
  onSelectCall?: (id: string) => void;
  className?: string;
}) {
  const press = (fn: (() => void) | undefined) =>
    fn
      ? {
          role: "button",
          tabIndex: 0,
          style: { cursor: "pointer" },
          onClick: fn,
          onKeyDown: (e: { key: string; preventDefault: () => void }) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fn();
            }
          },
        }
      : {};
  const clip = `branch-root-${useId().replaceAll(":", "")}`;
  if (branches.length === 0)
    return <p className={cn("text-sm text-foreground-muted", className)}>{empty}</p>;
  const h = Math.max(branches.length * ROW + 16, ROOT_R * 2 + 16);
  const rootY = h / 2;
  const most = Math.max(1, ...branches.map((b) => b.calls.length));
  const end = CHART_W - 48;
  const step = Math.min(16, (end - LINE_X - 12) / most);
  return (
    <figure className={cn("flex flex-col gap-2", className)} data-testid="branch-chart">
      <svg
        viewBox={`0 0 ${CHART_W} ${h}`}
        className="w-full"
        role="img"
        aria-label={`The run's branches: ${branches.map((b) => `${b.label} ${b.calls.length}`).join(", ")}`}
      >
        <defs>
          <clipPath id={clip}>
            <circle cx={ROOT_R + 4} cy={rootY} r={ROOT_R} />
          </clipPath>
        </defs>
        {branches.map((b, i) => {
          const y = 8 + ROW * i + ROW / 2;
          const tone = b.kind === "stage" ? "text-primary" : "text-detail";
          return (
            <g
              key={b.id}
              className={tone}
              data-testid="branch"
              data-kind={b.kind}
              data-calls={b.calls.length}
            >
              <line
                x1={ROOT_R * 2 + 4}
                y1={rootY}
                x2={LINE_X - 64}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.4}
              />
              <g
                {...press(onSelectBranch ? () => onSelectBranch(b.id) : undefined)}
                aria-label={`${b.label}: ${b.calls.length} calls`}
                aria-pressed={onSelectBranch ? selected === b.id : undefined}
                data-testid="branch-line"
              >
                <text
                  x={LINE_X - 60}
                  y={y + 4}
                  className={cn(
                    "text-2xs",
                    selected === b.id ? "fill-foreground font-semibold" : "fill-foreground-muted",
                  )}
                  fontSize={11}
                >
                  {b.label}
                </text>
                <line
                  x1={LINE_X}
                  y1={y}
                  x2={LINE_X + Math.max(b.calls.length, 1) * step + 8}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth={selected === b.id ? 4 : 2}
                />
              </g>
              {b.calls.map((c, j) => {
                const x = LINE_X + 8 + j * step;
                return (
                  <g
                    key={c.id}
                    tabIndex={0}
                    aria-label={c.label}
                    data-testid="branch-call"
                    {...press(onSelectCall ? () => onSelectCall(c.id) : undefined)}
                  >
                    <title>{c.label}</title>
                    <line x1={x} y1={y} x2={x + TICK} y2={y - TICK} stroke="currentColor" />
                    <circle
                      cx={x + TICK}
                      cy={y - TICK}
                      r={selected === c.id ? 4 : 2}
                      fill="currentColor"
                    />
                  </g>
                );
              })}
              <text
                x={LINE_X + Math.max(b.calls.length, 1) * step + 16}
                y={y + 4}
                className="numeric fill-foreground"
                fontSize={11}
              >
                {b.calls.length}
              </text>
            </g>
          );
        })}
        {art ? (
          <image
            href={art}
            x={4}
            y={rootY - ROOT_R}
            width={ROOT_R * 2}
            height={ROOT_R * 2}
            clipPath={`url(#${clip})`}
            preserveAspectRatio="xMidYMid slice"
          />
        ) : null}
        <circle
          cx={ROOT_R + 4}
          cy={rootY}
          r={ROOT_R}
          className="text-border-strong"
          fill={art ? "none" : "currentColor"}
          fillOpacity={art ? 0 : 0.2}
          stroke="currentColor"
        />
      </svg>
      <figcaption className="flex flex-wrap gap-4 text-xs text-foreground-muted">
        <span className="text-primary">Stages</span>
        <span className="text-detail">Sources</span>
        <span>Each short branch is one call or read; hover or focus it for what it read.</span>
      </figcaption>
    </figure>
  );
}

/** Where the agent's research run stands (2026-10-13), always shown on the Research tab. */
export type RunStatusState = "running" | "writing" | "done" | "idle";

function RunStatusStrip({
  state,
  line,
  detail,
  action,
  notice,
  className,
}: {
  state: RunStatusState;
  /** "Running: Scan: reading the market", "Writing the report", "Finished at 22:41 UTC, 1.18 USDC, report ready". */
  line: string;
  /** The timer and the cost so far, while it runs. */
  detail?: string | null;
  action?: ReactNode;
  /** "New report ready", when a run finished while the page was open. */
  notice?: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label="Run status"
      aria-live="polite"
      className={cn("flex flex-col gap-2 rounded-md border border-border px-4 py-3", className)}
      data-testid="run-status"
      data-state={state}
    >
      <div className="flex flex-wrap items-center gap-3">
        {state === "running" || state === "writing" ? (
          <LoaderCircle aria-hidden className="size-4 text-primary motion-safe:animate-spin" />
        ) : state === "done" ? (
          <CircleCheck aria-hidden className="size-4 text-positive" />
        ) : null}
        <p className="text-sm font-medium">{line}</p>
        {detail ? <span className="numeric text-sm text-foreground-muted">{detail}</span> : null}
        {action ? <span className="ml-auto flex gap-2">{action}</span> : null}
      </div>
      {notice}
    </section>
  );
}

/** One call of a run, as the side panel tells it (2026-10-13). */
export interface CallDetailView {
  readonly title: string;
  /** What it looked up and why. */
  readonly what: string;
  /** What came back: titles' sites, counts, the verdict; never pasted page text. */
  readonly got: string | null;
  readonly time: string;
  readonly cost: string;
  readonly links: readonly { readonly label: string; readonly href: string }[];
}

/** The side panel for one step of a run: what it did, what came back, its time, cost and sources. */
function CallDetailPanel({
  view,
  onClose,
  className,
}: {
  view: CallDetailView;
  onClose: () => void;
  className?: string;
}) {
  return (
    <aside
      aria-label={view.title}
      className={cn("flex flex-col gap-3 rounded-md border border-border p-4", className)}
      data-testid="call-detail"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold">{view.title}</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="text-sm">{view.what}</p>
      {view.got ? <p className="text-sm">{view.got}</p> : null}
      <p className="numeric text-xs text-foreground-muted">
        {view.time} · {view.cost}
      </p>
      {view.links.length > 0 ? (
        <ul className="flex flex-wrap gap-2 text-xs">
          {view.links.map((l) => (
            <li key={l.href}>
              <a href={l.href} target="_blank" rel="noreferrer noopener" className="underline">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}

export {
  CallDetailPanel,
  RunStatusStrip,
  DocumentList,
  NextResearchStrip,
  PhaseList,
  ResearchBranchChart,
  RunPicker,
  SourceBubbles,
};
