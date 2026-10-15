"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { CHAIN_NAMES, chainOfEnvironment, formatAmount } from "@alpha-agents/domain";
import {
  AccountValueChart,
  ConcentrationPie,
  LinkLine,
  type AssetRow,
  BalancesTable,
  Button,
  CapsPanel,
  Card,
  CardContent,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  GasNotice,
  Skeleton,
  PositionsTable,
  RecentTrades,
  SetupFlow,
  SidePanel,
  SpendPanel,
  StatBar,
  StatTileRow,
  TabbedPanel,
  monthReturnBps,
  percentFromBps as pct,
  usdcCents as usdc2,
} from "@alpha-agents/ui";
import { ArrowDownToLine, ArrowUpFromLine, PlugZap, Plus, RotateCcw, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Address } from "viem";
import { othersKeepCredits, refundAmountText, refundAvailability } from "@/agent/my-agents";
import { ALLOWLIST_WAIT_MESSAGE } from "@/agent/custody";
import { LOW_GAS_WEI, v2AssetRows } from "@/agent/portfolio";
import { assetRows, overviewV3 } from "@/agent/portfolio-v3";
import { setupSteps } from "@/agent/setup-flow";
import { useAgentSummary } from "@/components/agent-shell/agent-shell";
import { usePortfolio } from "@/agent/use-portfolio";
import { useWalletSession } from "@/auth/session";
import { AddCreditsSection } from "@/components/credits/add-credits-section";
import { latestApplied, planBanner, planRows, txHref } from "@/agent/trading-view";
import { AgentActivity } from "@/components/activity/agent-activity";
import { AgentHoldings } from "@/components/holdings/agent-holdings";
import { BringCard } from "@/components/overview/bring-card";
import { CURRENT_NETWORK } from "@/network-sites";
import { ActionLine } from "@/components/my-agents/my-agents-page";
import {
  DepositForm,
  DepositFormV3,
  StatusFor,
  WithdrawForm,
  WithdrawFormV3,
  capsView,
  positionsView,
  standingBlock,
} from "@/components/portfolio/portfolio-page";

const signedUsdc = (e6: bigint) => `${e6 >= 0n ? "+" : "-"}${usdc2(e6 < 0n ? -e6 : e6)} USDC`;

/**
 * UI-FAST: an agent's Overview, the old My Agent detail and Portfolio page in
 * one screen. The centerpiece is the account's value (or PnL) beside its
 * allocation; small figures under it; credits and the trading account on the
 * right; the ledger in tabs below; every holding at the bottom. Research has
 * its own tab. The data and every transaction are the portfolio page's.
 */
