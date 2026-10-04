import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

type HeadingLevel = "h2" | "h3" | "h4";

/**
 * The uppercase mono label that heads a panel section ("Equipped", "What this
 * agent does"). It is a real heading, so screen readers can navigate by it;
 * pick the level that fits the page outline.
 */
function SectionLabel({
  as: Heading = "h3",
  className,
  ...props
}: ComponentProps<"h3"> & { as?: HeadingLevel }) {
  return (
    <Heading
      data-slot="section-label"
      className={cn(
        "font-mono text-2xs font-normal tracking-label text-foreground-muted uppercase",
        className,
      )}
      {...props}
    />
  );
}

export { SectionLabel };
