"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tag,
  toast,
} from "@alpha-agents/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  fastCadenceAction,
  fireTriggerAction,
  moveMarketAction,
  pauseResearchAction,
  researchTickAction,
} from "./research-actions";

/** What the orchestrator's research read says about the loop, as the console shows it. */
export interface ResearchLoopJson {
  readonly running: boolean;
  readonly schedulingOn: boolean;
  readonly schedule: {
    readonly paused: boolean;
    readonly fastCadence: boolean;
    readonly nextDueAt: string | null;
    readonly lastScanAt: string | null;
    readonly lastZoomOutAt: string | null;
    readonly waitingReason: string | null;
    readonly baselineTakenAt: string | null;
  };
  readonly cadence: {
    readonly intensity: string;
    readonly scanEveryMs: number;
    readonly zoomOutEveryMs: number;
    readonly triggerSpacingMs: number;
    readonly watchEveryMs: number;
  } | null;
  readonly triggers: readonly {
    readonly triggerId: string;
    readonly code: string;
    readonly text: string;
    readonly firedAt: string;
    readonly cycleId: string | null;
    readonly spaced: boolean;
  }[];
}

const TRIGGERS = [
  "PRICE_MOVE",
  "VOLATILITY_CROSSED",
  "MODE_CHANGED",
  "FLOW_MOVED",
  "GOAL_CHANGED",
  "TRADE_BLOCKED_3X",
  "THESIS_RECHECK",
  "POSITION_PRICE_MOVE",
  "LIQUIDITY_DROP",
  "RESCREEN_FAILED",
] as const;

const minutes = (ms: number) => (ms >= 3_600_000 ? `${ms / 3_600_000} h` : `${Math.round(ms / 60_000)} min`);
const when = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` : "never");

/**
 * The research loop's playtest tools (P3-U10): the schedule as the
 * orchestrator sees it, pause and resume, the fork's fast cadence, a trigger
 * by hand, a pass of the loop now, and the market mover. Everything here
 * exists on the local fork only; the orchestrator refuses it elsewhere.
 */
export function ResearchControls({ agentId, loop }: { agentId: string; loop: ResearchLoopJson }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [code, setCode] = useState<string>("PRICE_MOVE");
  const [move, setMove] = useState<string>("-800");
  const act = (label: string, run: () => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>) =>
    start(async () => {
      const r = await run();
      if (!r.ok) {
        toast.error(`${label} did not happen`, { description: r.error });
        return;
      }
      toast.success(label);
      router.refresh();
    });
  const s = loop.schedule;
  return (
    <Card data-testid="research-controls">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Research loop</CardTitle>
          <div className="flex flex-wrap gap-1.5">
            <Tag tone={loop.running ? "accent" : "neutral"}>
              {loop.running ? "agent running" : "agent not running"}
            </Tag>
            <Tag tone={loop.schedulingOn ? "accent" : "warning"}>
              {loop.schedulingOn ? "loop on" : "loop off (SCHEDULED_RESEARCH)"}
            </Tag>
            {s.paused ? <Tag tone="warning">paused</Tag> : null}
            {s.fastCadence ? <Tag tone="legendary">fast cadence</Tag> : null}
          </div>
        </div>
        <CardDescription>
          {loop.cadence
            ? `${loop.cadence.intensity.toLowerCase()} intensity: a Scan every ${minutes(loop.cadence.scanEveryMs)}, a review every ${minutes(loop.cadence.zoomOutEveryMs)}, triggers ${minutes(loop.cadence.triggerSpacingMs)} apart, the watcher every ${minutes(loop.cadence.watchEveryMs)}.`
            : "No goal: the loop has nothing to schedule."}{" "}
          Next due {when(s.nextDueAt)}; last Scan {when(s.lastScanAt)}; last review{" "}
          {when(s.lastZoomOutAt)}; baseline {when(s.baselineTakenAt)}.
          {s.waitingReason ? ` Waiting: ${s.waitingReason}.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              act(s.paused ? "Research resumed" : "Research paused", () =>
                pauseResearchAction(agentId, !s.paused),
              )
            }
          >
            {s.paused ? "Resume" : "Pause"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              act(s.fastCadence ? "Normal cadence" : "Fast cadence (minutes)", () =>
                fastCadenceAction(agentId, !s.fastCadence),
              )
            }
          >
            {s.fastCadence ? "Normal cadence" : "Fast cadence"}
          </Button>
          <Button
            size="sm"
            disabled={pending}
            loading={pending}
            onClick={() => act("One pass of the watcher and the scheduler", researchTickAction)}
          >
            Run a pass now
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={code} onValueChange={(v) => setCode(v)}>
            <SelectTrigger className="w-56" aria-label="Trigger">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRIGGERS.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => act(`Trigger ${code} fired`, () => fireTriggerAction(agentId, code))}
          >
            Fire trigger
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-foreground-muted">Move MON/USD by</span>
            <input
              className="h-8 w-24 rounded-md border border-border bg-surface px-2 numeric"
              value={move}
              onChange={(e) => setMove(e.target.value)}
              aria-label="Basis points"
              inputMode="numeric"
            />
            <span className="text-foreground-muted">bps</span>
          </label>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => act(`MON/USD moved by ${move} bps`, () => moveMarketAction(Number(move)))}
          >
            Move the market
          </Button>
        </div>
        {loop.triggers.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm" data-testid="console-triggers">
            {loop.triggers.slice(0, 8).map((t) => (
              <li key={t.triggerId} className="flex flex-wrap items-center gap-2">
                <span className="numeric text-foreground-muted">{when(t.firedAt)}</span>
                <span className="font-mono text-xs">{t.code}</span>
                <span className="text-foreground-muted">{t.text}</span>
                <Badge tone={t.cycleId ? "positive" : t.spaced ? "warning" : "neutral"}>
                  {t.cycleId ? "answered" : t.spaced ? "spaced" : "pending"}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
