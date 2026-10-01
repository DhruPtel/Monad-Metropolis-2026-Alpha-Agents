import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-4 rounded-lg border bg-surface p-5 text-foreground shadow-raised",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="card-header" className={cn("flex flex-col gap-1", className)} {...props} />
  );
}

function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return (
    <h3 data-slot="card-title" className={cn("text-base font-semibold", className)} {...props} />
  );
}

function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="card-description"
      className={cn("text-sm text-foreground-muted", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="card-content" className={cn("flex flex-col gap-3", className)} {...props} />
  );
}

function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center gap-2 border-t pt-4", className)}
      {...props}
    />
  );
}

export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
