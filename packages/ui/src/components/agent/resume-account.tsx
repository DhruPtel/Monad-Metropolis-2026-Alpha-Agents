import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { type WalletActionState, WalletActionStatus } from "./portfolio";

/**
 * Resume account (2026-10-17): the owner's way back to NORMAL after the
 * sentinel tightened the trading account (reduce-only or paused). Only the
 * owner can call the account's unpause(); the panel says why the account was
 * tightened, offers the one button, and shows where the wallet action is.
 * When the connected wallet cannot do it, the reason stands in for the button.
 * Pure: the page passes every word in.
 */
export interface ResumeAccountStatus {
  readonly state: WalletActionState;
  readonly text: string;
  readonly hash: string | null;
}

function ResumeAccountPanel({
  reason,
  blocker,
  busy,
  status,
  onResume,
  compact = false,
  className,
}: {
  /** Why the account is tightened and what it blocks, in plain words. */
  reason: string;
  /** Why the connected wallet cannot resume it (not connected, not the owner), or null. */
  blocker: string | null;
  busy: boolean;
  status: ResumeAccountStatus | null;
  onResume: () => void;
  /** Inline on a checklist line: the line already carries the reason. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col gap-2", compact && "sm:items-end", className)}
      data-testid="resume-account"
      data-blocked={blocker ? "true" : "false"}
    >
      {compact ? null : (
        <p role="alert" className="text-sm text-warning" data-testid="resume-account-reason">
          {reason}
        </p>
      )}
      {blocker ? (
        <p className="text-sm text-foreground-muted" data-testid="resume-account-blocker">
          {blocker}
        </p>
      ) : (
        <Button
          size="sm"
          className="w-fit"
          disabled={busy}
          onClick={onResume}
          data-testid="resume-account-button"
        >
          Resume account
        </Button>
      )}
      {status ? (
        <WalletActionStatus state={status.state} text={status.text} hash={status.hash} />
      ) : null}
    </div>
  );
}

export { ResumeAccountPanel };
