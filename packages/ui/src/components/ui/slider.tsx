"use client";

import { Slider as SliderPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

interface SliderProps extends ComponentProps<typeof SliderPrimitive.Root> {
  /** Accessible name for each thumb. */
  thumbLabel: string;
  /** Forces the thumb's hover or focus look, for the /design page. */
  forceThumb?: "hover" | "focus";
}

function Slider({ className, thumbLabel, forceThumb, defaultValue, value, ...props }: SliderProps) {
  const thumbs = (value ?? defaultValue ?? [0]).length;
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn(
        "relative flex w-full touch-none items-center select-none data-disabled:opacity-50",
        className,
      )}
      {...(value === undefined ? {} : { value })}
      {...(defaultValue === undefined ? {} : { defaultValue })}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-surface-overlay">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      {Array.from({ length: thumbs }, (_, i) => (
        <SliderPrimitive.Thumb
          key={i}
          aria-label={thumbLabel}
          data-force={forceThumb}
          className={cn(
            "block size-4 rounded-full border-2 border-primary bg-background shadow-raised transition-shadow outline-none",
            "is-hover:shadow-glow is-focus:focus-ring",
            "data-disabled:cursor-not-allowed",
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };
