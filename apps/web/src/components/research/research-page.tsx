"use client";

import { type EnvironmentId, ENVIRONMENTS } from "@alpha-agents/config";
import {
  AgentTerminal,
  BudgetMeter,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  MarketSnapshotPanel,
  PlanUnchangedCard,
  ResearchOverview,
  ResearchScheduleCard,
  Skeleton,
  StageTimeline,
  ThemesPanel,
  TriggerList,
  WhyNotTraded,
} from "@alpha-agents/ui";
import { ArrowLeft, PlugZap, Wallet } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { type WhyNotTradedJson, tradingApi } from "@/api/client";
import { useResearch, useTerminal } from "@/agent/use-research";
import { useWalletSession } from "@/auth/session";

/**
 * The Research page (P3-U10): what the agent's research loop is doing and
 * why, for its owner. The agent terminal follows the open cycle live and
 * shows the chosen cycle's history after; around it the schedule and the
 * budget, the triggers the watcher fired, the stage timeline with each
 * stage's cost, the market overview and the last Scan's themes, the
 * watcher's snapshot, why the plan did not change and why the agent did not
 * trade. Every text comes from the platform's guarded records.
 */
export function ResearchPage({
  environment,
  agentId,
}: {
  environment: EnvironmentId;
  agentId: bigint;
}) {
  const wallet = useWalletSession();
  const { research, error, refresh, pause } = useResearch(agentId);
  const [selected, setSelected] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  const [why, setWhy] = useState<WhyNotTradedJson | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date().toISOString()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  // The terminal follows the open cycle unless the reader picked one from the timeline.
  const open = research?.open?.cycleId ?? null;
  const cycleId = selected ?? open;
  const terminal = useTerminal(agentId, cycleId, research !== null);
  useEffect(() => {
    let live = true;
    void tradingApi
      .whyNotTraded(agentId)
      .then((w) => live && setWhy(w))
      .catch(() => live && setWhy(null));
    return () => {
      live = false;
    };
  }, [agentId]);
  const id = agentId.toString();
  const back = (
    <Button asChild variant="ghost" size="sm" className="w-fit">
      <Link href={`/agents/${id}/portfolio`}>
        <ArrowLeft aria-hidden="true" />
        Back to the portfolio
      </Link>
    </Button>
  );

  if (!wallet.ready)
    return (
      <div className="flex flex-col gap-6">
        {back}
        <Skeleton className="h-64" />
      </div>
    );
  if (!wallet.address)
    return (
      <div className="flex flex-col gap-6">
        {back}
        <EmptyState
          icon={Wallet}
          title="Connect your wallet"
          description="The research page is for the agent's owner."
        />
      </div>
    );
  if (error)
    return (
      <div className="flex flex-col gap-6">
        {back}
        <EmptyState
          icon={PlugZap}
          title="Research not available"
          description={error}
          action={
            <Button variant="secondary" onClick={refresh}>
              Try again
            </Button>
          }
        />
      </div>
    );
  if (!research)
    return (
      <div className="flex flex-col gap-6">
        {back}
        <Skeleton className="h-64" />
      </div>
    );

  const c = research.cadence;
  const s = research.schedule;
  return (
    <div className="flex flex-col gap-6" data-testid="research-page" data-agent={id}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {back}
        <span className="text-xs text-foreground-muted">
          {ENVIRONMENTS[environment].label} · agent #{id}
        </span>
      </div>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Research</h1>
        <p className="text-sm text-foreground-muted">
          What your agent is looking at, what it found and what it decided, as it happens.
        </p>
      </header>

      <AgentTerminal
        lines={terminal.lines}
        state={terminal.state}
        cycle={terminal.cycle}
        maxHeightClass="max-h-112"
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <ResearchScheduleCard
          now={now}
          view={{
            running: research.running,
            schedulingOn: research.schedulingOn,
            paused: s.paused,
            fastCadence: s.fastCadence,
            intensity: c?.intensity ?? null,
            nextDueAt: s.nextDueAt,
            lastScanAt: s.lastScanAt,
            lastZoomOutAt: s.lastZoomOutAt,
            lastOverviewAt: s.lastOverviewAt,
            waitingReason: s.waitingReason,
            waitingSince: s.waitingSince,
            scanEveryMs: c?.scanEveryMs ?? null,
            zoomOutEveryMs: c?.zoomOutEveryMs ?? null,
            overviewEveryMs: c?.overviewEveryMs ?? null,
            triggerSpacingMs: c?.triggerSpacingMs ?? null,
            refreshesOverview: c?.refreshesOverview ?? false,
          }}
          actions={
            research.running ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={pausing}
                data-testid="research-pause"
                onClick={async () => {
                  setPausing(true);
                  try {
                    await pause(!s.paused);
                  } finally {
                    setPausing(false);
                  }
                }}
              >
                {s.paused ? "Resume research" : "Pause research"}
              </Button>
            ) : undefined
          }
        />
        <Card>
          <CardHeader>
            <CardTitle>Budget and triggers</CardTitle>
            <CardDescription>
              Research spends from the agent's credits under the goal's daily budget; triggers are
              free and start a cycle only when something material moved.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {research.budget ? (
              <BudgetMeter
                usedUsdcE6={research.budget.usedTodayUsdcE6}
                dailyUsdcE6={research.budget.dailyBudgetUsdcE6}
                divesToday={research.budget.divesToday}
                divesPerDay={research.budget.divesPerDay}
              />
            ) : (
              <p className="text-sm text-foreground-muted">Set a goal to give research a budget.</p>
            )}
            <TriggerList now={now} triggers={research.triggers} />
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby="timeline-title" className="flex flex-col gap-3">
        <h2 id="timeline-title" className="text-lg font-semibold">
          Research cycles
        </h2>
        <p className="text-sm text-foreground-muted">
          Each cycle's stages with what they cost against their ceiling. Pick one to read it in the
          terminal.
        </p>
        <StageTimeline
          cycles={research.cycles}
          selected={cycleId}
          onSelect={(picked) => setSelected(picked === cycleId && open ? null : picked)}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <ResearchOverview overview={research.overview} />
        <ThemesPanel themes={research.themes} />
        <MarketSnapshotPanel snapshot={research.snapshot} />
        <PlanUnchangedCard view={research.planUnchanged} />
      </div>

      <WhyNotTraded
        reasons={(why?.reasons ?? []).filter((r) => r.code !== "NOT_ARMED")}
        armingEnded={why?.armingEnded?.message ?? null}
      />
    </div>
  );
}
