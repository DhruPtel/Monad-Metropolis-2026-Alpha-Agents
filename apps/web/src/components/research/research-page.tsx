"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { speciesAsset } from "@alpha-agents/domain";
import {
  BudgetMeter,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  DocumentList,
  NextResearchStrip,
  CallDetailPanel,
  FactStrip,
  RunStatusStrip,
  PhaseList,
  ResearchBranchChart,
  ResearchScheduleCard,
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
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type SentinelJson, type StoredReportJson, api, tradingApi } from "@/api/client";
import { kindLabel, reportHref } from "@/agent/report-view";
import {
  PHASE_OF_STAGE,
  branches,
  currentStep,
  describeCall,
  factPhases,
  levelOf,
  liveSummary,
  runCalls,
  runRecord,
} from "@/agent/research-run";
import { useAccountTx } from "@/agent/use-account-tx";
import { useOwnerSession } from "@/agent/use-owner-session";
import { useReports } from "@/agent/use-reports";
import { useResearch, useTerminal } from "@/agent/use-research";
import { useWalletSession } from "@/auth/session";
import { ResearchSettings } from "./research-settings";

const KIND_WORD: Readonly<Record<string, string>> = {
  ACTIVATION: "Activation",
  ROUTINE: "Routine",
  TRIGGERED: "Triggered",
  REVIEW: "Plan review",
  REPLAY: "Replay",
};
/** The browser's record of the reports this owner opened (a per-viewer convenience). */
const openedKey = (agentId: bigint) => `aa-reports-opened-${agentId.toString()}`;
/** A run's most at its tier (2026-10-13 ceilings, with the report). */
const RUN_CEILING: Readonly<Record<string, string>> = { Low: "1.45", Medium: "1.75", High: "3.60" };

const minute = (iso: string | null | undefined) =>
  iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : "–";
/**
 * The full research run's cost shown before the owner starts one (2026-10-13): a Medium run with
 * three token Dives is expected near 1.2 USDC, at most 1.75 with its report (the stage ceilings).
 */
