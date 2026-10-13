import { type VariantProps, cva } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border font-medium whitespace-nowrap",
    "transition-colors outline-none select-none",
    "is-focus:focus-ring",
    "disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary:
          "border-transparent bg-primary text-on-primary is-hover:bg-primary-hover is-hover:shadow-glow",
        // UI-FAST: one secondary style; a toggle or link that is on shows it with aria-pressed
        // or aria-current, never with a variant of its own.
        secondary:
          "border-border-strong bg-surface-raised text-foreground is-hover:border-foreground-subtle is-hover:bg-surface-overlay aria-pressed:border-primary aria-pressed:text-primary aria-[current=page]:border-primary aria-[current=page]:text-primary",
        ghost:
          "border-transparent bg-transparent text-foreground-muted is-hover:bg-surface-raised is-hover:text-foreground",
        // UI-FAST: a destructive action keeps the secondary shape, its words in the negative tone.
        danger:
          "border-border-strong bg-surface-raised text-negative is-hover:border-negative is-hover:bg-negative-surface",
      },
      // 28, 36 and 40px, from the prototype (D-154); icon buttons match md.
      size: {
        sm: "h-7 px-2.5 text-xs [&_svg]:size-3.5",
        md: "h-9 px-3.5 text-sm",
        lg: "h-10 px-4 text-sm",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  /** Render the child element (for example a link) with button styles. */
  asChild?: boolean;
  /** Shows a spinner, sets aria-busy and blocks clicks. */
  loading?: boolean;
}

function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
          {children}
        </>
      )}
    </Comp>
  );
}

export { Button, buttonVariants };
