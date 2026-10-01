"use client";

import { CircleAlert, CircleCheck, Info, type LucideIcon } from "lucide-react";
import { Toaster as Sonner, toast } from "sonner";
import { cn } from "@/lib/utils";

export type ToastTone = "info" | "success" | "error";

const toneIcon: Record<ToastTone, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  error: CircleAlert,
};
const toneIconClass: Record<ToastTone, string> = {
  info: "text-detail",
  success: "text-positive",
  error: "text-negative",
};

const toastSurface =
  "flex w-full max-w-toast items-start gap-3 rounded-lg border bg-surface-overlay p-4 text-sm text-foreground shadow-overlay";

/** Mount once in the root layout. Toasts use the same surface as ToastSurface. */
function Toaster() {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: toastSurface,
          title: "font-medium",
          description: "text-foreground-muted",
          success: "[&_[data-icon]]:text-positive",
          error: "[&_[data-icon]]:text-negative",
          info: "[&_[data-icon]]:text-detail",
        },
      }}
    />
  );
}

/** A static toast for the /design page. */
function ToastSurface({
  tone,
  title,
  description,
}: {
  tone: ToastTone;
  title: string;
  description?: string;
}) {
  const Icon = toneIcon[tone];
  return (
    <div role="status" className={toastSurface}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", toneIconClass[tone])} aria-hidden />
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">{title}</p>
        {description ? <p className="text-foreground-muted">{description}</p> : null}
      </div>
    </div>
  );
}

export { ToastSurface, Toaster, toast };
