"use client";

import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

export const tooltipSurface =
  "max-w-tooltip rounded-md border bg-surface-overlay px-3 py-1.5 text-xs text-foreground shadow-overlay";

function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(tooltipSurface, "z-50 data-open:animate-in data-open:fade-in-0", className)}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

/** A static open tooltip for the /design page. */
function TooltipSurface({ children }: { children: ReactNode }) {
  return (
    <div role="tooltip" className={tooltipSurface}>
      {children}
    </div>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipSurface, TooltipTrigger };
