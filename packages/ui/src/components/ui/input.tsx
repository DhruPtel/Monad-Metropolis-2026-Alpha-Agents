import { type ComponentProps, type ReactNode, useId } from "react";
import { cn } from "../../lib/utils";

/** Shared look for text-like controls: Input and the Select trigger. */
export const fieldControl = cn(
  "flex h-9 w-full min-w-0 rounded-md border border-border-strong bg-surface-raised px-3 text-sm text-foreground",
  "transition-colors outline-none placeholder:text-foreground-subtle",
  "is-hover:border-foreground-subtle is-focus:focus-ring",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "aria-invalid:border-negative",
);

function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn(fieldControl, className)} {...props} />;
}

interface FieldProps {
  label: string;
  /** Help text under the control. */
  hint?: string;
  /** Error text; when set the control is marked invalid. */
  error?: string;
  className?: string;
  children: (control: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: true;
  }) => ReactNode;
}

/** A labelled control with optional hint and error, wired for screen readers. */
function Field({ label, hint, error, className, children }: FieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div data-slot="field" className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children({
        id,
        ...(note ? { "aria-describedby": noteId } : {}),
        ...(error ? { "aria-invalid": true as const } : {}),
      })}
      {note ? (
        <p id={noteId} className={cn("text-xs", error ? "text-negative" : "text-foreground-muted")}>
          {note}
        </p>
      ) : null}
    </div>
  );
}

export { Field, Input };
