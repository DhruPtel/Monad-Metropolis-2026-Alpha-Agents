import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * A plain listed panel of facts (2026-10-13): one label and value per row,
 * then at most one main and one secondary action.
 */
function InfoList({
  rows,
  primary,
  secondary,
  className,
  testId,
}: {
  rows: readonly { readonly label: string; readonly value: ReactNode; readonly testId?: string }[];
  primary?: ReactNode;
  secondary?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-4", className)} data-testid={testId}>
      <dl className="flex flex-col divide-y divide-border">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-baseline justify-between gap-4 py-2 text-sm"
            data-testid={r.testId}
          >
            <dt className="text-foreground-muted">{r.label}</dt>
            <dd className="text-right">{r.value}</dd>
          </div>
        ))}
      </dl>
      {primary || secondary ? (
        <div className="flex flex-wrap gap-2">
          {primary}
          {secondary}
        </div>
      ) : null}
    </section>
  );
}

export { InfoList };
