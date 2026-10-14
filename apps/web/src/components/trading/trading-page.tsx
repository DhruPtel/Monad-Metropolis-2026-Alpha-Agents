"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import type { ManagedAccount } from "@alpha-agents/domain";
import {
  ActivationChecks,
  ApprovalCard,
  Badge,
  Button,
  DecisionList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  CollapsibleCard,
  DocumentList,
  EmptyState,
  ExpandableLine,
  type FactItem,
  FactStrip,
  LiveTrades,
  ManagedAccountChoice,
  PlanSummaryCard,
  PortfolioInsights,
  SectionLabel,
  Skeleton,
  usdcCents,
} from "@alpha-agents/ui";
import { ChevronDown, PlugZap, Wallet } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { type ActivityJson, type GoalPageJson, api, goalApi } from "@/api/client";
import { latestDecided } from "@/agent/plan-card";
import { schedulePoll } from "@/agent/poll";
import { v2AssetRows } from "@/agent/portfolio";
import { assetRows } from "@/agent/portfolio-v3";
import { kindLabel, reportHref } from "@/agent/report-view";
import {
  SWEEP_WORDS,
  decisionRows,
  holdingLine,
  insightRows,
  latestApplied,
  liveTradeRows,
  planIsMet,
  runLabel,
  tradeHistory,
  planRows,
  tradesInFlight,
  txHref,
} from "@/agent/trading-view";
import { useOwnerSession } from "@/agent/use-owner-session";
import { useReports } from "@/agent/use-reports";
import { usePortfolio } from "@/agent/use-portfolio";
import { useWalletSession } from "@/auth/session";
import { useAgentSummary } from "@/components/agent-shell/agent-shell";
import { StatusFor, approvalView } from "@/components/portfolio/portfolio-page";