const RUN_COST_TEXT =
  "A full research run reads the market, picks tokens across your allocation, researches each in depth (web and X included), has a skeptic challenge them, checks the result against your limits and ends with a plan for your approval. On the Medium tier it costs about 1.20 USDC of credits, at most 1.75, taken as it runs.";

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
    // A live run's timer ticks each second; otherwise the clock moves every 15 s.
    const timer = window.setInterval(
      () => setNow(new Date().toISOString()),
      research?.open ? 1_000 : 15_000,
    );
    return () => window.clearInterval(timer);
  }, [research?.open]);

  // The run shown: the one picked, else the open run, else the newest.
  const open = research?.open?.cycleId ?? null;
  const newest = research?.cycles[0]?.cycleId ?? null;
  const cycleId = selected ?? open ?? newest;
  const terminal = useTerminal(agentId, cycleId, research !== null && cycleId !== null);
  const shownCycle = research?.cycles.find((c) => c.cycleId === cycleId) ?? null;
  const lines = useMemo(() => branches(terminal.lines), [terminal.lines]);
  const calls = useMemo(() => runCalls(terminal.lines), [terminal.lines]);
  // 2026-10-13: a branch picked on the chart filters What happened; a call opens its panel.
  const [branchSel, setBranchSel] = useState<string | null>(null);
  const [callSel, setCallSel] = useState<string | null>(null);
  // A run that finished while the page was open earns a notice linking to its report.
  const wasOpen = useRef<string | null>(null);
  const [finishedNow, setFinishedNow] = useState<string | null>(null);
  const openNow = research?.open?.cycleId ?? null;
  useEffect(() => {
    if (wasOpen.current && !openNow) setFinishedNow(wasOpen.current);
    wasOpen.current = openNow;
  }, [openNow]);
  // Reports the owner has opened, kept in this browser so a new one shows as New.
  const [opened, setOpened] = useState<readonly string[]>([]);
  useEffect(() => {
    try {
      setOpened(JSON.parse(localStorage.getItem(openedKey(agentId)) ?? "[]") as string[]);
    } catch {
      setOpened([]);
    }
  }, [agentId]);
  const live = terminal.state === "live";

  // 2026-10-13: the shown run's report, whose structured facts write What happened.
  const [reportBody, setReportBody] = useState<StoredReportJson | null>(null);
  const finished = shownCycle?.finishedAt ?? null;
  useEffect(() => {
    setReportBody(null);
    if (!cycleId || !finished) return;
    let on = true;
    void asOwner((t) => tradingApi.report(agentId, cycleId, t)).then(
      (r) => on && setReportBody(r.report.body),
      () => undefined,
    );
    return () => {
      on = false;
    };
  }, [agentId, asOwner, cycleId, finished]);
  const runPhases = useMemo(
    () => factPhases(terminal.lines, finished, reportBody),
    [terminal.lines, finished, reportBody],
  );

  // The agent's art, the branch chart's root.
  const [art, setArt] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    void api.agent(agentId).then(
      (a) => on && setArt(a && a.species > 0 ? speciesAsset(a.species).image : null),
      () => undefined,
    );
    return () => {
      on = false;
    };
  }, [agentId]);

  // Research now: the owner's full research run, its cost shown first.
  const [scanAsk, setScanAsk] = useState(false);
  const [scan, setScan] = useState<{ state: "working" | "done" | "error"; text: string } | null>(
    null,
  );
  const startScan = async () => {
    setScanAsk(false);
    setScan({ state: "working", text: "Starting a research run." });
    try {
      const r = await asOwner((t) => tradingApi.requestResearchRun(agentId, t));
      setSelected(r.cycleId);
      setScan({
        state: "done",
        text: "Research run started. It shows live below, and its plan waits for your approval on the Trading tab when it ends, in a few minutes.",
      });
      refresh();
    } catch (err) {
      setScan({
        state: "error",
        text:
          err instanceof ApiError || err instanceof Error
            ? err.message
            : "Could not start a research run.",
      });
    }
  };

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
  const nextLine = !research.schedulingOn
    ? "Scheduled research is off."
    : s.paused
      ? "Scheduled research is paused."
      : s.nextDueAt
        ? `Next research: ${minute(s.nextDueAt)} UTC`
        : "Next research: not scheduled yet.";
  // 2026-10-13: the run's status, always shown: running, writing the report, or done.
  const openCycle = research.open
    ? (research.cycles.find((x) => x.cycleId === research.open?.cycleId) ?? null)
    : null;
  const newestCycle = research.cycles[0] ?? null;
  const newestReport = newestCycle ? reports.find((r) => r.cycleId === newestCycle.cycleId) : null;
  const zoomDone = openCycle?.stages.some(
    (x) => x.stage === "ZOOM_OUT" && x.status === "completed",
  );
  const runLevel = openCycle ? (levels[openCycle.cycleId] ?? "Medium") : "Medium";
  const elapsedOf = (from: string | null) => {
    if (!from) return "";
    const ms = Math.max(0, Date.parse(now) - Date.parse(from));
    return `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;
  };
  const status = openCycle
    ? {
        state: zoomDone ? ("writing" as const) : ("running" as const),
        line: zoomDone
          ? "Writing the report"
          : `Running: ${(openCycle.cycleId === cycleId ? currentStep(terminal.lines) : null) ?? "starting"}`,
        detail: `${elapsedOf(openCycle.startedAt)} · ${usdcCents(openCycle.chargedUsdcE6)} of at most ${RUN_CEILING[runLevel] ?? "1.75"} USDC`,
        action: null,
      }
    : newestCycle && newestCycle.finishedAt
      ? {
          state: "done" as const,
          line:
            newestReport?.status === "written"
              ? `Finished at ${newestCycle.finishedAt.slice(11, 16)} UTC, ${usdcCents(newestCycle.chargedUsdcE6)} USDC, report ready`
              : `Finished at ${newestCycle.finishedAt.slice(11, 16)} UTC, ${usdcCents(newestCycle.chargedUsdcE6)} USDC; ${newestReport ? "no report was written" : "writing the report"}`,
          detail: null,
          action:
            newestReport?.status === "written" ? (
              <Button asChild size="sm" variant="secondary">
                <Link href={reportHref(agentId, newestCycle.cycleId)}>View report</Link>
              </Button>
            ) : null,
        }
      : { state: "idle" as const, line: "No research run yet.", detail: null, action: null };
  // The research record over the chart, and the panel for a picked call.
  const record = shownCycle
    ? runRecord(terminal.lines, {
        chargedUsdcE6: shownCycle.chargedUsdcE6,
        startedAt: shownCycle.startedAt,
        finishedAt: shownCycle.finishedAt,
        now,
      })
    : null;
  const picked = callSel ? (calls.find((x) => x.id === callSel) ?? null) : null;
  const pickedView = picked
    ? (() => {
        const d = describeCall(picked);
        return {
          title: `${picked.tool.replaceAll("_", " ")}${picked.token ? `, ${picked.token}` : ""}`,
          what: d.what,
          got: d.got,
          time: `${picked.at.slice(11, 19)} UTC`,
          cost: picked.chargeUsdc > 0 ? `${picked.chargeUsdc} USDC` : "free",
          links: picked.sites.map((site) => ({ label: site, href: `https://${site}` })),
        };
      })()
    : null;
  // What happened, filtered by a picked line: a stage shows its phase, a source its calls.
  const shownPhases = !branchSel
    ? runPhases
    : branchSel.startsWith("stage-")
      ? runPhases.filter((ph) => ph.id === PHASE_OF_STAGE[branchSel.slice(6)])
      : (() => {
          const lane = branchSel.slice(7);
          const own = calls.filter((x) => x.lane === lane);
          return own.length === 0
            ? []
            : [
                {
                  id: branchSel,
                  title: lines.find((l) => l.id === branchSel)?.label ?? lane,
                  explainer: "Every call to this source in the run.",
                  summary: liveSummary(own),
                  time: own[0]?.at.slice(11, 16) ?? "",
                  details: own.map((x) => ({
                    id: x.id,
                    time: x.at.slice(11, 19),
                    text: `${x.tool}: ${x.request}${x.result ? ` -> ${x.result}` : ""}`,
                    tone: x.failed ? ("bad" as const) : ("info" as const),
                  })),
                },
              ];
        })();
  const activationReport = reportsRead.reports?.links.activation ?? null;
  return (
    <div className="flex flex-col gap-6" data-testid="research-page" data-agent={id}>
      <RunStatusStrip
        state={status.state}
        line={status.line}
        detail={status.detail}
        action={status.action}
        notice={
          finishedNow &&
          reports.some((r) => r.cycleId === finishedNow && r.status === "written") ? (
            <p className="text-sm text-positive" data-testid="new-report-notice">
              New report ready:{" "}
              <Link href={reportHref(agentId, finishedNow)} className="underline">
                read it
              </Link>
            </p>
          ) : null
        }
      />
      <NextResearchStrip
        line={nextLine}
        action={
          <Button
            size="sm"
            disabled={scan?.state === "working" || research.open !== null}
            onClick={() => setScanAsk(true)}
            data-testid="research-now"
          >
            Research now
          </Button>
        }
        status={
          research.open !== null ? (
            <p className="text-xs text-foreground-muted">A run is going on now.</p>
          ) : scan ? (
            <p
              className={
                scan.state === "error" ? "text-xs text-negative" : "text-xs text-foreground-muted"
              }
              data-testid="research-now-status"
            >
              {scan.text}
            </p>
          ) : null
        }
      />
      <Dialog open={scanAsk} onOpenChange={setScanAsk}>
        <DialogContent aria-describedby="research-now-description">
          <DialogHeader>
            <DialogTitle>Research now</DialogTitle>
            <DialogDescription id="research-now-description">{RUN_COST_TEXT}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => setScanAsk(false)}>
              Cancel
            </Button>
            <Button onClick={() => void startScan()} data-testid="research-now-confirm">
              Start the run
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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
          <section aria-label="How the run went" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <SectionLabel as="h2">How the run went</SectionLabel>
              {live ? (
                <span className="text-xs text-positive" data-testid="run-live">
                  Live
                </span>
              ) : null}
            </div>
            {record ? (
              <FactStrip
                items={[
                  { label: "Steps", value: String(record.steps) },
                  { label: "Sources read", value: String(record.sourcesRead) },
                  { label: "Tokens examined", value: String(record.tokensExamined) },
                  {
                    label: "Cost",
                    value: record.costUsdc === null ? "–" : `${record.costUsdc.toFixed(2)} USDC`,
                  },
                  { label: "Time", value: record.elapsed ?? "–" },
                ]}
              />
            ) : null}
            <div className="grid gap-4 lg:grid-cols-3">
              <ResearchBranchChart
                className="lg:col-span-2"
                art={art}
                branches={lines}
                selected={callSel ?? branchSel}
                onSelectBranch={(b) => setBranchSel((x) => (x === b ? null : b))}
                onSelectCall={(c) => setCallSel((x) => (x === c ? null : c))}
                empty={terminal.state === "connecting" ? "Reading the run." : "No calls recorded."}
              />
              {pickedView ? (
                <CallDetailPanel view={pickedView} onClose={() => setCallSel(null)} />
              ) : (
                <p className="text-sm text-foreground-muted">
                  Click a line to filter What happened to it, or a short branch for that step.
                </p>
              )}
            </div>
          </section>

          <section aria-label="What happened" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <SectionLabel as="h2">What happened</SectionLabel>
              {branchSel ? (
                <Button size="sm" variant="ghost" onClick={() => setBranchSel(null)}>
                  Show every phase
                </Button>
              ) : null}
            </div>
            <PhaseList
              phases={shownPhases}
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
              // 2026-10-13: which run it came from; New until opened in this browser.
              note:
                r.status === "written"
                  ? `From the ${r.kind === "ACTIVATION" && activationReport && !activationReport.includes(r.cycleId) ? "Research now" : kindLabel(r.kind)} run on ${minute(r.createdAt)} UTC`
                  : (r.reason ?? "No report was written."),
              badge:
                r.status === "written" &&
                r.cycleId === reports.find((x) => x.status === "written")?.cycleId &&
                !opened.includes(r.cycleId)
                  ? "New"
                  : null,
            }))}
          />
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <ResearchSettings agentId={agentId} />
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
