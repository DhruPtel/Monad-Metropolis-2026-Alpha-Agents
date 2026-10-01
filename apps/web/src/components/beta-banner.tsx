import { FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

/** The "unaudited beta" label (D-145). The app shell shows it on every page. */
function BetaBanner({ environment, className }: { environment: string; className?: string }) {
  return (
    <div
      data-slot="beta-banner"
      role="note"
      className={cn(
        "flex items-center justify-center gap-2 border-b border-detail bg-surface px-4 py-1.5 text-center text-xs text-detail",
        className,
      )}
    >
      <FlaskConical className="size-3.5 shrink-0" aria-hidden />
      <span>
        <strong className="font-semibold">Unaudited beta.</strong> Contracts have not had an
        external review. Use small amounts. Environment:{" "}
        <span className="numeric">{environment}</span>
      </span>
    </div>
  );
}

export { BetaBanner };
