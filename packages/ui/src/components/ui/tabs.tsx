"use client";

import { Tabs as TabsPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

const Tabs = TabsPrimitive.Root;

function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      // Labels never wrap; on a narrow screen the list scrolls sideways instead.
      className={cn(
        "inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border bg-surface p-1",
        className,
      )}
      {...props}
    />
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
