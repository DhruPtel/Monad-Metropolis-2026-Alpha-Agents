"use client";

import { FileText } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
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
  /** Why there is no document, when there is none. */
  readonly note?: string | null;
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

export { DocumentList, PhaseList, RunPicker, SourceBubbles };
