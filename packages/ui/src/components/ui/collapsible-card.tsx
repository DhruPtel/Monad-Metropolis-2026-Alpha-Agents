import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * A card that folds to its title row (2026-10-13): the same surface, border,
 * padding and full-size title as Card, never toned down; closed, it shows the
 * section's current value beside the title.
 */
function CollapsibleCard({
  title,
  value,
  children,
  defaultOpen = false,
  className,
  testId,
}: {
  title: string;
  /** The current value, shown at the right of the title row. */
  value?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <details
      open={defaultOpen}
      data-slot="collapsible-card"
      data-testid={testId}
      className={cn(
        "group rounded-lg border bg-surface p-5 text-foreground shadow-raised",
        className,
      )}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 outline-none is-focus:focus-ring [&::-webkit-details-marker]:hidden">
        <h3 className="flex-1 text-base font-semibold">{title}</h3>
        {value !== undefined ? (
          <span className="text-sm text-foreground" data-testid="collapsible-card-value">
            {value}
          </span>
        ) : null}
        <ChevronDown
          aria-hidden
          className="size-4 text-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="mt-4 flex flex-col gap-3">{children}</div>
    </details>
  );
}

export { CollapsibleCard };
