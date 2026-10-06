"use client";

import { Tabs as TabsPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

const Tabs = TabsPrimitive.Root;

/**
 * Labels never wrap; on a narrow screen the list scrolls sideways instead.
 * The scrolling happens in a wrapper that is itself focusable and labelled
 * (D-223, L-90): Radix manages the list's own tabindex for roving focus and
 * sets it to -1 at moments, so the list cannot be the focusable scroller.
 */
function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  const label = props["aria-label"];
  return (
    <div
      data-slot="tabs-scroll"
      role="group"
      aria-label={label ? `${label}, scrolls sideways` : "Tabs, scrolls sideways"}
      tabIndex={0}
      // The frame is on the scroller, so it keeps both ends when the tabs overflow.
      className="inline-flex max-w-full overflow-x-auto rounded-lg border bg-surface p-1 outline-none is-focus:focus-ring"
    >
      <TabsPrimitive.List
        data-slot="tabs-list"
        className={cn("inline-flex items-center gap-1", className)}
        {...props}
      />
    </div>
  );
}

function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex h-8 shrink-0 items-center justify-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-foreground-muted",
        "transition-colors outline-none",
        "is-hover:text-foreground is-focus:focus-ring",
        "data-active:bg-surface-overlay data-active:text-primary",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("pt-4 outline-none is-focus:focus-ring", className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
