"use client";

import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { type ReactNode, useId } from "react";
import { cn } from "../../lib/utils";

/**
 * One choice among a few, each shown as a card with its numbers (P3-U1): the
 * goal's template, risk preset, assets, model, intensity and plan-change
 * setting. A radio group underneath, so arrow keys move the choice and a
 * screen reader hears the legend, each option and its description.
 */
export interface ChoiceOption<V extends string> {
  readonly value: V;
  readonly title: string;
  /** One plain sentence on what the choice means. */
  readonly description?: string;
  /** The choice's numbers, shown under the description. */
  readonly detail?: ReactNode;
  /** A short note beside the title, such as "Default" or "Available later". */
  readonly note?: string;
  readonly disabled?: boolean;
}

function ChoiceGroup<V extends string>({
  legend,
  hint,
  value,
  onValueChange,
  options,
  columns = 3,
  disabled = false,
  className,
}: {
  legend: string;
  /** A short plain explanation under the legend. */
  hint?: string;
  value: V;
  onValueChange: (value: V) => void;
  options: readonly ChoiceOption<V>[];
  /** Columns from the small breakpoint up; one column on a phone. */
  columns?: 2 | 3;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div data-slot="choice-group" className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-col gap-0.5">
        <span id={`${id}-legend`} className="text-sm font-medium text-foreground">
          {legend}
        </span>
        {hint ? (
          <p id={`${id}-hint`} className="text-xs text-foreground-muted">
            {hint}
          </p>
        ) : null}
      </div>
      <RadioGroupPrimitive.Root
        aria-labelledby={`${id}-legend`}
        {...(hint ? { "aria-describedby": `${id}-hint` } : {})}
        value={value}
        onValueChange={(v) => onValueChange(v as V)}
        disabled={disabled}
        className={cn("grid gap-2", columns === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3")}
      >
        {options.map((o) => (
          <RadioGroupPrimitive.Item
            key={o.value}
            value={o.value}
            disabled={o.disabled ?? false}
            {...(o.description ? { "aria-describedby": `${id}-${o.value}-d` } : {})}
            className={cn(
              "flex min-w-0 flex-col items-start gap-1 rounded-md border border-border bg-surface-raised p-3 text-left",
              "transition-colors outline-none is-hover:border-foreground-subtle is-focus:focus-ring",
              "data-[state=checked]:border-primary data-[state=checked]:bg-surface-overlay",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span className="text-sm font-semibold text-foreground">{o.title}</span>
              {o.note ? (
                <span className="text-2xs whitespace-nowrap text-foreground-muted">{o.note}</span>
              ) : null}
            </span>
            {o.description ? (
              <span id={`${id}-${o.value}-d`} className="text-xs text-foreground-muted">
                {o.description}
              </span>
            ) : null}
            {o.detail ? <span className="numeric text-xs text-foreground">{o.detail}</span> : null}
          </RadioGroupPrimitive.Item>
        ))}
      </RadioGroupPrimitive.Root>
    </div>
  );
}

export { ChoiceGroup };