/** How often the runner checks an armed agent (services/orchestrator/src/runner.ts, RUNNER_EVERY_MS). */
const RUNNER_EVERY_MS = 60_000;
/** The testnet trading profile's cost limit (packages/policy TESTNET_TRADING_PROFILE): 0.5%. */
const TESTNET_COST_LIMIT_BPS = 50;
/** How often Live trades refreshes while a leg is on its way. */
const IN_FLIGHT_POLL_MS = 2_500;
const GOAL_WORD: Readonly<Record<string, string>> = {
  CONSERVATIVE: "Conservative",
  BALANCED: "Balanced",
  AGGRESSIVE: "Aggressive",
};
const minute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
const pctText = (bps: number) =>
  `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;

/**
 * UI-FAST: the agent's Trading tab. Automatic trading at the top with its
 * details in one row; the plan and the portfolio's insights side by side;
 * trades waiting for the owner; every decision (plans, trades, skips,
 * refusals) in one list, newest first. Every figure is a record's; "–" with a
 * muted note where none exists yet. Every action is the portfolio's own code.
 */
export function TradingPage({
  environment,
  agentId,
}: {
  environment: EnvironmentId;
  agentId: bigint;
}) {
  const wallet = useWalletSession();
  const pf = usePortfolio(agentId, environment);
  const shell = useAgentSummary();
  const asOwner = useOwnerSession(agentId);
  // 2026-10-13: the newest reports, the same as the Research tab's, one click from the trades.
  const reportsRead = useReports(agentId);
  const [choiceOpen, setChoiceOpen] = useState(false);
  // 2026-10-13: Automatic trading folds to its state and toggle; the details open on request.
  const [detailsOpen, setDetailsOpen] = useState(false);
  // 2026-10-13: after an approval the page stays here, scrolls to Live trades and says so.
  const liveRef = useRef<HTMLElement | null>(null);
  const [approvedNotice, setApprovedNotice] = useState(false);
  const approvedNow =
    pf.status?.action === "approve-plan" && pf.status.progress.state === "confirmed";
  useEffect(() => {
    if (!approvedNow) return;
    setApprovedNotice(true);
    liveRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [approvedNow]);
  // A link to #plan (Review plan, from the Research tab) lands on the plan once it has loaded.
  const planLoaded = pf.planCard !== null;
  useEffect(() => {
    if (planLoaded && window.location.hash === "#plan")
      document.getElementById("plan")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [planLoaded]);
  const [choice, setChoice] = useState<ManagedAccount>("vault");
  // The agent's public activity (the trades its limits refused): every 30 s, one read at a time.
  const [activity, setActivity] = useState<readonly ActivityJson[]>([]);
  const [activityTick, setActivityTick] = useState(0);
  useEffect(() => {
    let live = true;
    let cancel: (() => void) | null = null;
    void api
      .activity(agentId)
      .then(
        (a) => live && setActivity(a),
        () => undefined,
      )
      .then(() => {
        if (live) cancel = schedulePoll(() => setActivityTick((t) => t + 1), 30_000);
      });
    return () => {
      live = false;
      cancel?.();
    };
  }, [agentId, activityTick]);
  // The goal's limits, read once with the owner session.
  const [goal, setGoal] = useState<GoalPageJson | null>(null);
  useEffect(() => {
    if (!wallet.ready) return;
    let live = true;
    void asOwner((t) => goalApi.get(agentId, t)).then(
      (g) => live && setGoal(g),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [agentId, asOwner, wallet.ready]);

  // Live trades refreshes every few seconds while a leg is on its way.
  const inFlight = tradesInFlight(pf.intents);
  const { refresh } = pf;
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(refresh, IN_FLIGHT_POLL_MS);
    return () => clearInterval(id);
  }, [inFlight, refresh]);

  const network = wallet.target.name;
  const p = pf.portfolio;
  const acting = pf.acting;

  if (!wallet.ready && wallet.state !== "wrong-chain")
    return (
      <EmptyState
        icon={Wallet}
        title="Connect your wallet"
        description="Trading opens once you connect the wallet that owns this agent."
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
        title={`Switch to ${network}`}
        description="Your wallet is on another network. Switch it to manage this agent."
        action={<Button onClick={wallet.switchChain}>Switch network</Button>}
      />
    );
  if (!p)
    return pf.error ? (
      <EmptyState icon={PlugZap} title="Could not read this agent" description={pf.error} />
    ) : (
      <TradingSkeleton />
    );

  const holdingRows = p.custody === "v3" ? assetRows(p) : v2AssetRows(p);
  const total = p.custody === "v3" ? p.navUsdcE6 : null;
  const armingState = pf.arming?.arming.state ?? "unarmed";
  const on = armingState !== "unarmed";
  const read = pf.activation?.available ? pf.activation : null;
  const activation = read?.activation ?? null;
  const canSweep =
    read !== null &&
    (activation === null || !["running", "plan_ready", "active"].includes(activation.status));
  const blocked = read?.checks.some((c) => !c.ok && c.blocking) ?? false;
  const accounts = pf.arming?.accounts ?? null;
  const askAccount = armingState === "unarmed" && accounts !== null && accounts.vault !== null;
  const turnOn = () => {
    if (askAccount) {
      setChoice(accounts?.chosen ?? accounts?.managed ?? "vault");
      setChoiceOpen(true);
    } else if (read) pf.turnOn();
    else pf.arm();
  };
  const sweepLine = activation
    ? `${SWEEP_WORDS[activation.status] ?? activation.outcome.title}: ${activation.outcome.message}`
    : read
      ? "No activation sweep has run yet."
      : "Sweeps are not available on this network.";
  const unmet = read?.checks.filter((c) => !c.ok) ?? [];

  const card = pf.planCard;
  const pending = card?.pending ?? null;
  const applied = latestApplied(card);
  const shown = pending ?? applied ?? (card ? latestDecided(card) : null);
  const planParams = (pending ?? applied)?.plan ?? null;
  const runner = pf.why?.runner ?? null;
  const settled = pf.intents
    .filter((i) => i.status === "settled")
    .map((i) => i.settledAt ?? i.createdAt)
    .sort()
    .at(-1);
  const goalWord = shell?.summary?.goal?.configured
    ? (GOAL_WORD[shell.summary.goal.aggressiveness ?? ""] ?? "Set")
    : shell?.summary
      ? "No goal"
      : "–";
  const ownerMax = goal?.config?.ownerLimits.maxTradeBps ?? null;
  const planMax = planParams?.maxLegBps ?? null;
  const maxTrade =
    ownerMax === null && planMax === null
      ? null
      : Math.min(ownerMax ?? Number.POSITIVE_INFINITY, planMax ?? Number.POSITIVE_INFINITY);
  const facts: FactItem[] = [
    {
      label: "Status",
      value:
        armingState === "armed"
          ? runner
            ? `On, ${runner.outcome}`
            : "On"
          : armingState === "awaiting_first_trade"
            ? "On after your approval"
            : "Off",
    },
    settled
      ? { label: "Last acted", value: minute(settled) }
      : { label: "Last acted", value: "–", note: "No trade yet" },
    runner
      ? { label: "Last check", value: minute(runner.lastAt) }
      : { label: "Last check", value: "–" },
    on && runner
      ? {
          label: "Next check",
          value: minute(new Date(Date.parse(runner.lastAt) + RUNNER_EVERY_MS).toISOString()),
          note: "Every minute",
        }
      : { label: "Next check", value: "–", note: on ? "Not checked yet" : "Off" },
    maxTrade === null
      ? { label: "Max trade", value: "–" }
      : { label: "Max trade", value: `${pctText(maxTrade)} of value` },
    environment === "testnet"
      ? { label: "Min trade", value: "None", note: "Testnet: gas decides" }
      : planParams?.minTradeUsdcE6
        ? { label: "Min trade", value: `${usdcCents(planParams.minTradeUsdcE6)} USDC` }
        : { label: "Min trade", value: "–", note: "No plan yet" },
    { label: "Daily loss limit", value: "–", note: "Not a limit this account has" },
    shell?.summary
      ? { label: "Credits", value: `${usdcCents(shell.summary.credits)} USDC` }
      : { label: "Credits", value: "–" },
  ];
  const waiting = pf.intents.filter((i) => i.status === "awaiting_approval");
  const decisions = decisionRows({
    card,
    intents: pf.intents,
    activity,
    runner,
    reportFor: (cycleId) => reportHref(agentId, cycleId),
    txFor: (hash) => txHref(environment, hash),
  });
  const waitingPlan = pending !== null && shown?.proposalId === pending.proposalId;
  // 2026-10-13: a plan the account already matches is a Hold: approving it trades nothing.
  const shownRows = shown ? planRows(shown, card, holdingRows) : [];
  const shownMet = planIsMet(shownRows);
  const approvedPlans = [...(card?.recent ?? [])].filter((p) => p.status === "applied");
  const live = liveTradeRows(
    pf.intents,
    applied?.decidedAt ?? null,
    (hash) => txHref(environment, hash),
    approvedPlans,
  );
  const history = tradeHistory(pf.intents, (hash) => txHref(environment, hash), Date.now());
  const holding = holdingLine(
    runner,
    environment === "testnet" ? TESTNET_COST_LIMIT_BPS : (planParams?.costHurdleBps ?? null),
  );

  return (
    <div className="flex flex-col gap-6" data-testid="trading">
      <section
        aria-label="Automatic trading"
        className="flex flex-col gap-3 rounded-md border border-border p-4"
        data-testid="automatic-trading"
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium">Automatic trading:</span>
          {pf.arming === null ? (
            <Skeleton className="h-5 w-16" data-testid="trading-state-loading" />
          ) : (
            <Badge tone={on ? "positive" : "neutral"} data-testid="trading-state">
              {on ? "On" : "Off"}
            </Badge>
          )}
          <span className="ml-auto flex flex-wrap gap-2">
            {pf.arming === null ? null : on ? (
              <>
                {pf.arming.arming.renewalDue ? (
                  <Button
                    size="sm"
                    disabled={acting || !pf.arming.grantCall}
                    onClick={() => pf.arm()}
                  >
                    Renew
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="danger"
                  disabled={acting}
                  onClick={pf.disarm}
                  data-testid="turn-off"
                >
                  Turn off
                </Button>
              </>
            ) : canSweep || !read ? (
              <Button
                size="sm"
                disabled={acting || blocked || !pf.arming.grantCall}
                onClick={turnOn}
                data-testid="turn-on"
              >
                Turn on
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={detailsOpen}
              aria-controls="automatic-trading-details"
              onClick={() => setDetailsOpen((o) => !o)}
              data-testid="automatic-trading-toggle-details"
            >
              {detailsOpen ? "Hide details" : "Details"}
              <ChevronDown aria-hidden className={detailsOpen ? "size-4 rotate-180" : "size-4"} />
            </Button>
          </span>
        </div>
        <div
          id="automatic-trading-details"
          hidden={!detailsOpen}
          className="flex flex-col gap-3"
          data-testid="automatic-trading-details"
        >
          {accounts ? (
            <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="traded-account">
              <span className="text-foreground-muted">Trades</span>
              <span className="font-medium">
                {accounts.managed === "vault" ? "Its vault" : "Trading account"}
              </span>
              {accounts.vault ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={acting || !pf.arming?.grantCall}
                  onClick={() => {
                    setChoice(accounts.managed === "vault" ? "personal" : "vault");
                    setChoiceOpen(true);
                  }}
                  data-testid="switch-account"
                >
                  Switch
                </Button>
              ) : null}
            </p>
          ) : null}
          <p className="text-sm text-foreground-muted" data-testid="sweep-line">
            {sweepLine}
          </p>
          <FactStrip items={facts} className="border-t border-border pt-3" />
          {!on && unmet.length > 0 && read ? (
            <ExpandableLine
              summary={`${unmet.length} ${unmet.length === 1 ? "thing" : "things"} to do before it can start`}
            >
              <ActivationChecks
                checks={read.checks}
                ceilingUsdcE6={read.ceilingUsdcE6}
                tierLabel={read.tier.label}
                actions={{
                  GOAL: (
                    <Button asChild size="sm" variant="secondary">
                      <Link href={`/agents/${agentId.toString()}/goal`}>Set goal</Link>
                    </Button>
                  ),
                  TRADING_BALANCE: (
                    <Button asChild size="sm" variant="secondary">
                      <Link href={`/agents/${agentId.toString()}`}>Deposit</Link>
                    </Button>
                  ),
                  CREDITS: (
                    <Button asChild size="sm" variant="secondary">
                      <Link href={`/agents/${agentId.toString()}`}>Add credits</Link>
                    </Button>
                  ),
                }}
              />
            </ExpandableLine>
          ) : null}
        </div>
        <StatusFor status={pf.status} actions={["arm", "turn-on", "disarm"]} />
      </section>

      <CollapsibleCard title="Trade history" value={history.line} testId="trade-history">
        <div className="max-h-80 overflow-y-auto">
          <LiveTrades
            items={history.rows}
            holding={null}
            empty="No trades yet: each one the agent makes is listed here."
          />
        </div>
      </CollapsibleCard>

      <section
        aria-label="Live trades"
        className="flex flex-col gap-3"
        id="live-trades"
        ref={liveRef}
      >
        <SectionLabel as="h2">Live trades</SectionLabel>
        {approvedNotice ? (
          <p className="text-sm text-positive" data-testid="plan-approved-notice">
            Plan approved. The agent is trading toward it; each trade appears below.
          </p>
        ) : null}
        <LiveTrades
          items={live}
          holding={holding}
          progress={
            applied ? planRows(applied, card, holdingRows).filter((r) => r.targetBps !== null) : []
          }
          empty={
            applied
              ? "No trades since this plan was approved yet: each one shows here as it happens."
              : "Trades show here as they happen, once a plan is approved."
          }
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3" id="plan">
          <SectionLabel as="h2">Plan</SectionLabel>
          {card === null ? (
            <Skeleton className="h-56 w-full" data-testid="plan-loading" />
          ) : shown ? (
            <PlanSummaryCard
              heading={
                waitingPlan
                  ? shownMet
                    ? "Waiting for your approval: Hold, no trade needed"
                    : "Waiting for your approval"
                  : `In force since ${(shown.decidedAt ?? shown.createdAt).slice(0, 10)}`
              }
              badge={
                waitingPlan
                  ? { label: "Waiting", tone: "warning" }
                  : shown.status === "applied"
                    ? { label: "Approved", tone: "positive" }
                    : { label: shown.status.replaceAll("_", " "), tone: "neutral" }
              }
              goal={goalWord}
              rows={shownRows}
              source={
                shownMet
                  ? `${runLabel(shown) ?? "From research"}. The account already matches this plan: approving it keeps the plan in force current, and no trade is made.`
                  : runLabel(shown)
              }
              rationale={shown.rationale.portfolioView}
              reportHref={shown.cycleId ? reportHref(agentId, shown.cycleId) : null}
              linkAs={Link}
              actions={
                waitingPlan ? (
                  <>
                    <Button
                      size="sm"
                      disabled={acting}
                      onClick={() => pf.approveProposal(pending.proposalId)}
                      data-testid="approve-plan"
                    >
                      {shownMet ? "Approve (no trades)" : "Approve plan"}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={acting}
                      onClick={() => pf.rejectProposal(pending.proposalId)}
                      data-testid="decline-plan"
                    >
                      Decline
                    </Button>
                  </>
                ) : undefined
              }
            />
          ) : (
            <p
              className="rounded-md border border-border p-4 text-sm text-foreground-muted"
              data-testid="plan-none"
            >
              No plan yet: the activation sweep makes the first one.
            </p>
          )}
          <StatusFor status={pf.status} actions={["approve-plan", "reject-plan"]} />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <SectionLabel as="h2">Portfolio insights</SectionLabel>
          <PortfolioInsights items={insightRows(holdingRows, total, pf.intents, Date.now())} />
        </div>
      </div>

      <section aria-label="Reports" className="flex flex-col gap-3" data-testid="trading-reports">
        <SectionLabel as="h2">Reports</SectionLabel>
        {reportsRead.error ? (
          <p className="text-sm text-warning">{reportsRead.error}</p>
        ) : (
          <DocumentList
            linkAs={Link}
            empty="No reports yet: the first is written when a research run ends."
            rows={(reportsRead.reports?.reports ?? [])
              .filter((r) => r.status === "written")
              .slice(0, 5)
              .map((r) => ({
                id: r.cycleId,
                title: r.summary ?? `${kindLabel(r.kind)} report`,
                type: kindLabel(r.kind),
                date: r.createdAt.slice(0, 10),
                href: reportHref(agentId, r.cycleId),
              }))}
          />
        )}
      </section>

      {waiting.length > 0 ? (
        <section aria-label="Waiting for you" className="flex flex-col gap-3">
          <SectionLabel as="h2">Waiting for you</SectionLabel>
          {waiting.slice(0, 3).map((i) => (
            <ApprovalCard
              key={i.intentId}
              approval={approvalView(i, p, network, armingState === "awaiting_first_trade")}
              actions={
                <>
                  {armingState === "unarmed" ? null : (
                    <Button size="sm" disabled={acting} onClick={() => pf.approve(i.intentId)}>
                      {armingState === "awaiting_first_trade" ? "Approve and arm" : "Approve"}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={acting}
                    onClick={() => pf.reject(i.intentId)}
                  >
                    Reject
                  </Button>
                </>
              }
            />
          ))}
          <StatusFor status={pf.status} actions={["approve", "reject"]} />
        </section>
      ) : null}

      <section aria-label="Decisions" className="flex flex-col gap-3">
        <SectionLabel as="h2">Decisions</SectionLabel>
        <DecisionList
          items={decisions}
          empty="No decisions yet: the first comes with the activation sweep."
          linkAs={Link}
        />
      </section>

      <Dialog open={choiceOpen} onOpenChange={setChoiceOpen}>
        <DialogContent aria-describedby="managed-account-description">
          <DialogHeader>
            <DialogTitle>Which account should the agent manage?</DialogTitle>
            <DialogDescription id="managed-account-description">
              This agent has a vault and a trading account. The trading permission your wallet
              registers next serves the one you choose.
            </DialogDescription>
          </DialogHeader>
          <ManagedAccountChoice
            value={choice}
            onValueChange={setChoice}
            vault={accounts?.vault ? { address: accounts.vault } : null}
            personal={accounts?.personal ? { address: accounts.personal } : null}
            disabled={acting}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => setChoiceOpen(false)}>
              Cancel
            </Button>
            <Button
              data-testid="confirm-managed-account"
              disabled={acting}
              onClick={() => {
                setChoiceOpen(false);
                // Already on, a switch registers the permission for the chosen account alone.
                if (on || !read) pf.arm(choice);
                else pf.turnOn(choice);
              }}
            >
              {on ? "Switch" : "Turn on"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The Trading tab's layout while its first read is out: the shapes, no figures. */
function TradingSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="trading-loading" aria-busy="true">
      <Skeleton className="h-36 w-full" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
