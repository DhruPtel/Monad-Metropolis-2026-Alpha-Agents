import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

/**
 * One market figure as the platform checked it (P3-U2): its value, where it
 * came from and how old it is, and each warning in words. A refused or missing
 * value says so instead of a number. Used by the console's market view and,
 * later, the Research page.
 */
export type FigureWarningCode =
  "REFUSED_OUT_OF_RANGE" | "MISSING" | "STALE" | "SOURCES_DISAGREE" | "THIN_HISTORY";

const WARNING_LABEL: Readonly<Record<FigureWarningCode, string>> = {
  REFUSED_OUT_OF_RANGE: "Refused",
  MISSING: "Missing",
  STALE: "Stale",
  SOURCES_DISAGREE: "Sources disagree",
  THIN_HISTORY: "Thin history",
};

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  coinmarketcap: "CoinMarketCap",
  defillama: "DefiLlama",
  chainlink: "Chainlink",
  uniswap_v4: "Uniswap v4",
  computed: "Computed",
};

function SourcedFigure({
  label,
  value,
  source,
  ageText,
  warnings = [],
  className,
}: {
  label: string;
  /** The value as text; null when the platform refused it or the source gave none. */
  value: string | null;
  source: string;
  /** How old the figure is, in words, such as "2 minutes old". */
  ageText: string;
  warnings?: readonly { readonly code: FigureWarningCode; readonly message: string }[];
  className?: string;
}) {
  const refused = warnings.some((w) => w.code === "REFUSED_OUT_OF_RANGE");
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)} data-testid="sourced-figure">
      <span className="text-xs text-foreground-muted">{label}</span>
      <span
        className={cn("numeric text-base font-semibold", value === null && "text-foreground-muted")}
      >
        {value ?? (refused ? "Refused" : "Not available")}
      </span>
      <span className="text-xs text-foreground-muted">
        {SOURCE_LABEL[source] ?? source} · {ageText}
      </span>
      {warnings.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label={`${label} warnings`}>
          {warnings.map((w) => (
            <li key={`${w.code}-${w.message}`} className="flex flex-col items-start gap-0.5">
              <Badge tone={w.code === "REFUSED_OUT_OF_RANGE" ? "negative" : "warning"}>
                {WARNING_LABEL[w.code]}
              </Badge>
              <span className="text-xs text-foreground-muted">{w.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export { SourcedFigure };
