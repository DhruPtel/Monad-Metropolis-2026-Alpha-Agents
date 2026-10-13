"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import {
  BudgetMeter,
  Button,
  EmptyState,
  DocumentList,
  PhaseList,
  ResearchScheduleCard,
  SourceBubbles,
  type RunOptionView,
  RunPicker,
  SectionLabel,
  SentinelCard,
  Skeleton,
  WalletActionStatus,
  usdcCents,
} from "@alpha-agents/ui";
import { PlugZap, Wallet } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { type SentinelJson, tradingApi } from "@/api/client";
import { kindLabel, reportHref } from "@/agent/report-view";
import { levelOf, phases, sourceCounts } from "@/agent/research-run";
import { useAccountTx } from "@/agent/use-account-tx";
import { useOwnerSession } from "@/agent/use-owner-session";
import { useReports } from "@/agent/use-reports";
import { useResearch, useTerminal } from "@/agent/use-research";
import { useWalletSession } from "@/auth/session";

const KIND_WORD: Readonly<Record<string, string>> = {
  ACTIVATION: "Activation",
  ROUTINE: "Routine",
  TRIGGERED: "Triggered",
  REVIEW: "Plan review",
  REPLAY: "Replay",
};
const minute = (iso: string | null | undefined) =>
  iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : "–";

/**
 * The Research page (P3-U10, rebuilt in UI-FAST around a live view of one
 * run): a run picker; a branch chart of the run's steps by source with live
 * counters beside it; the run's events as a searchable feed; how it ended,
 * with its report; and every past report. While a run goes on the chart, the
 * counters and the feed grow with a Live badge; when it ends they stay as its
 * record. Every line is the platform's guarded record: never a skill or
 * playbook text, a prompt, raw reasoning, or pasted web or X text. The
 * schedule, the budget and the Risk Sentinel stay below.
 */
