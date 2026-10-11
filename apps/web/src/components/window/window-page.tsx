"use client";

import { type EnvironmentId, ENVIRONMENTS } from "@alpha-agents/config";
import {
  AllocationDonut,
  AssetMakeupTable,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  HundredDollarTile,
  PerformanceChart,
  ScoreTiles,
  Skeleton,
  Tag,
} from "@alpha-agents/ui";
import { ArrowLeft, PlugZap, RotateCcw, Wallet } from "lucide-react";
import Link from "next/link";
import { useWindow } from "@/agent/use-window";
import { useWalletSession } from "@/auth/session";

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/**
 * The portfolio window (F-U11, D-368): what the agent holds and how it is
 * performing, in numbers the owner can trust. Every figure comes from the
 * control API's window read; performance is on the account's value per
 * unit, so deposits and withdrawals never read as gains or losses. The
 * current plan, the recent trades and why the agent did not trade are a
 * link away, on the portfolio page.
 */
export function WindowPage({
  environment,
  agentId,
}: {
  environment: EnvironmentId;
  agentId: bigint;
}) {
  const wallet = useWalletSession();
  const { window: w, error, refresh } = useWindow(agentId);
  const name = `Agent #${agentId.toString()}`;
  const network = ENVIRONMENTS[environment].label;
  const portfolio = `/agents/${agentId.toString()}/portfolio`;

  const header = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-foreground-muted">
        <Link href="/agents" className="flex items-center gap-1">
          <ArrowLeft aria-hidden className="size-4" /> My Agents
        </Link>
        <Link href={portfolio}>Portfolio</Link>
        <Link href={`/agents/${agentId.toString()}/goal`}>Goal</Link>
      </div>
      <h1 className="text-2xl font-semibold">{name}: performance window</h1>
      <p className="max-w-2xl text-sm text-foreground-muted">
        What {name} holds on {network} and how it is doing, on the account&apos;s value per unit:
        your deposits and withdrawals never count as gains or losses.
      </p>
    </div>
  );

  if (!wallet.ready && wallet.state !== "wrong-chain")
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState
          icon={Wallet}
          title="Connect your wallet"
          description="The window appears once you connect the wallet that owns this agent."
          action={
            <Button onClick={wallet.connect}>
              <Wallet aria-hidden /> Connect wallet
            </Button>
          }
        />
      </div>
    );
  if (wallet.state === "wrong-chain")
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState
          icon={PlugZap}
          title={`Switch to ${network}`}
          description="Your wallet is on another network. Switch it to see this agent's window."
          action={<Button onClick={wallet.switchChain}>Switch network</Button>}
        />
      </div>
    );
  if (!w)
    return (
      <div className="flex flex-col gap-6">
        {header}
        {error ? (
          <EmptyState
            icon={PlugZap}
            title="Could not read this window"
            description={error}
            action={
              <Button variant="secondary" onClick={refresh}>
                <RotateCcw aria-hidden /> Try again
              </Button>
            }
          />
        ) : (
          <div aria-busy="true" aria-label="Loading the window" className="flex flex-col gap-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        )}
      </div>
    );
  if (!w.account)
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState
          icon={PlugZap}
          title="No trading account yet"
          description="The window fills once the agent has a trading account with a deposit in it. Open one on the portfolio page."
          action={
            <Button asChild>
              <Link href={portfolio}>Open the portfolio</Link>
            </Button>
          }
        />
      </div>
    );

  return (
    <div className="flex flex-col gap-6" data-testid="window">
      {header}
      <div className="flex flex-wrap items-center justify-between gap-3" data-testid="window-as-of">
        <span className="flex flex-wrap items-center gap-2 text-sm text-foreground-muted">
          {w.asOf ? (
            <>
              <Tag tone={w.asOf.live ? "neutral" : "warning"} size="md">
                {w.asOf.live ? "Read live from the chain" : "From the latest snapshot"}
              </Tag>
              <span>
                as of <span className="numeric">{when(w.asOf.at)}</span>
                {w.asOf.block ? (
                  <>
                    , block <span className="numeric">{w.asOf.block}</span>
                  </>
                ) : null}
              </span>
            </>
          ) : null}
          {w.history.points > 0 ? (
            <span>
              · <span className="numeric">{w.history.points}</span> readings
              {w.history.from ? (
                <>
                  {" "}
                  since <span className="numeric">{when(w.history.from)}</span>
                </>
              ) : null}
              {w.history.capped ? " (the oldest are cut off)" : ""}
            </span>
          ) : null}
        </span>
        <Button variant="secondary" size="sm" onClick={refresh}>
          <RotateCcw aria-hidden /> Refresh
        </Button>
      </div>

      <section aria-label="Scores" className="flex flex-col gap-4" id="scores">
        <HundredDollarTile hundred={w.hundred} />
        <ScoreTiles scores={w.scores} />
      </section>

      <Card id="performance">
        <CardHeader>
          <CardTitle>Performance over time</CardTitle>
          <CardDescription>
            Every 15 minutes and after every trade the platform records the account&apos;s value per
            unit. A deposit mints units and a withdrawal burns them at the going value, so neither
            moves this line.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PerformanceChart series={w.series} marks={w.marks} />
        </CardContent>
      </Card>

      <Card id="makeup">
        <CardHeader>
          <CardTitle>Asset makeup</CardTitle>
          <CardDescription>
            Every token the account holds, what it is worth, its share, what it cost and its gain or
            loss since it was bought.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 xl:grid-cols-[1fr_auto]">
          <AssetMakeupTable rows={w.holdings} totalValueUsdcE6={w.totalValueUsdcE6} asOf={w.asOf} />
          <AllocationDonut rows={w.holdings} />
        </CardContent>
      </Card>

      <Card data-testid="window-links">
        <CardHeader>
          <CardTitle>What the agent is doing</CardTitle>
          <CardDescription>
            The plan it follows, its recent trades and why it did not trade are on the portfolio
            page.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-row flex-wrap gap-2">
          <Button asChild variant="secondary" size="sm">
            <Link href={`${portfolio}#plan`}>Current plan</Link>
          </Button>
          <Button asChild variant="secondary" size="sm">
            <Link href={`${portfolio}#trades`}>Recent trades</Link>
          </Button>
          <Button asChild variant="secondary" size="sm">
            <Link href={`${portfolio}#why`}>Why the agent did not trade</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
