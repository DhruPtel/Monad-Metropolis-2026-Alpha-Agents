import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** A loading placeholder. Size it with layout utilities from the spacing scale. */
function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn("animate-pulse rounded-md bg-surface-overlay", className)}
      {...props}
    />
  );
}

export { Skeleton };
