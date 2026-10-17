"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { ResumeAccountPanel } from "@alpha-agents/ui";
import type { Address } from "viem";
import type { SentinelJson } from "@/api/client";
import {
  pausedBySentinel,
  resumeBlocker,
  resumeReason,
  resumeStatusText,
} from "@/agent/resume-account";
import { useAccountTx } from "@/agent/use-account-tx";
import { useWalletSession } from "@/auth/session";

/**
 * Resume account (2026-10-17): the owner's unpause() on the trading account after
 * the sentinel set it to reduce-only or paused it, from the connected owner wallet.
 * Shown wherever the account's mode is not NORMAL: the Trading tab's checklist line,
 * the Overview's trading account panel and the Research tab's sentinel card.
 */
export function ResumeAccount({
  environment,
  account,
  mode,
  owner,
  actions,
  onResumed,
  compact = false,
}: {
  environment: EnvironmentId;
  account: Address;
  mode: string;
  /** The account's owner when the page has it; null leaves ownership to the owner session. */
  owner: Address | null;
  /** The sentinel's actions, for why the account was tightened; empty until read. */
  actions: SentinelJson["actions"];
  /** After the resume confirmed: re-read the page (the checklist, the mode). */
  onResumed: () => void;
  compact?: boolean;
}) {
  const wallet = useWalletSession();
  const tx = useAccountTx(environment);
  const reason = resumeReason(mode, pausedBySentinel(actions));
  const blocker = resumeBlocker({ connected: wallet.address ?? null, owner });
  const status = tx.progress
    ? {
        state: tx.progress.state,
        text: resumeStatusText(tx.progress.state, tx.text ?? ""),
        hash: tx.progress.hash ?? null,
      }
    : null;
  return (
    <ResumeAccountPanel
      reason={reason}
      blocker={blocker}
      busy={tx.busy}
      status={status}
      compact={compact}
      onResume={() =>
        void tx
          .send(
            "Resume the account",
            account,
            { functionName: "unpause", args: [] },
            "The account is back to normal. You can turn on automatic trading.",
          )
          .then((p) => {
            if (p?.state === "confirmed") onResumed();
          })
      }
    />
  );
}
