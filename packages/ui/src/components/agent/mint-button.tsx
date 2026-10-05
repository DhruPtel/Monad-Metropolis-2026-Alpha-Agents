"use client";

import { CheckCircle2, ExternalLink, Hourglass, X } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

/**
 * Every state of minting an agent (P1-U11, from the prototype's mint control):
 * asking the platform for a claim, signing in the wallet, the transaction in
 * flight, waiting for the reveal, revealed, and the three ways it ends early.
 * Presentational only: the app runs the mint and passes the state in.
 */
export const MINT_STATES = [
  "idle",
  "claiming",
  "signing",
  "minting",
  "awaiting-reveal",
  "revealed",
  "rejected",
  "claim-refused",
  "error",
] as const;
export type MintState = (typeof MINT_STATES)[number];

const BUTTON_LABEL: Readonly<Record<MintState, string>> = {
  idle: "Mint an agent",
  claiming: "Getting your claim",
  signing: "Confirm in wallet",
  minting: "Minting",
  "awaiting-reveal": "Waiting for reveal",
  revealed: "Agent revealed",
  rejected: "Mint an agent",
  "claim-refused": "Mint unavailable",
  error: "Try again",
};

const BUSY: ReadonlySet<MintState> = new Set(["claiming", "signing", "minting"]);

export interface MintButtonProps {
  readonly state: MintState;
  /** The minted agent, once known. */
  readonly agentId?: bigint | undefined;
  /** Tier and species once revealed, for example "Pro · Bee". */
  readonly revealedAs?: string | undefined;
  /** The reason, for claim-refused and error. */
  readonly message?: string | undefined;
  /** A link to the mint transaction, when the chain has an explorer. */
  readonly explorerUrl?: string | undefined;
  readonly onMint?: (() => void) | undefined;
  readonly onDismiss?: (() => void) | undefined;
  readonly className?: string | undefined;
}

function statusLine(
  props: MintButtonProps,
): { tone: "muted" | "positive" | "negative"; text: string } | null {
  const id = props.agentId !== undefined ? `#${props.agentId.toString()}` : "";
  switch (props.state) {
    case "minting":
      return { tone: "muted", text: "Waiting for the transaction to confirm" };
    case "awaiting-reveal":
      return { tone: "muted", text: `Agent ${id} minted. Its tier and species appear at reveal.` };
    case "revealed":
      return { tone: "positive", text: `Agent ${id} is ${props.revealedAs ?? "revealed"}` };
    case "rejected":
      return { tone: "negative", text: "Rejected in wallet" };
    case "claim-refused":
      return { tone: "negative", text: props.message ?? "No mint claim for this wallet" };
    case "error":
      return { tone: "negative", text: props.message ?? "The mint failed" };
    default:
      return null;
  }
}

function MintButton(props: MintButtonProps) {
  const { state, onMint, onDismiss, explorerUrl, className } = props;
  const busy = BUSY.has(state);
  const done = state === "awaiting-reveal" || state === "revealed" || state === "claim-refused";
  const status = statusLine(props);
  return (
    <div
      data-slot="mint-button"
      data-state={state}
      className={cn("flex flex-col gap-2", className)}
    >
      <Button
        variant={done ? "secondary" : "primary"}
        loading={busy}
        disabled={done || !onMint}
        onClick={onMint}
      >
        {state === "awaiting-reveal" ? <Hourglass aria-hidden /> : null}
        {state === "revealed" ? <CheckCircle2 aria-hidden /> : null}
        {BUTTON_LABEL[state]}
      </Button>
      {status ? (
        <div
          role="status"
          className={cn(
            "flex items-start justify-between gap-3 rounded-md border bg-surface px-3 py-2 text-xs",
            status.tone === "negative" && "border-negative text-negative",
            status.tone === "positive" && "border-primary-muted text-positive",
            status.tone === "muted" && "border-border text-foreground-muted",
          )}
        >
          <span className="flex min-w-0 flex-col gap-1">
            <span className="break-words">{status.text}</span>
            {explorerUrl ? (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-2xs text-foreground-muted outline-none is-hover:text-foreground is-focus:focus-ring"
              >
                View transaction <ExternalLink aria-hidden className="size-3" />
              </a>
            ) : null}
          </span>
          {onDismiss && !busy ? (
            <button
              type="button"
              aria-label="Dismiss"
              onClick={onDismiss}
              className="shrink-0 rounded-xs text-foreground-muted outline-none is-hover:text-foreground is-focus:focus-ring"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export { MintButton };
