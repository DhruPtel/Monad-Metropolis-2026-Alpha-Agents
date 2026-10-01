import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  /** Tells the user what to do next, for example "Browse the marketplace to equip your first skill." */
  description: string;
  action?: ReactNode;
  className?: string;
}

/** An empty list or panel that always points the user to an action. */
function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-strong px-6 py-10 text-center",
        className,
      )}
    >
      <Icon className="size-8 text-detail" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold text-foreground">{title}</p>
        <p className="max-w-dialog text-sm text-foreground-muted">{description}</p>
      </div>
      {action}
    </div>
  );
}

export { EmptyState };
