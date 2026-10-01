import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "../lib/utils";

interface StatBarProps {
  label: string;
  /** The formatted value, for example "58%" or "+3.1%". */
  value: string;
  /** Bar fill in basis points, 0 to 10,000. */
  fillBps: number;
  /** An optional preview change, shown next to the value. */
  delta?: { direction: "positive" | "negative"; text: string };
  className?: string;
}

/** A labelled stat with a bar and an optional positive or negative delta. */
function StatBar({ label, value, fillBps, delta, className }: StatBarProps) {
  const clamped = Math.min(10_000, Math.max(0, Math.round(fillBps)));
  return (
    <div data-slot="stat-bar" className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-foreground-muted">{label}</span>
        <span className="flex items-baseline gap-2">
          <span className="numeric text-sm text-foreground">{value}</span>
          {delta ? (
            <span
              className={cn(
                "numeric inline-flex items-center text-xs",
                delta.direction === "positive" ? "text-positive" : "text-negative",
              )}
            >
              {delta.direction === "positive" ? (
                <ArrowUp className="size-3" aria-label="up" />
              ) : (
                <ArrowDown className="size-3" aria-label="down" />
              )}
              {delta.text}
            </span>
          ) : null}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={10_000}
        aria-valuenow={clamped}
        aria-valuetext={value}
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-overlay"
      >
        <div
          className="h-full origin-left rounded-full bg-primary"
          style={{ transform: `scaleX(${clamped / 10_000})` }}
        />
      </div>
    </div>
  );
}

export { StatBar };
