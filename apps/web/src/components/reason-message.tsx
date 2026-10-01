import { REJECTION_MESSAGES, type RejectionCode } from "@alpha-agents/domain";
import { CircleSlash } from "lucide-react";
import { cn } from "@/lib/utils";

interface ReasonMessageProps {
  code: RejectionCode;
  /** The policy check's detail line, for example "trade 1,050 bps of NAV". */
  detail?: string;
  className?: string;
}

/**
 * One reason the agent did not trade: the owner-facing message from
 * packages/domain's REJECTION_MESSAGES, with the code beneath it. The text is
 * never written here, so every reason code renders exactly one message.
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
        <p className="text-sm text-foreground">{REJECTION_MESSAGES[code]}</p>
        <p className="numeric text-xs break-words text-foreground-subtle">
          {code}
          {detail ? ` · ${detail}` : null}
        </p>
      </div>
    </div>
  );
}

export { ReasonMessage };
