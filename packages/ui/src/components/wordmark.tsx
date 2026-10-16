"use client";

import { useState } from "react";
import { cn } from "../lib/utils";

/**
 * 2026-10-14: the written-out Vivarium logo. The image when `src` is given and loads; the
 * word "Vivarium" as text without one or when it fails. Size it by height (className "h-7").
 */
function Wordmark({ src, className }: { src?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed)
    return (
      <span className={cn("font-semibold tracking-tight whitespace-nowrap", className)}>
        Vivarium
      </span>
    );
  return (
    <img
      src={src}
      alt="Vivarium"
      className={cn("block w-auto", className)}
      onError={() => setFailed(true)}
      data-testid="wordmark"
    />
  );
}

export { Wordmark };
