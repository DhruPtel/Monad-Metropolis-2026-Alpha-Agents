import { ShieldAlert, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Tag, type TagTone } from "../ui/tag";

/**
 * The Risk Sentinel as the owner reads it (P4-U2): what it watches, the
 * conditions in force, and every action it took with its reason. It only
 * ever tightens; the owner lifts a mode from their wallet after review.
 */
export interface SentinelActionView {
  readonly actionId: string;
  readonly code: string;
  /** The breach in plain words. */
  readonly text: string;
  readonly action: string;
  readonly state: string | null;
  readonly reason: string;
  readonly txHash: string | null;
  readonly status: "done" | "failed" | "skipped";
  readonly at: string;
}

export interface SentinelView {
  readonly configured: boolean;
  readonly active: Readonly<Record<string, string>>;
  readonly lastCheckedAt: string | null;
  readonly actions: readonly SentinelActionView[];
  /** The account's mode now, for the headline. */
  readonly mode: string | null;
}

const ACTION_TEXT: Readonly<Record<string, string>> = {
  REDUCE_ONLY: "Set the account to reduce-only",
  PAUSE: "Paused new risk",
  CLOSE_DEPOSITS: "Closed deposits",
  RESTRICT: "Stopped the agent's research",
  INCIDENT: "Marked an incident",
  RESUME: "Let the agent run again",
  NOTE: "Noted",
};

const actionTone = (a: SentinelActionView): TagTone =>
  a.status === "failed"
    ? "warning"
    : a.action === "NOTE" || a.action === "RESUME"
      ? "neutral"
      : a.action === "PAUSE" || a.action === "INCIDENT"
        ? "warning"
        : "accent";

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function SentinelCard({
  view: v,
  actions,
  className,
}: {
  view: SentinelView;
  actions?: ReactNode;
  className?: string;
}) {
  const active = Object.entries(v.active);
  const calm = active.length === 0;
  return (
    <Card
      className={className}
      data-testid="sentinel-card"
      data-state={calm ? "calm" : "tightened"}
    >
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            {calm ? (
              <ShieldCheck className="size-4 text-positive" aria-hidden="true" />
            ) : (
              <ShieldAlert className="size-4 text-warning" aria-hidden="true" />
            )}
            Risk sentinel
          </CardTitle>
          <div className="flex flex-wrap gap-1.5">
            {v.mode ? (
              <Tag tone={v.mode === "NORMAL" ? "neutral" : "warning"}>
                {v.mode.toLowerCase().replace(/_/g, " ")}
              </Tag>
            ) : null}
            <Tag tone={calm ? "accent" : "warning"}>
              {calm
                ? "Nothing wrong"
                : `${active.length} ${active.length === 1 ? "condition" : "conditions"} in force`}
            </Tag>
          </div>
        </div>
        <CardDescription>
          {!v.configured
            ? "The sentinel is not running on this stack."
            : "Watches every held token's price feed, screen and liquidity, the account's fall from its 7-day peak, and the agent's credits, gas, signer and permission. It can only tighten: reduce-only, pause new risk, close deposits. You lift a mode from your wallet after review; withdrawals always work."}
          {v.lastCheckedAt ? ` Last look ${when(v.lastCheckedAt)}.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {active.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" data-testid="sentinel-active">
            {active.map(([code, since]) => (
              <li key={code}>
                <Tag tone="warning" size="md">
                  {code.toLowerCase().replace(/_/g, " ")} since {when(since)}
                </Tag>
              </li>
            ))}
          </ul>
        ) : null}
        {v.actions.length === 0 ? (
          <p className="text-sm text-foreground-muted">No action so far.</p>
        ) : (
          <ol className="flex flex-col gap-2 text-sm" data-testid="sentinel-actions">
            {v.actions.map((a) => (
              <li
                key={a.actionId}
                className="flex flex-col gap-0.5"
                data-code={a.code}
                data-action={a.action}
                data-status={a.status}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="numeric text-foreground-muted">{when(a.at)}</span>
                  <Tag tone={actionTone(a)}>{ACTION_TEXT[a.action] ?? a.action}</Tag>
                  {a.status !== "done" ? (
                    <Tag tone="neutral">
                      {a.status === "failed" ? "transaction failed" : "nothing to tighten"}
                    </Tag>
                  ) : null}
                </span>
                <span className={cn(a.action === "NOTE" && "text-foreground-muted")}>
                  {a.text}: {a.reason}.
                </span>
              </li>
            ))}
          </ol>
        )}
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </CardContent>
    </Card>
  );
}

export { SentinelCard };
