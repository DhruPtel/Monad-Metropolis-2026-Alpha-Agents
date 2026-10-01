"use client";

import { shortenAddress } from "@alpha-agents/domain";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";

interface AddressDisplayProps {
  address: string;
  /** Accessible name for what the address is, for example "Agent wallet". */
  label: string;
  /** Forces the copy button's look, for the /design page. */
  forceState?: "hover" | "focus" | "copied";
  className?: string;
}

/** A shortened address in monospace with a button that copies the full address. */
function AddressDisplay({ address, label, forceState, className }: AddressDisplayProps) {
  const [copied, setCopied] = useState(false);
  const showCopied = copied || forceState === "copied";

  async function copy() {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <span data-slot="address" className={cn("inline-flex items-center gap-1.5", className)}>
      <span className="numeric text-sm text-foreground" title={address}>
        {shortenAddress(address)}
      </span>
      <button
        type="button"
        onClick={copy}
        aria-label={showCopied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
        data-force={forceState === "hover" || forceState === "focus" ? forceState : undefined}
        className={cn(
          "inline-flex size-6 items-center justify-center rounded-sm text-foreground-muted transition-colors outline-none",
          "is-hover:bg-surface-raised is-hover:text-foreground is-focus:focus-ring",
          showCopied && "text-positive",
        )}
      >
        {showCopied ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
    </span>
  );
}

export { AddressDisplay };
