import { type VariantProps, cva } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/**
 * Tones carry meaning, not decoration: positive is lime (active, healthy),
 * negative is red (losses, errors, stopped), warning is amber (stale data,
 * waiting on someone), detail is brass (restricted, changing state), neutral
 * is everything else.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "border-border-strong bg-surface-raised text-foreground-muted",
        positive: "border-positive bg-surface-raised text-positive",
        negative: "border-negative bg-negative-surface text-negative",
        warning: "border-warning bg-surface-raised text-warning",
        detail: "border-detail bg-surface-raised text-detail",
        "detail-solid": "border-detail bg-detail text-on-primary",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

function Badge({
  className,
  tone,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { Badge, badgeVariants };
