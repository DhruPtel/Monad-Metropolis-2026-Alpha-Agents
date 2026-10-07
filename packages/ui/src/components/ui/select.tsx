"use client";

import { Check, ChevronDown } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
import { fieldControl } from "./input";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        fieldControl,
        "items-center justify-between gap-2 data-placeholder:text-foreground-subtle",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 text-foreground-muted" aria-hidden />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/** The open menu's panel. Exported for the /design preview of the open state. */
export const selectMenu =
  "z-50 min-w-32 overflow-hidden rounded-md border bg-surface-overlay p-1 text-foreground shadow-overlay";
export const selectItem = cn(
  "relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none",
  "is-hover:bg-surface-raised data-highlighted:bg-surface-raised",
  "data-disabled:pointer-events-none data-disabled:opacity-50",
);

function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={4}
        className={cn(
          selectMenu,
          // A long list (25 species) never runs off a short screen: the menu stops at
          // the space Radix measures, and its viewport scrolls (L-101).
          "max-h-(--radix-select-content-available-height)",
          "data-[side=bottom]:slide-in-from-top-2 data-open:animate-in data-open:fade-in-0",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item data-slot="select-item" className={cn(selectItem, className)} {...props}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4 text-primary" aria-hidden />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

/** A static rendering of an open menu, for the /design page. */
function SelectMenuPreview({
  items,
  selected,
  highlighted,
}: {
  items: readonly string[];
  selected: string;
  highlighted: string;
}) {
  return (
    <div role="listbox" aria-label="Open select preview" className={cn(selectMenu, "w-full")}>
      {items.map((item) => (
        <div
          key={item}
          role="option"
          aria-selected={item === selected}
          data-force={item === highlighted ? "hover" : undefined}
          className={selectItem}
        >
          {item}
          {item === selected ? (
            <Check className="absolute right-2 size-4 text-primary" aria-hidden />
          ) : null}
        </div>
      ))}
    </div>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectMenuPreview,
  SelectTrigger,
  SelectValue,
};
