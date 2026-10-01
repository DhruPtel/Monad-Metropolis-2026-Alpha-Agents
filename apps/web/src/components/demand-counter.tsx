import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface DemandCounterProps {
  icon: LucideIcon;
  /** What is counted, for example "Watchers". */
  label: string;
  count: number;
  /** Change since yesterday; omitted or zero shows no change. */
  dailyChange?: number;
  className?: string;
}

const grouped = (n: number) =>
  Math.abs(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A demand counter: icon, count and the small daily change. */
function DemandCounter({
  icon: Icon,
  label,
  count,
  dailyChange = 0,
  className,
}: DemandCounterProps) {
  const change =
    dailyChange > 0
      ? `+${grouped(dailyChange)}`
      : dailyChange < 0
        ? `-${grouped(dailyChange)}`
        : "0";
  return (
    <div data-slot="demand-counter" className={cn("flex items-center gap-2", className)}>
      <Icon className="size-4 text-detail" aria-hidden />
      <span className="numeric text-sm text-foreground">{grouped(count)}</span>
      <span className="text-xs text-foreground-muted">{label}</span>
      <span
        className={cn(
          "numeric text-xs",
          dailyChange > 0
            ? "text-positive"
            : dailyChange < 0
              ? "text-negative"
              : "text-foreground-subtle",
        )}
        aria-label={`${change} today`}
      >
        {change}
      </span>
    </div>
  );
}

export { DemandCounter };
