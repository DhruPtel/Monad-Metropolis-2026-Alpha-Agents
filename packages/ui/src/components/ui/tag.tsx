import { type VariantProps, cva } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/**
 * A small square-cornered label for a category or a rarity (Common, Rare,
 * Legendary). Unlike Badge it carries no status meaning; the tone only marks
 * rarity or emphasis.
 */
const tagVariants = cva(
  "inline-flex w-fit shrink-0 items-center rounded-xs border leading-none whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "border-border text-foreground-muted",
        rare: "border-rare/50 text-rare",
        legendary: "border-detail/50 text-detail",
        accent: "border-primary-muted text-primary",
        warning: "border-warning/50 text-warning",
      },
      size: {
        sm: "h-4.5 px-1.5 text-2xs",
        md: "h-5.5 px-1.5 text-xs",
      },
    },
    defaultVariants: { tone: "neutral", size: "sm" },
  },
);

export type TagTone = NonNullable<VariantProps<typeof tagVariants>["tone"]>;

function Tag({
  className,
  tone,
  size,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof tagVariants>) {
  return <span data-slot="tag" className={cn(tagVariants({ tone, size }), className)} {...props} />;
}

export { Tag, tagVariants };