export function OverviewPage({
  environment,
  agentId,
}: {
  environment: EnvironmentId;
  agentId: bigint;
}) {
  const wallet = useWalletSession();
  const router = useRouter();
  const pf = usePortfolio(agentId, environment);
  // Credits, refund and spend: the shell's read, shared; the money comes from usePortfolio.
  const me = useAgentSummary();
  const name = `Agent #${agentId.toString()}`;
  const network = wallet.target.name;
  const p = pf.portfolio;
  const acting = pf.acting;
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const goalHref = `/agents/${agentId.toString()}/goal`;
  const tradingHref = `/agents/${agentId.toString()}/trading`;

  if (!wallet.ready && wallet.state !== "wrong-chain")
    return (
      <EmptyState
        icon={Wallet}
        title="Connect your wallet"
        description="This agent's overview opens once you connect the wallet that owns it."
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
      <OverviewSkeleton />
    );

  const v3 = p.custody === "v3" ? p : null;
  const v2 = p.custody === "v2" ? p : null;
  const allowlisted = !p.allowlist.enabled || p.allowlist.listed;
  const armingState = pf.arming?.arming.state ?? "unarmed";
  const rows: readonly AssetRow[] = v3 ? overviewV3(v3).rows : v2 ? v2AssetRows(v2) : [];
  const tableRows: readonly AssetRow[] = v3 ? assetRows(v3) : v2 ? v2AssetRows(v2) : [];
  const total = v3 ? v3.navUsdcE6 : v2 ? (positionsView(v2).totalUsdc?.toString() ?? null) : null;
  const monthBps = pf.windowView ? monthReturnBps(pf.windowView.series) : null;
  const principalE6 = v3 ? BigInt(v3.caps.principalUsdcE6) : null;
  const earnedE6 = principalE6 !== null && total !== null ? BigInt(total) - principalE6 : null;
  const caps = capsView(p);
  const standing = p.account ? standingBlock(p) : null;
  const summary = me?.summary ?? pf.summary;
  const canRefund = me?.summary ? refundAvailability(me?.summary) : null;
  const chain = CHAIN_NAMES[chainOfEnvironment(environment)];
  const steps = setupSteps(
    {
      allowlisted,
      hasAccount: p.account !== null,
      valueUsdcE6: total === null ? null : BigInt(total),
      goalConfigured: pf.summary?.goal ? pf.summary.goal.configured : null,
      armingState,
      custody: p.custody,
    },
    {
      open: (
        <Button size="sm" disabled={!allowlisted || acting} onClick={pf.openAccount}>
          Open trading account
        </Button>
      ),
      deposit: (
        <Button size="sm" onClick={() => setDepositOpen(true)}>
          <ArrowDownToLine aria-hidden /> Deposit
        </Button>
      ),
      goal: (
        <Button asChild size="sm">
          <Link href={goalHref}>Set goal</Link>
        </Button>
      ),
      turnOn: (
        <Button asChild size="sm" variant="secondary">
          <Link href={tradingHref}>Go to Trading</Link>
        </Button>
      ),
    },
  );
  const setupDone = steps.every((s) => s.state === "done");
  const tone = (v: bigint | number | null) =>
    v === null ? "neutral" : v > 0 ? "positive" : v < 0 ? "negative" : "neutral";
  // Each held token's gain on its cost basis, for its slice's label; none where unknown.
  const pnlBySymbol = Object.fromEntries(
    tableRows
      .filter((r) => r.gainUsdcE6 !== null)
      .map((r) => {
        const g = BigInt(r.gainUsdcE6 as string);
        return [r.symbol, { text: signedUsdc(g), tone: tone(g) }] as const;
      }),
  );

  const credits = !summary ? (
    <SidePanel title="Credits" testId="overview-credits">
      <Skeleton className="h-16 w-full" />
    </SidePanel>
  ) : summary ? (
    <SidePanel
      title="Credits"
      testId="overview-credits"
      figure={`${formatAmount(summary.credits, 6, { minFractionDigits: 2, maxFractionDigits: 4 })} USDC`}
      note={`of ${usdc2(summary.creditCap)}; they pay for research`}
      actions={
        <>
          <Button size="sm" onClick={() => setCreditsOpen(true)} data-testid="open-add-credits">
            <Plus aria-hidden /> Add
          </Button>
          {me?.summary ? (
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!canRefund?.enabled || me?.refund.state === "working"}
                >
                  <RotateCcw aria-hidden /> Refund
                </Button>
              </DialogTrigger>
              <RefundDialog
                name={name}
                text={refundAmountText(me?.summary)}
                othersKeep={othersKeepCredits(me?.summary)}
                epoch={me?.summary.ownerEpoch.toString()}
                onRefund={me?.requestRefund}
              />
            </Dialog>
          ) : null}
        </>
      }
    >
      {canRefund && !canRefund.enabled ? (
        <p className="text-xs text-foreground-muted">{canRefund.reason}</p>
      ) : null}
      <ActionLine action={me?.refund ?? { state: "idle" }} testId="refund-result" />
    </SidePanel>
  ) : null;

  const account = p.account ? (
    <SidePanel
      title="Trading account"
      testId="overview-account"
      emphasis
      figure={total === null ? "–" : `${usdc2(total)} USDC`}
      actions={
        <>
          <Button size="sm" onClick={() => setDepositOpen(true)} data-testid="open-deposit">
            <ArrowDownToLine aria-hidden /> Deposit
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setWithdrawOpen(true)}
            data-testid="open-withdraw"
          >
            <ArrowUpFromLine aria-hidden /> Withdraw
          </Button>
        </>
      }
    >
      {standing ? (
        <p role="alert" className="text-xs text-warning" data-testid="deposit-block">
          {standing}
        </p>
      ) : null}
      <StatBar
        label="Beta limit used"
        value={`${usdc2(caps.principalUsdc)} of ${usdc2(caps.personalCapUsdc)} USDC`}
        fillBps={
          caps.personalCapUsdc === 0n
            ? 0
            : Number((caps.principalUsdc * 10_000n) / caps.personalCapUsdc)
        }
      />
      <GasNotice monWei={BigInt(p.wallet.monWei)} lowBelowWei={LOW_GAS_WEI} network={network} />
    </SidePanel>
  ) : null;

  // 2026-10-13: while a plan is being traded, one line says how far it has come.
  const appliedPlan = latestApplied(pf.planCard);
  const banner = appliedPlan
    ? planBanner({
        approvedAt: appliedPlan.decidedAt,
        intents: pf.intents,
        rows: planRows(appliedPlan, pf.planCard, tableRows),
        maxLegBps: appliedPlan.plan?.maxLegBps ?? 1_000,
        bandBps: 500,
      })
    : null;
  return (
    <div className="flex flex-col gap-6" data-testid="overview">
      {banner ? (
        <Link
          href={`/agents/${agentId.toString()}/trading#live-trades`}
          className="rounded-md border border-primary px-4 py-2 text-sm underline-offset-2 hover:underline"
          data-testid="plan-banner"
        >
          {banner}
        </Link>
      ) : null}
      {pf.error ? (
        <p role="alert" className="text-sm text-warning">
          {pf.error} The values below are from the last read.
        </p>
      ) : null}
      {setupDone ? null : <SetupFlow steps={steps} />}
      {pf.planCard?.pending ? (
        <LinkLine href={tradingHref} action="Review" linkAs={Link}>
          A plan is waiting for your approval
        </LinkLine>
      ) : null}
      {environment === "testnet" && CURRENT_NETWORK === "monad" ? (
        <BringCard agentId={agentId} />
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 flex-col gap-4">
          {p.account ? (
            <>
              <Card data-testid="overview-chart">
                <CardContent className="grid gap-6 pt-6 xl:grid-cols-2 xl:items-center">
                  <ConcentrationPie
                    rows={rows}
                    pnl={pnlBySymbol}
                    total={total === null ? "–" : `${usdc2(total)} USDC`}
                    onSelect={() => router.push(tradingHref)}
                  />
                  {pf.windowView === null ? (
                    <Skeleton className="h-64 w-full" data-testid="chart-loading" />
                  ) : (
                    <AccountValueChart
                      series={pf.windowView.series}
                      principalUsdcE6={principalE6 === null ? null : principalE6.toString()}
                      defaultMode={principalE6 === null ? "value" : "pnl"}
                      fixedMode
                      emptyAction={
                        <Button size="sm" variant="secondary" onClick={() => setDepositOpen(true)}>
                          Deposit
                        </Button>
                      }
                    />
                  )}
                </CardContent>
              </Card>
              <StatTileRow
                tiles={[
                  {
                    label: "Total value",
                    value: total === null ? null : `${usdc2(total)} USDC`,
                    testId: "tile-total-value",
                  },
                  {
                    label: "Past month",
                    value: monthBps === null ? null : pct(monthBps, true),
                    tone: tone(monthBps),
                    ...(monthBps === null ? { note: "Needs two readings" } : {}),
                    testId: "tile-month-return",
                  },
                  {
                    label: "Deposits",
                    value: principalE6 === null ? null : `${usdc2(principalE6)} USDC`,
                    testId: "tile-deposits",
                  },
                  {
                    label: "All-time earned",
                    value: earnedE6 === null ? null : signedUsdc(earnedE6),
                    tone: tone(earnedE6),
                    testId: "tile-earned",
                  },
                ]}
              />
            </>
          ) : (
            <section
              aria-label="Open the trading account"
              className="flex flex-col gap-4 rounded-md border border-border p-4"
              data-testid="open-account"
            >
              <p className="text-sm text-foreground-muted">
                A trading account holds {name}&apos;s trading money on {network}. Your wallet
                creates it; only you can withdraw from it, at any time.
              </p>
              {allowlisted ? null : (
                <p role="alert" className="text-sm text-warning" data-testid="allowlist-block">
                  {ALLOWLIST_WAIT_MESSAGE}
                </p>
              )}
              <CapsPanel caps={caps} />
              <StatusFor status={pf.status} actions={["open"]} />
            </section>
          )}
        </div>
        <aside className="flex flex-col gap-3 lg:w-88" aria-label="Trading account and credits">
          {account}
          {credits}
        </aside>
      </div>
      <TabbedPanel
        testId="overview-ledger"
        defaultTab="positions"
        tabs={[
          {
            id: "positions",
            label: "Positions",
            content: <PositionsTable rows={tableRows} chain={chain} />,
          },
          {
            id: "balances",
            label: "Balances",
            content: <BalancesTable rows={tableRows} chain={chain} />,
          },
          {
            id: "trades",
            label: "Trade history",
            content: (
              <RecentTrades
                txHref={(hash) => txHref(environment, hash)}
                trades={pf.intents.map((i) => ({
                  intentId: i.intentId,
                  status: i.status,
                  sell: { asset: i.sell.asset, amount: BigInt(i.sell.amountRaw) },
                  buy: i.buy,
                  amountOut: i.amountOut ? BigInt(i.amountOut.amountRaw) : null,
                  txHash: i.txHash,
                  approvedBy: i.approvedBy,
                  createdAt: i.createdAt,
                  settledAt: i.settledAt,
                }))}
              />
            ),
          },
          {
            id: "spend",
            label: "Spend activity",
            content: me?.summary ? (
              <SpendPanel
                agentName={name}
                spent24hUsdcE6={me?.summary.spent24h}
                charges={me?.summary.charges.slice(0, 12)}
              />
            ) : (
              <p className="text-sm text-foreground-muted">Reading the spend.</p>
            ),
          },
        ]}
      />
      <AgentHoldings agentId={agentId} environment={environment} card />
      <AgentActivity agentId={agentId} environment={environment} />

      <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
        <DialogContent aria-describedby="deposit-description">
          <DialogHeader>
            <DialogTitle>Deposit into the trading account</DialogTitle>
            <DialogDescription id="deposit-description">
              From your wallet. Your wallet approves exactly this amount, then deposits it.
            </DialogDescription>
          </DialogHeader>
          {v3 ? (
            <DepositFormV3 p={v3} busy={acting} status={pf.status} onDeposit={pf.depositToken} />
          ) : v2 ? (
            <DepositForm p={v2} busy={acting} status={pf.status} onDeposit={pf.deposit} />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <DialogContent aria-describedby="withdraw-description">
          <DialogHeader>
            <DialogTitle>Withdraw to your wallet</DialogTitle>
            <DialogDescription id="withdraw-description">
              At any time and in every mode. Withdrawals read no price and need nothing from the
              platform.
            </DialogDescription>
          </DialogHeader>
          {v3 ? (
            <WithdrawFormV3
              p={v3}
              busy={acting}
              status={pf.status}
              onWithdraw={pf.withdrawToken}
              onWithdrawEverything={pf.withdrawEverything}
            />
          ) : v2 ? (
            <WithdrawForm p={v2} busy={acting} status={pf.status} onWithdraw={pf.withdraw} />
          ) : null}
        </DialogContent>
      </Dialog>
      {summary ? (
        <Dialog open={creditsOpen} onOpenChange={setCreditsOpen}>
          <DialogContent aria-describedby="credits-description">
            <DialogHeader>
              <DialogTitle>Add credits to {name}</DialogTitle>
              <DialogDescription id="credits-description">
                Your wallet sends USDC to {name}&apos;s funding address in one transaction, and it
                becomes credits with no other step.
              </DialogDescription>
            </DialogHeader>
            <AddCreditsSection
              agentId={agentId}
              agentName={name}
              environment={environment}
              fundingAddress={(summary.funding?.fundingAddress as Address | undefined) ?? null}
              creditsUsdcE6={summary.credits}
              capUsdcE6={summary.creditCap}
              onCredited={() => {
                pf.refresh();
                me?.refresh();
              }}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

/** The refund's confirmation, as on My Agents. */
function RefundDialog({
  name,
  text,
  othersKeep,
  epoch,
  onRefund,
}: {
  name: string;
  text: string;
  othersKeep: boolean;
  epoch: string;
  onRefund: () => void;
}) {
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Refund {name}&apos;s credits?</DialogTitle>
        <DialogDescription>
          Sends {text}, your own share of the credits, from its funding address to your wallet.{" "}
          {othersKeep ? "Credits other people contributed stay with the agent. " : null}
          The refund is tied to your ownership (epoch <span className="numeric">{epoch}</span>): if{" "}
          {name} changes hands first, it is refused. Research pauses until it is funded again.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">Cancel</Button>
        </DialogClose>
        <DialogClose asChild>
          <Button onClick={onRefund}>Refund</Button>
        </DialogClose>
      </DialogFooter>
    </DialogContent>
  );
}

/** The Overview's layout while its first read is out: the shapes, no figures. */
function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="overview-loading" aria-busy="true">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 flex-col gap-4">
          <Skeleton className="h-72 w-full" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
          <Skeleton className="h-48 w-full" />
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    </div>
  );
}
