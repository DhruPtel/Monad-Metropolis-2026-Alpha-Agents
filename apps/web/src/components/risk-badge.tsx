import { Badge, type BadgeTone } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const RISK_LEVELS = ["conservative", "balanced", "aggressive"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Consistent everywhere: more brass as risk rises, plus 1 to 3 bars so the level never depends on color alone. */
const RISK_RENDERING: Readonly<
  Record<RiskLevel, { label: string; tone: BadgeTone; bars: number }>
> = {
  conservative: { label: "Conservative", tone: "neutral", bars: 1 },
  balanced: { label: "Balanced", tone: "detail", bars: 2 },
  aggressive: { label: "Aggressive", tone: "detail-solid", bars: 3 },
};

function RiskBadge({ level }: { level: RiskLevel }) {
  const { label, tone, bars } = RISK_RENDERING[level];
  return (
    <Badge tone={tone} data-level={level}>
      <span aria-hidden className="flex items-end gap-0.5">
        {[1, 2, 3].map((n) => (
          <span
            key={n}
            className={cn(
              "w-0.5 rounded-full bg-current",
              n === 1 ? "h-1.5" : n === 2 ? "h-2" : "h-2.5",
              n > bars && "opacity-30",
            )}
          />
        ))}
      </span>
      {label}
    </Badge>
  );
}

export { RiskBadge };
