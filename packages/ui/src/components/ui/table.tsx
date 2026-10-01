import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** `label` names the scrollable region for screen readers and keyboard users. */
function Table({ className, label, ...props }: ComponentProps<"table"> & { label: string }) {
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
        className={cn("w-full caption-bottom text-sm", className)}
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

function TableCell({ className, ...props }: ComponentProps<"td">) {
  return (
    <td data-slot="table-cell" className={cn("px-3 py-2.5 align-middle", className)} {...props} />
  );
}

function TableCaption({ className, ...props }: ComponentProps<"caption">) {
  return <caption className={cn("py-3 text-xs text-foreground-muted", className)} {...props} />;
}

export { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow };
