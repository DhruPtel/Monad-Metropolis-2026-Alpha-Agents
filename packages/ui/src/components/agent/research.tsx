"use client";

import { formatAmount } from "@alpha-agents/domain";
import { Activity, Radio, Telescope } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { StatBar } from "../stat-bar";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { EmptyState } from "../ui/empty-state";
import { SectionLabel } from "../ui/section-label";
import { Tag, type TagTone } from "../ui/tag";
import { FactTile, TileGrid, type TileTone } from "./tiles";

/**
 * The research loop as the owner reads it (P3-U10): the agent terminal (a
 * live, monospace feed of what the agent is doing, one plain line per
 * event), the schedule, the budget, the triggers the watcher fired, the
 * stage timeline with each stage's cost, the overview and the themes, the
 * market snapshot and why the plan did not change. Every text comes from
 * the platform's guarded records; nothing here renders a model's prose.
 */
const usdc = (e6: string) =>
  formatAmount(BigInt(e6), 6, { maxFractionDigits: 2, minFractionDigits: 2 });
const clock = (iso: string) => iso.slice(11, 19);
const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** Time since or until, in whole units, for a line of text. */
export function relativeText(iso: string, now: string): string {
  const ms = new Date(iso).getTime() - new Date(now).getTime();
  const abs = Math.abs(ms);
  const unit =
    abs < 60_000
      ? "under a minute"
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)} min`
        : abs < 86_400_000
          ? `${Math.round(abs / 3_600_000)} h`
          : `${Math.round(abs / 86_400_000)} d`;
  return ms < 0 ? `${unit} ago` : `in ${unit}`;
}

// ---------------------------------------------------------------------------
// UI-U2: the loop at a glance

export interface ResearchTilesView {
  readonly running: boolean;
  readonly schedulingOn: boolean;
  readonly paused: boolean;
  readonly waitingReason: string | null;
  readonly nextDueAt: string | null;
  readonly lastScanAt: string | null;
  readonly intensity: string | null;
  /** Null without a goal: research then has no budget. */
  readonly budget: {
    readonly usedTodayUsdcE6: string;
    readonly dailyBudgetUsdcE6: string;
    readonly divesToday: number;
    readonly divesPerDay: number;
  } | null;
  /** Cycles run so far, and whether one is open now. */
  readonly cycles: number;
  readonly open: boolean;
}

/** The plain words each tile says, so the page is tested without a browser. */
export function researchTileWords(
  v: ResearchTilesView,
  now: string,
): {
  readonly status: { value: string; note: string; tone: TileTone; state: string };
  readonly next: { value: string; note: string };
  readonly spent: { value: string; note: string; tone: TileTone };
  readonly cycles: { value: string; note: string };
} {
  const status = !v.running
    ? {
        value: "Not running",
        note: "The loop runs once a plan is approved and the agent is active. Until then research runs when you start it.",
        tone: "neutral" as TileTone,
        state: "Not running",
      }
    : !v.schedulingOn
      ? {
          value: "By hand",
          note: "Scheduled research is off on this stack; a cycle runs when it is started.",
          tone: "neutral" as TileTone,
          state: "By hand",
        }
      : v.paused
        ? {
            value: "Paused",
            note: "Nothing new starts until you resume; safety checks keep running.",
            tone: "warning" as TileTone,
            state: "Paused",
          }
        : v.waitingReason
          ? {
              value: "Waiting",
              note: v.waitingReason,
              tone: "warning" as TileTone,
              state: "Waiting",
            }
          : {
              value: "On schedule",
              note: v.intensity
                ? `${v.intensity.charAt(0)}${v.intensity.slice(1).toLowerCase()} intensity.`
                : "Research runs on its schedule.",
              tone: "accent" as TileTone,
              state: "On schedule",
            };
  const next = v.open
    ? { value: "Now", note: "A cycle is running; the terminal follows it." }
    : v.nextDueAt
      ? { value: relativeText(v.nextDueAt, now), note: `The next Scan, at ${when(v.nextDueAt)}.` }
      : { value: "None due", note: "Nothing is scheduled yet." };
  const spent = v.budget
    ? {
        value: `${usdc(v.budget.usedTodayUsdcE6)} USDC`,
        note: `of ${usdc(v.budget.dailyBudgetUsdcE6)} USDC today, ${v.budget.divesToday} of ${v.budget.divesPerDay} Dive${v.budget.divesPerDay === 1 ? "" : "s"}.`,
        tone:
          BigInt(v.budget.usedTodayUsdcE6) >= BigInt(v.budget.dailyBudgetUsdcE6)
            ? ("warning" as TileTone)
            : ("neutral" as TileTone),
      }
    : { value: "No budget", note: "Set a goal to give research a budget.", tone: "warning" as TileTone };
  const cycles = {
    value: String(v.cycles),
    note:
      v.cycles === 0
        ? "No cycle yet."
        : v.lastScanAt
          ? `Cycle${v.cycles === 1 ? "" : "s"} so far; the last Scan ${relativeText(v.lastScanAt, now)}.`
          : `Cycle${v.cycles === 1 ? "" : "s"} so far.`,
  };
  return { status, next, spent, cycles };
}

/**
 * The research loop at a glance (UI-U2): whether it runs, with Pause or
 * Resume beside it; when the next Scan is due; what today's research spent
 * of its budget; and how many cycles ran. Four square tiles.
 */
function ResearchTiles({
  view,
  now,
  action,
  className,
}: {
  view: ResearchTilesView;
  now: string;
  /** Pause or Resume, where the loop runs. */
  action?: ReactNode;
  className?: string;
}) {
  const w = researchTileWords(view, now);
  return (
    <TileGrid label="Research at a glance" testId="research-tiles" className={className}>
      <FactTile
        label="Research is"
        value={w.status.value}
        note={w.status.note}
        action={action}
        tone={w.status.tone}
        numeric={false}
        testId="research-tile-status"
        state={w.status.state}
      />
      <FactTile
        label="Next Scan"
        value={w.next.value}
        note={w.next.note}
        numeric={false}
        testId="research-tile-next"
      />
      <FactTile
        label="Spent today"
        value={w.spent.value}
        note={w.spent.note}
        tone={w.spent.tone}
        testId="research-tile-spent"
      />
      <FactTile
        label="Cycles"
        value={w.cycles.value}
        note={w.cycles.note}
        testId="research-tile-cycles"
      />
    </TileGrid>
  );
}

// ---------------------------------------------------------------------------
// The agent terminal

export type TerminalTone = "info" | "ok" | "warn" | "bad";

export interface TerminalLineView {
  readonly seq: number;
  readonly at: string;
  readonly kind: string;
  readonly stage: string | null;
  readonly text: string;
  readonly tone: TerminalTone;
}

/** What the feed is doing: not yet read, reading a running cycle, the cycle ended, lost and retrying, or nothing to show. */
export type TerminalState = "connecting" | "live" | "ended" | "reconnecting" | "idle";

export const TERMINAL_STATES: readonly TerminalState[] = [
  "connecting",
  "live",
  "ended",
  "reconnecting",
  "idle",
];

const STATE_TEXT: Readonly<Record<TerminalState, { label: string; tone: TagTone }>> = {
  connecting: { label: "Connecting", tone: "neutral" },
  live: { label: "Live", tone: "accent" },
  ended: { label: "Ended", tone: "neutral" },
  reconnecting: { label: "Reconnecting", tone: "warning" },
  idle: { label: "No cycle yet", tone: "neutral" },
};

const STAGE_SHORT: Readonly<Record<string, string>> = {
  SCAN: "scan",
  DIVE: "dive",
  CHALLENGE: "chal",
  TEST: "test",
  ZOOM_OUT: "zoom",
};

const MARK: Readonly<Record<TerminalTone, string>> = { info: "·", ok: "✓", warn: "!", bad: "×" };

function AgentTerminal({
  lines,
  state,
  title = "Agent terminal",
  cycle,
  maxHeightClass = "max-h-96",
  className,
}: {
  lines: readonly TerminalLineView[];
  state: TerminalState;
  title?: string;
  /** The cycle the lines belong to, named in the header. */
  cycle?: { readonly kind: string; readonly status: string } | null;
  maxHeightClass?: string;
  className?: string;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  // Follows the newest line while the reader has not scrolled up.
  useEffect(() => {
    const el = body.current;
    if (!el || !pinned) return;
    el.scrollTop = el.scrollHeight;
  }, [pinned]);
  // The lines' length is the dependency that matters; the effect above runs on pinned alone.
  const count = lines.length;
  useEffect(() => {
    const el = body.current;
    if (!el || !pinned) return;
    el.scrollTop = el.scrollHeight;
  }, [count, pinned]);
  const s = STATE_TEXT[state];
  return (
    <section
      aria-label={title}
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border bg-surface-sunken p-3",
        className,
      )}
      data-testid="agent-terminal"
      data-state={state}
      data-lines={lines.length}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Radio className="size-4 text-foreground-muted" aria-hidden="true" />
          <SectionLabel as="h4">{title}</SectionLabel>
          {cycle ? (
            <span className="text-xs text-foreground-muted">
              {cycle.kind.toLowerCase().replace(/_/g, " ")} · {cycle.status}
            </span>
          ) : null}
        </div>
        <Tag tone={s.tone} data-testid="terminal-state">
          {state === "live" ? (
            <span
              className="mr-1 inline-block size-1.5 rounded-full bg-primary motion-safe:animate-pulse"
              aria-hidden="true"
            />
          ) : null}
          {s.label}
        </Tag>
      </div>
      <div
        ref={body}
        role="log"
        aria-label={title}
        aria-live={state === "live" ? "polite" : "off"}
        aria-busy={state === "connecting" || state === "reconnecting"}
        className={cn(
          "overflow-y-auto font-mono text-xs leading-5 text-foreground",
          maxHeightClass,
        )}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 8);
        }}
      >
        <ol className="flex flex-col gap-0.5">
          {lines.length === 0 ? (
            <li className="text-foreground-muted">
              {state === "idle"
                ? "Nothing has run yet. The terminal fills as the agent researches."
                : state === "reconnecting"
                  ? "The connection dropped; trying again."
                  : "Waiting for the first line."}
            </li>
          ) : null}
          {lines.map((l) => (
            <li
              key={l.seq}
              data-seq={l.seq}
              data-kind={l.kind}
              data-tone={l.tone}
              className={cn(
                "grid grid-cols-[auto_auto_auto_1fr] items-baseline gap-x-2",
                l.kind === "withheld" && "italic text-foreground-muted",
              )}
            >
              <span className="text-foreground-muted">{clock(l.at)}</span>
              <span
                className={cn(
                  "w-3 text-center",
                  l.tone === "ok" && "text-positive",
                  l.tone === "warn" && "text-warning",
                  l.tone === "bad" && "text-negative",
                  l.tone === "info" && "text-foreground-muted",
                )}
                aria-hidden="true"
              >
                {MARK[l.tone]}
              </span>
              <span className="w-8 text-foreground-muted">
                {l.stage ? (STAGE_SHORT[l.stage] ?? l.stage.toLowerCase()) : ""}
              </span>
              <span className="whitespace-pre-wrap break-words">{l.text}</span>
            </li>
          ))}
          {state === "reconnecting" && lines.length > 0 ? (
            <li className="text-warning" data-testid="terminal-reconnecting">
              The connection dropped; trying again from line {lines[lines.length - 1]?.seq}.
            </li>
          ) : null}
        </ol>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The schedule, the budget and the triggers

export interface ResearchScheduleView {
  readonly running: boolean;
  readonly schedulingOn: boolean;
  readonly paused: boolean;
  readonly fastCadence: boolean;
  readonly intensity: string | null;
  readonly nextDueAt: string | null;
  readonly lastScanAt: string | null;
  readonly lastZoomOutAt: string | null;
  readonly lastOverviewAt: string | null;
  readonly waitingReason: string | null;
  readonly waitingSince: string | null;
  readonly scanEveryMs: number | null;
  readonly zoomOutEveryMs: number | null;
  readonly overviewEveryMs: number | null;
  readonly triggerSpacingMs: number | null;
  readonly refreshesOverview: boolean;
}

const WAITING_TEXT: Readonly<Record<string, string>> = {
  BUDGET_SHORT: "Waiting for tomorrow's research budget.",
  CREDITS_SHORT: "Waiting for credits above the reserve: add USDC to the funding address.",
  NO_CREDITS: "Out of credits: add USDC to the funding address.",
  CANNOT_START: "The cycle could not start; the platform is looking into it.",
};

/** "every 6 hours", "every day", "every week", "every 2 min". */
export function everyText(ms: number): string {
  if (ms % (7 * 86_400_000) === 0)
    return ms === 7 * 86_400_000 ? "every week" : `every ${ms / (7 * 86_400_000)} weeks`;
  if (ms % 86_400_000 === 0)
    return ms === 86_400_000 ? "every day" : `every ${ms / 86_400_000} days`;
  if (ms % 3_600_000 === 0)
    return ms === 3_600_000 ? "every hour" : `every ${ms / 3_600_000} hours`;
  return `every ${Math.round(ms / 60_000)} min`;
}

function ResearchScheduleCard({
  view: v,
  now,
  actions,
  className,
}: {
  view: ResearchScheduleView;
  now: string;
  actions?: ReactNode;
  className?: string;
}) {
  const state = !v.running
    ? { label: "Not running", tone: "neutral" as TagTone }
    : v.paused
      ? { label: "Paused", tone: "warning" as TagTone }
      : v.waitingReason
        ? { label: "Waiting", tone: "warning" as TagTone }
        : { label: "On schedule", tone: "accent" as TagTone };
  return (
    <Card className={className} data-testid="research-schedule" data-state={state.label}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Research schedule</CardTitle>
          <Tag tone={state.tone}>{state.label}</Tag>
        </div>
        <CardDescription>
          {!v.running
            ? "The loop runs once a plan is approved and the agent is active. Until then research runs when you start it."
            : !v.schedulingOn
              ? "Scheduled research is off on this stack; a cycle runs when it is started by hand."
              : v.paused
                ? "Research is paused: no Scan, review or trigger starts a cycle until you resume it."
                : v.intensity && v.scanEveryMs && v.zoomOutEveryMs
                  ? `${v.intensity.charAt(0)}${v.intensity.slice(1).toLowerCase()} intensity: a Scan ${everyText(v.scanEveryMs)}, a review ${everyText(v.zoomOutEveryMs)}${v.refreshesOverview && v.overviewEveryMs ? `, the overview refreshed ${everyText(v.overviewEveryMs)}` : ""}${v.fastCadence ? " (the fork's fast cadence)" : ""}.`
                  : "The schedule follows the goal's research intensity."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {v.waitingReason ? (
          <p className="text-sm text-warning" data-testid="research-waiting">
            {WAITING_TEXT[v.waitingReason] ?? "Waiting."}
            {v.waitingSince ? ` Since ${when(v.waitingSince)}.` : ""}
          </p>
        ) : null}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <dt className="text-foreground-muted">Next due</dt>
          <dd data-testid="research-next-due">
            {v.nextDueAt && v.running && !v.paused ? relativeText(v.nextDueAt, now) : "—"}
          </dd>
          <dt className="text-foreground-muted">Last Scan</dt>
          <dd>{v.lastScanAt ? relativeText(v.lastScanAt, now) : "never"}</dd>
          <dt className="text-foreground-muted">Last review</dt>
          <dd>{v.lastZoomOutAt ? relativeText(v.lastZoomOutAt, now) : "never"}</dd>
          <dt className="text-foreground-muted">Overview</dt>
          <dd>{v.lastOverviewAt ? relativeText(v.lastOverviewAt, now) : "never"}</dd>
        </dl>
        {v.triggerSpacingMs ? (
          <p className="text-xs text-foreground-muted">
            A market move, a changed goal or a held token's trouble starts a cycle on its own, at
            most one {everyText(v.triggerSpacingMs).replace("every ", "every ")}.
          </p>
        ) : null}
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </CardContent>
    </Card>
  );
}

function BudgetMeter({
  usedUsdcE6,
  dailyUsdcE6,
  divesToday,
  divesPerDay,
  className,
}: {
  usedUsdcE6: string;
  dailyUsdcE6: string;
  divesToday: number;
  divesPerDay: number;
  className?: string;
}) {
  const used = BigInt(usedUsdcE6);
  const daily = BigInt(dailyUsdcE6);
  const fill = daily > 0n ? Number((used * 10_000n) / daily) : 0;
  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="budget-meter">
      <StatBar
        label="Today's research budget"
        value={`${usdc(usedUsdcE6)} of ${usdc(dailyUsdcE6)} USDC`}
        fillBps={fill}
      />
      <p className="text-xs text-foreground-muted">
        {divesToday} of {divesPerDay} {divesPerDay === 1 ? "Dive" : "Dives"} today. A stage that
        would pass the budget waits for tomorrow.
      </p>
    </div>
  );
}

export interface TriggerView {
  readonly triggerId: string;
  readonly code: string;
  readonly text: string;
  readonly kind: string;
  readonly firedAt: string;
  readonly cycleId: string | null;
  readonly spaced: boolean;
}

function TriggerList({
  triggers,
  now,
  className,
}: {
  triggers: readonly TriggerView[];
  now: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="trigger-list">
      <SectionLabel as="h4">Triggers</SectionLabel>
      {triggers.length === 0 ? (
        <p className="text-sm text-foreground-muted">
          Nothing has moved enough to start a cycle on its own.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-sm">
          {triggers.map((t) => (
            <li
              key={t.triggerId}
              className="flex flex-wrap items-baseline gap-x-2"
              data-code={t.code}
            >
              <span className="numeric text-foreground-muted">{relativeText(t.firedAt, now)}</span>
              <span className="text-foreground">{t.text}.</span>
              <Tag tone={t.cycleId ? "accent" : t.spaced ? "warning" : "neutral"}>
                {t.cycleId
                  ? t.kind === "REVIEW"
                    ? "review ran"
                    : "scan ran"
                  : t.spaced
                    ? "waiting its turn"
                    : "queued"}
              </Tag>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The stage timeline

export interface StageCellView {
  readonly stage: string;
  readonly themeCode: string | null;
  readonly status: string;
  readonly chargedUsdcE6: string;
  readonly ceilingUsdcE6: string;
}

export interface CycleRowView {
  readonly cycleId: string;
  readonly kind: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly chargedUsdcE6: string;
  readonly stages: readonly StageCellView[];
}

const CYCLE_TEXT: Readonly<Record<string, string>> = {
  ROUTINE: "Routine",
  TRIGGERED: "Triggered",
  ACTIVATION: "Activation",
  REVIEW: "Review",
};
const STAGE_TEXT: Readonly<Record<string, string>> = {
  SCAN: "Scan",
  DIVE: "Dive",
  CHALLENGE: "Challenge",
  TEST: "Test",
  ZOOM_OUT: "Zoom out",
};

const stageTone = (status: string): TagTone =>
  status === "completed"
    ? "accent"
    : status === "running"
      ? "legendary"
      : status === "skipped" || status === "pending"
        ? "neutral"
        : "warning";

function StageTimeline({
  cycles,
  selected,
  onSelect,
  className,
}: {
  cycles: readonly CycleRowView[];
  selected?: string | null;
  onSelect?: (cycleId: string) => void;
  className?: string;
}) {
  if (cycles.length === 0)
    return (
      <EmptyState
        icon={Telescope}
        title="No research yet"
        description="The first cycle runs when automatic trading is turned on, or when you start one."
        {...(className ? { className } : {})}
      />
    );
  return (
    <ol className={cn("flex flex-col gap-2", className)} data-testid="stage-timeline">
      {cycles.map((c) => {
        const Row = onSelect ? "button" : "div";
        return (
          <li key={c.cycleId} data-cycle={c.cycleId} data-status={c.status}>
            <Row
              type={onSelect ? "button" : undefined}
              onClick={onSelect ? () => onSelect(c.cycleId) : undefined}
              aria-pressed={onSelect ? selected === c.cycleId : undefined}
              className={cn(
                "flex w-full flex-col gap-1.5 rounded-md border border-border p-3 text-left",
                onSelect && "hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-ring",
                selected === c.cycleId && "border-primary-muted bg-surface-raised",
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2">
                  <span className="font-medium">{CYCLE_TEXT[c.kind] ?? c.kind}</span>
                  <Badge
                    tone={
                      c.status === "completed"
                        ? "positive"
                        : c.status === "running" || c.status === "queued"
                          ? "detail"
                          : "negative"
                    }
                  >
                    {c.status}
                  </Badge>
                </span>
                <span className="numeric text-foreground-muted">
                  {c.startedAt ? when(c.startedAt) : "queued"} · {usdc(c.chargedUsdcE6)} USDC
                </span>
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {c.stages.map((s, n) => (
                  <li key={`${c.cycleId}-${n}`}>
                    <Tag tone={stageTone(s.status)} size="md">
                      {STAGE_TEXT[s.stage] ?? s.stage}
                      {s.themeCode ? ` ${s.themeCode}` : ""}
                      {BigInt(s.ceilingUsdcE6) > 0n ? (
                        <span className="numeric ml-1 text-foreground-muted">
                          {usdc(s.chargedUsdcE6)}/{usdc(s.ceilingUsdcE6)}
                        </span>
                      ) : null}
                    </Tag>
                  </li>
                ))}
              </ul>
            </Row>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// The overview, the themes, the snapshot and the plan's standing

export interface ClaimView {
  readonly text: string;
  readonly class: string;
  readonly sources: readonly string[];
}

export interface OverviewView {
  readonly at: string;
  readonly summary: string;
  readonly points: readonly ClaimView[];
}

function ResearchOverview({
  overview,
  className,
}: {
  overview: OverviewView | null;
  className?: string;
}) {
  return (
    <Card className={className} data-testid="research-overview">
      <CardHeader>
        <CardTitle>Market overview</CardTitle>
        <CardDescription>
          {overview
            ? `The agent's view of the market as of ${when(overview.at)}, refreshed on activation and then weekly.`
            : "The agent writes its overview when it is activated."}
        </CardDescription>
      </CardHeader>
      {overview ? (
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm">{overview.summary}</p>
          {overview.points.length > 0 ? (
            <ul className="flex flex-col gap-1.5 text-sm">
              {overview.points.map((p, n) => (
                <li
                  key={`${n}-${p.text.slice(0, 16)}`}
                  className="flex flex-wrap items-baseline gap-x-2"
                >
                  <span>{p.text}</span>
                  <Tag>{p.class}</Tag>
                  {p.sources.length > 0 ? (
                    <span className="text-xs text-foreground-muted">{p.sources.join(", ")}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

export interface ThemeView {
  readonly code: string;
  readonly materiality: string;
  readonly scope: string;
  readonly symbol: string | null;
  readonly whyNow: string;
}

export interface ThemesView {
  readonly at: string;
  readonly summary: string;
  readonly quiet: boolean;
  readonly themes: readonly ThemeView[];
}

const materialityTone = (m: string): TagTone =>
  m === "high" ? "warning" : m === "medium" ? "accent" : "neutral";

function ThemesPanel({ themes, className }: { themes: ThemesView | null; className?: string }) {
  return (
    <Card className={className} data-testid="themes-panel">
      <CardHeader>
        <CardTitle>What changed</CardTitle>
        <CardDescription>
          {themes
            ? `The last Scan, ${when(themes.at)}${themes.quiet ? ": a quiet market" : ""}.`
            : "The first Scan names the themes worth a closer look."}
        </CardDescription>
      </CardHeader>
      {themes ? (
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm">{themes.summary}</p>
          {themes.themes.length > 0 ? (
            <ul className="flex flex-col gap-2 text-sm">
              {themes.themes.map((t) => (
                <li key={t.code} className="flex flex-col gap-0.5" data-theme={t.code}>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs">{t.code}</span>
                    <Tag tone={materialityTone(t.materiality)}>{t.materiality}</Tag>
                    <Tag>{t.symbol ?? t.scope.toLowerCase()}</Tag>
                  </span>
                  <span className="text-foreground-muted">{t.whyNow}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-foreground-muted">No theme earned a Dive.</p>
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}

export interface SnapshotView {
  readonly at: string;
  /** MON in USD, formatted, or null while the feed is unusable. */
  readonly monUsd: string | null;
  readonly volatilityPct: number | null;
  readonly mode: string | null;
  readonly navUsdcE6: string | null;
  readonly held: readonly {
    readonly symbol: string;
    readonly priceUsd: string | null;
    readonly liquidityUsd: number | null;
    readonly screen: string | null;
    readonly status: string | null;
  }[];
}

const money = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(0)}k`
      : n.toFixed(0);

function MarketSnapshotPanel({
  snapshot,
  className,
}: {
  snapshot: SnapshotView | null;
  className?: string;
}) {
  return (
    <Card className={className} data-testid="market-snapshot">
      <CardHeader>
        <CardTitle>Market snapshot</CardTitle>
        <CardDescription>
          {snapshot
            ? `What the watcher sees, ${when(snapshot.at)}. A move past the goal's trigger starts a cycle.`
            : "The watcher reads the market once the agent has an account."}
        </CardDescription>
      </CardHeader>
      {snapshot ? (
        <CardContent className="flex flex-col gap-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
            <dt className="text-foreground-muted">MON</dt>
            <dd className="numeric">{snapshot.monUsd ? `${snapshot.monUsd} USD` : "no price"}</dd>
            <dt className="text-foreground-muted">24h volatility</dt>
            <dd className="numeric">
              {snapshot.volatilityPct === null
                ? "unreadable"
                : `${snapshot.volatilityPct.toFixed(0)}%`}
            </dd>
            <dt className="text-foreground-muted">Account</dt>
            <dd className="numeric">
              {snapshot.navUsdcE6 ? `${usdc(snapshot.navUsdcE6)} USDC` : "—"}
              {snapshot.mode ? ` · ${snapshot.mode.toLowerCase().replace(/_/g, " ")}` : ""}
            </dd>
          </dl>
          {snapshot.held.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm">
              {snapshot.held.map((h) => (
                <li
                  key={h.symbol}
                  className="flex flex-wrap items-baseline gap-x-2"
                  data-symbol={h.symbol}
                >
                  <span className="font-medium">{h.symbol}</span>
                  <span className="numeric text-foreground-muted">
                    {h.priceUsd ? `${h.priceUsd} USD` : "no price"}
                    {h.liquidityUsd !== null ? ` · ${money(h.liquidityUsd)} USD of liquidity` : ""}
                  </span>
                  {h.status === "sell_only" || h.status === "delisted" || h.screen === "refused" ? (
                    <Tag tone="warning">
                      {h.screen === "refused" ? "screen refused" : h.status?.replace(/_/g, " ")}
                    </Tag>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-foreground-muted">Only USDC is held.</p>
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}

export interface PlanUnchangedView {
  readonly at: string;
  readonly reasonCode: string;
  readonly portfolioView: string;
  readonly whatWouldChangeIt: string;
}

const NO_CHANGE_TEXT: Readonly<Record<string, string>> = {
  NO_MATERIAL_CHANGE: "nothing material changed",
  EVIDENCE_THIN: "the evidence was too thin",
  CHALLENGE_REJECTED: "the Challenge rejected the thesis",
  COOLDOWN: "the plan changed too recently",
  COST_HURDLE: "the trades would cost more than they earn",
  LIMITS_BIND: "your limits leave no room",
  BUDGET_SHORT: "the research budget ran out",
};

function PlanUnchangedCard({
  view,
  className,
}: {
  view: PlanUnchangedView | null;
  className?: string;
}) {
  return (
    <Card className={className} data-testid="plan-unchanged">
      <CardHeader>
        <CardTitle>Why the plan did not change</CardTitle>
        <CardDescription>
          {view
            ? `The last review, ${when(view.at)}, kept the plan because ${NO_CHANGE_TEXT[view.reasonCode] ?? view.reasonCode.toLowerCase().replace(/_/g, " ")}.`
            : "Every review ends with a reason: a new plan for you to approve, or why this one stands."}
        </CardDescription>
      </CardHeader>
      {view ? (
        <CardContent className="flex flex-col gap-2 text-sm">
          <p>{view.portfolioView}</p>
          <p className="text-foreground-muted">
            <Activity className="mr-1 inline size-3.5" aria-hidden="true" />
            What would change it: {view.whatWouldChangeIt}
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}

export {
  AgentTerminal,
  BudgetMeter,
  MarketSnapshotPanel,
  PlanUnchangedCard,
  ResearchOverview,
  ResearchScheduleCard,
  ResearchTiles,
  StageTimeline,
  ThemesPanel,
  TriggerList,
};