export function ResearchPage({
  environment,
  agentId,
}: {
  environment: EnvironmentId;
  agentId: bigint;
}) {
  const reportsRead = useReports(agentId);
  const wallet = useWalletSession();
  const { research, error, refresh, pause } = useResearch(agentId);
  const [selected, setSelected] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  const [sentinel, setSentinel] = useState<SentinelJson | null>(null);
  const asOwner = useOwnerSession(agentId);
  // F-U12 (P4-U2 follow-up): the owner unpauses the account after a Sentinel pause, from their wallet.
  const unpause = useAccountTx(environment);
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date().toISOString()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  // The run shown: the one picked, else the open run, else the newest.
  const open = research?.open?.cycleId ?? null;
  const newest = research?.cycles[0]?.cycleId ?? null;
  const cycleId = selected ?? open ?? newest;
  const terminal = useTerminal(agentId, cycleId, research !== null && cycleId !== null);
  const shownCycle = research?.cycles.find((c) => c.cycleId === cycleId) ?? null;
  const counts = useMemo(() => sourceCounts(terminal.lines), [terminal.lines]);
  const runPhases = useMemo(
    () => phases(terminal.lines, shownCycle?.finishedAt ?? null),
    [terminal.lines, shownCycle?.finishedAt],
  );
  const live = terminal.state === "live";

  // Each run's research level, from its terminal header: read once per run, one at a time.
  const [levels, setLevels] = useState<Readonly<Record<string, string>>>({});
  const runIds = (research?.cycles ?? [])
    .slice(0, 10)
    .map((c) => c.cycleId)
    .join(",");
  useEffect(() => {
    if (!runIds) return;
    let live = true;
    void (async () => {
      for (const id of runIds.split(",")) {
        if (!live) return;
        try {
          const t = await asOwner((tok) =>
            tradingApi.terminal(agentId, tok, { cycleId: id, after: 999_999_999 }),
          );
          if (live) setLevels((l) => ({ ...l, [id]: levelOf(t.cycle?.reasoning) }));
        } catch {
          // Left "–": the picker says the level is unknown.
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [agentId, asOwner, runIds]);

  const reports = reportsRead.reports?.reports ?? [];

  // P4-U2: the sentinel's actions, re-read with the research.
  useEffect(() => {
    if (!research) return;
    let live = true;
    void asOwner((t) => tradingApi.sentinel(agentId, t))
      .then((sv) => live && setSentinel(sv))
      .catch(() => live && setSentinel(null));
    return () => {
      live = false;
    };
  }, [agentId, asOwner, research]);
  const id = agentId.toString();

  if (!wallet.ready && wallet.state !== "wrong-chain")
    return (
      <EmptyState
        icon={Wallet}
        title="Connect your wallet"
        description="The research view opens once you connect the wallet that owns this agent."
        action={
          <Button onClick={wallet.connect}>
            <Wallet aria-hidden /> Connect wallet
          </Button>
        }
      />
    );
  if (wallet.state === "wrong-chain")
    return (
      <EmptyState
        icon={PlugZap}
        title={`Switch to ${wallet.target.name}`}
        description="Your wallet is on another network. Switch it to read this agent's research."
        action={<Button onClick={wallet.switchChain}>Switch network</Button>}
      />
    );
  if (error)
    return (
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
    );
  if (!research) return <ResearchSkeleton />;

  const c = research.cadence;
  const s = research.schedule;
  const pausedAccount =
    sentinel?.account && sentinel.mode && sentinel.mode !== "NORMAL" ? sentinel.account : null;

  const runs: RunOptionView[] = research.cycles.map((cy) => {
    const rep = reports.find((r) => r.cycleId === cy.cycleId);
    return {
      id: cy.cycleId,
      date: minute(cy.startedAt),
      kind: KIND_WORD[cy.kind] ?? "Research",
      level: levels[cy.cycleId] ?? "–",
      spend: `${usdcCents(cy.chargedUsdcE6)} USDC`,
      outcome:
        rep?.summary ??
        rep?.reason ??
        (cy.status === "running" || cy.cycleId === open ? "Running now" : cy.status),
      live: cy.cycleId === open,
    };
  });
  return (
    <div className="flex flex-col gap-6" data-testid="research-page" data-agent={id}>
      <section aria-label="Runs" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SectionLabel as="h2">Runs</SectionLabel>
          {research.running ? (
            <Button
              size="sm"
              variant="secondary"
              className="ml-auto"
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
          ) : null}
        </div>
        <RunPicker runs={runs} selected={cycleId} onSelect={setSelected} />
      </section>

      {cycleId ? (
        <>
          <section aria-label="Sources" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <SectionLabel as="h2">Sources</SectionLabel>
              {live ? (
                <span className="text-xs text-positive" data-testid="run-live">
                  Live
                </span>
              ) : null}
            </div>
            <SourceBubbles
              items={[
                { label: "Web searches", count: counts.webSearches },
                { label: "Pages read", count: counts.pagesRead },
                { label: "X posts read", count: counts.xPosts },
                { label: "Onchain reads", count: counts.onchainReads },
                { label: "Market data calls", count: counts.marketCalls },
                {
                  label: "Stages completed",
                  count: counts.stages.length,
                  names: [...new Set(counts.stages)],
                },
              ]}
            />
          </section>

          <section aria-label="What happened" className="flex flex-col gap-2">
            <SectionLabel as="h2">What happened</SectionLabel>
            <PhaseList
              phases={runPhases}
              empty={terminal.state === "connecting" ? "Reading the run." : "No events recorded."}
            />
          </section>
        </>
      ) : (
        <p className="text-sm text-foreground-muted">
          No research run yet: the first comes with the activation sweep.
        </p>
      )}

      <section
        aria-label="Documents"
        className="flex flex-col gap-2"
        data-testid="research-reports"
      >
        <SectionLabel as="h2">Documents</SectionLabel>
        {reportsRead.error ? (
          <p className="text-sm text-warning">{reportsRead.error}</p>
        ) : (
          <DocumentList
            linkAs={Link}
            empty="No reports yet: the first is written when a research run ends."
            rows={reports.map((r) => ({
              id: r.cycleId,
              title: r.summary ?? `${kindLabel(r.kind)} report`,
              type: kindLabel(r.kind),
              date: r.createdAt.slice(0, 10),
              href: r.status === "written" ? reportHref(agentId, r.cycleId) : null,
              note: r.status === "written" ? null : (r.reason ?? "No report was written."),
            }))}
          />
        )}
      </section>

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
        />
        <div className="flex flex-col gap-3 rounded-md border border-border p-4">
          <SectionLabel as="h2">Budget today</SectionLabel>
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
        </div>
      </div>

      <SentinelCard
        view={{
          configured: sentinel?.configured ?? false,
          active: sentinel?.active ?? {},
          lastCheckedAt: sentinel?.lastCheckedAt ?? null,
          actions: sentinel?.actions ?? [],
          mode: sentinel?.mode ?? research.snapshot?.mode ?? null,
        }}
        actions={
          pausedAccount || unpause.progress ? (
            <div className="flex flex-col gap-2">
              {pausedAccount ? (
                <Button
                  size="sm"
                  className="w-fit"
                  disabled={unpause.busy}
                  onClick={() =>
                    void unpause
                      .send(
                        "Unpause the account",
                        pausedAccount,
                        { functionName: "unpause", args: [] },
                        "The account is back to normal. The agent may trade again within its limits.",
                      )
                      .then((p) => {
                        if (p?.state === "confirmed") refresh();
                      })
                  }
                >
                  Unpause after review
                </Button>
              ) : null}
              {unpause.progress && unpause.text ? (
                <WalletActionStatus
                  state={unpause.progress.state}
                  text={unpause.text}
                  hash={unpause.progress.hash ?? null}
                />
              ) : null}
            </div>
          ) : undefined
        }
      />
    </div>
  );
}

/** The page's layout while its first read is out. */
function ResearchSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" data-testid="research-loading">
      <Skeleton className="h-20 w-full" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
