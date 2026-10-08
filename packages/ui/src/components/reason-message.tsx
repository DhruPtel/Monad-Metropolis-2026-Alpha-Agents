import {
  REJECTION_MESSAGES,
  type RejectionCode,
  SIGNER_REASON_MESSAGES,
  type SignerReasonCode,
  TRADE_FLOW_MESSAGES,
  type TradeFlowCode,
} from "@alpha-agents/domain";
import { CircleSlash } from "lucide-react";
import { cn } from "../lib/utils";

interface ReasonMessageProps {
  /** A policy or Executor reason, one of the signer's own (P2-U4), or the trade flow's (P2-U6). */
  code: RejectionCode | SignerReasonCode | TradeFlowCode;
  /** The policy check's detail line, for example "trade 1,050 bps of NAV". */
  detail?: string;
  className?: string;
}

/**
 * One reason the agent did not trade: the owner-facing message from
 * packages/domain's REJECTION_MESSAGES or SIGNER_REASON_MESSAGES, with the
 * code beneath it. The text is never written here, so every reason code
 * renders exactly one message.
 */
function ReasonMessage({ code, detail, className }: ReasonMessageProps) {
  return (
    <div
      data-slot="reason-message"
      data-code={code}
      className={cn("flex items-start gap-3 rounded-md border bg-surface px-4 py-3", className)}
    >
      <CircleSlash className="mt-0.5 size-4 shrink-0 text-detail" aria-hidden />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm text-foreground">
          {code in REJECTION_MESSAGES
            ? REJECTION_MESSAGES[code as RejectionCode]
            : code in TRADE_FLOW_MESSAGES
              ? TRADE_FLOW_MESSAGES[code as TradeFlowCode]
              : SIGNER_REASON_MESSAGES[code as SignerReasonCode]}
        </p>
        <p className="numeric text-xs break-words text-foreground-subtle">
          {code}
          {detail ? ` · ${detail}` : null}
        </p>
      </div>
    </div>
  );
}

export { ReasonMessage };
