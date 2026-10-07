import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/**
 * Below the `sm` breakpoint a stacked table shows each row as a block and
 * each cell under its column's name (TableCell `label`), so a wide table never
 * scrolls sideways on a phone. The header row stays for screen readers.
 */
const STACKED = [
  "max-sm:[&_thead]:sr-only",
  "max-sm:[&_tbody]:block",
  "max-sm:[&_tr]:block max-sm:[&_tr]:px-1 max-sm:[&_tr]:py-2",
  "max-sm:[&_td]:block max-sm:[&_td]:py-1.5",
  "max-sm:[&_[data-slot=table-cell-label]]:block",
].join(" ");

/**
 * `label` names the scrollable region for screen readers and keyboard users.
 * `stack` turns rows into blocks on narrow screens instead of scrolling sideways.
 */
function Table({
  className,
  label,
  stack = false,
  ...props
}: ComponentProps<"table"> & { label: string; stack?: boolean }) {
  return (
    <div
      data-slot="table-container"
      role="region"
      aria-label={label}
      tabIndex={0}
      className="relative w-full overflow-x-auto rounded-lg border outline-none is-focus:focus-ring"
    >
      <table
        data-slot="table"
        data-stack={stack ? "" : undefined}
        className={cn("w-full caption-bottom text-sm", stack && STACKED, className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("bg-surface [&_tr]:border-b", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors is-hover:bg-surface-raised aria-selected:bg-surface-overlay",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-3 text-left align-middle text-xs font-medium text-foreground-muted",
        className,
      )}
      {...props}
    />
  );
}

/** `label` is the column's name, shown above the value only when a stacked table is narrow. */
function TableCell({
  className,
  label,
  children,
  ...props
}: ComponentProps<"td"> & { label?: string }) {
  return (
    <td data-slot="table-cell" className={cn("px-3 py-2.5 align-middle", className)} {...props}>
      {label ? (
        <span
          data-slot="table-cell-label"
          aria-hidden
          className="mb-0.5 hidden text-2xs font-medium tracking-label text-foreground-muted uppercase"
        >
          {label}
        </span>
      ) : null}
      {children}
    </td>
  );
}

function TableCaption({ className, ...props }: ComponentProps<"caption">) {
  return <caption className={cn("py-3 text-xs text-foreground-muted", className)} {...props} />;
}

export { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow };
