"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Tag,
  toast,
} from "@alpha-agents/ui";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { clearSentinelAction, sentinelTickAction, stallFeedAction } from "./sentinel-actions";

/** The orchestrator's sentinel read, as the console shows it. */
export interface SentinelLoopJson {
  readonly configured: boolean;
  readonly sentinelAddress: string | null;
  readonly active: Readonly<Record<string, string>>;
  readonly lastCheckedAt: string | null;
  readonly actions: readonly {
    readonly actionId: string;
    readonly code: string;
    readonly text: string;
    readonly action: string;
    readonly state: string | null;
    readonly reason: string;
    readonly txHash: string | null;
    readonly status: "done" | "failed" | "skipped";
    readonly at: string;
  }[];
}

const when = (iso: string | null) =>
  iso ? `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` : "never";

/**
 * The Risk Sentinel's playtest tools (P4-U2): the conditions in force and
 * the actions with their reasons, a pass now, the feed drill and an
 * operator's clearing after review. The market mover above it drives the
 * drawdown drills. Everything here exists on the local fork only.
 */
export function SentinelControls({ agentId, view }: { agentId: string; view: SentinelLoopJson }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const act = (
    label: string,
    run: () => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>,
  ) =>
    start(async () => {
      const r = await run();
      if (!r.ok) {
        toast.error(`${label} did not happen`, { description: r.error });
        return;
      }
      toast.success(label);
      router.refresh();
    });
  const active = Object.entries(view.active);
  return (
    <Card data-testid="sentinel-controls">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Risk sentinel</CardTitle>
          <div className="flex flex-wrap gap-1.5">
            <Tag tone={view.configured ? "accent" : "warning"}>
              {view.configured ? "sentinel on" : "sentinel off"}
            </Tag>
            {view.sentinelAddress ? (
              <Tag>
                key {view.sentinelAddress.slice(0, 6)}…{view.sentinelAddress.slice(-4)}
              </Tag>
            ) : null}
            <Tag tone={active.length === 0 ? "neutral" : "warning"}>
              {active.length === 0 ? "nothing in force" : `${active.length} in force`}
            </Tag>
          </div>
        </div>
        <CardDescription>
          Tighten-only through the sentinel key (D-138): reduce-only, pause new risk, close
          deposits; the agent state RESTRICTED or INCIDENT with the reason. Last look{" "}
          {when(view.lastCheckedAt)}.
          {active.length > 0
            ? ` In force: ${active.map(([code, since]) => `${code} since ${when(since)}`).join("; ")}.`
            : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={pending}
            loading={pending}
            onClick={() => act("One pass of the sentinel", sentinelTickAction)}
          >
            Run a pass now
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => act("MON/USD feed stalled", () => stallFeedAction(true))}
          >
            Stall the MON feed
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => act("MON/USD feed restored", () => stallFeedAction(false))}
          >
            Restore the feed
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={pending}
            onClick={() => act("State cleared after review", () => clearSentinelAction(agentId))}
          >
            Clear the agent state
          </Button>
        </div>
        {view.actions.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm" data-testid="console-sentinel-actions">
            {view.actions.slice(0, 10).map((a) => (
              <li key={a.actionId} className="flex flex-wrap items-center gap-2">
                <span className="numeric text-foreground-muted">{when(a.at)}</span>
                <span className="font-mono text-xs">{a.code}</span>
                <Badge
                  tone={
                    a.status === "failed"
                      ? "negative"
                      : a.action === "NOTE" || a.action === "RESUME"
                        ? "neutral"
                        : "warning"
                  }
                >
                  {a.action}
                  {a.status !== "done" ? ` (${a.status})` : ""}
                </Badge>
                <span className="text-foreground-muted">{a.reason}</span>
                {a.txHash ? (
                  <span className="font-mono text-xs text-foreground-muted">
                    {a.txHash.slice(0, 10)}…
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-foreground-muted">No action so far.</p>
        )}
      </CardContent>
    </Card>
  );
}
