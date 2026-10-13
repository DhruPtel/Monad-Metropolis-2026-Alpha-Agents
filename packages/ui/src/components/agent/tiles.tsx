import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * Fact tiles (UI-U2, made compact in UI-FAST: no large tiles anywhere): a
 * label, one value, a plain note that says what it means, and the next
 * action beside it. About four across on a desktop, two on a phone. Pages
 * build their at-a-glance rows from these.
 */
export const TILE_CLASS = "flex flex-col gap-1 rounded-md border bg-surface p-3";

export type TileTone = "neutral" | "positive" | "negative" | "warning" | "accent";

const VALUE_TONE: Readonly<Record<TileTone, string>> = {
  neutral: "text-foreground",
  positive: "text-positive",
  negative: "text-negative",
  warning: "text-warning",
  accent: "text-primary",
};

function FactTile({
  label,
  value,
  note,
  action,
  tone = "neutral",
  numeric = true,
  testId,
  state,
  className,
}: {
  label: string;
  /** The one thing the tile says: a figure, a word, a short phrase. */
  value: ReactNode;
  /** What it means, in plain words. */
  note?: ReactNode | undefined;
  /** The next action: a link or a button. */
  action?: ReactNode | undefined;
  tone?: TileTone | undefined;
  /** Tabular figures; off for a word or a phrase. */
  numeric?: boolean | undefined;
  testId?: string | undefined;
  /** For tests and styling: "waiting", "ready", a state word. */
  state?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <div
      className={cn(TILE_CLASS, className)}
      data-slot="fact-tile"
      data-testid={testId}
      data-state={state}
    >
      <span className="text-xs text-foreground-muted">{label}</span>
      <span
        className={cn(
          "text-base leading-tight font-semibold break-words",
          numeric && "numeric",
          VALUE_TONE[tone],
        )}
      >
        {value}
      </span>
      <span className="flex flex-col gap-2">
        {note ? <span className="text-xs text-foreground-muted">{note}</span> : null}
        {action}
      </span>
    </div>
  );
}

/** Fact tiles in a row: two on a phone, `columns` across from the small breakpoint. */
function TileGrid({
  columns = 4,
  label,
  children,
  className,
  testId,
}: {
  columns?: 2 | 3 | 4 | undefined;
  /** Names the row for screen readers. */
  label: string;
  children: ReactNode;
  className?: string | undefined;
  testId?: string | undefined;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
      className={cn(
        "grid grid-cols-2 gap-3",
        columns === 2 && "sm:grid-cols-2 max-w-2xl",
        columns === 3 && "sm:grid-cols-3 max-w-3xl",
        columns === 4 && "sm:grid-cols-4 max-w-4xl",
        className,
      )}
    >
      {children}
    </div>
  );
}

export { FactTile, TileGrid };
