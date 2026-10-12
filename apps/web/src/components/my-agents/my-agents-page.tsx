"use client";

import { type EnvironmentId, ENVIRONMENTS } from "@alpha-agents/config";
import { slotsFor, speciesAsset, speciesByIndex } from "@alpha-agents/domain";
import {
  PendingAgentNotice,
  AgentCard,
  ActivityFeed,
  Button,
  Card,
  CreditsTile,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  FundAgentPanel,
  GoalSummary,
  PageLoading,
  RunStatusBadge,
  SectionLabel,
  Skeleton,
  SpeciesArt,
  SpendPanel,
  Tag,
  TradingTile,
  type TradingTileView,
} from "@alpha-agents/ui";
import { Bot, Compass, PlugZap, Plus, RotateCcw, Wallet } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { Address } from "viem";
import { AddCreditsSection } from "@/components/credits/add-credits-section";
import { AgentHoldings } from "@/components/holdings/agent-holdings";
import { useWalletSession } from "@/auth/session";
import type { AgentView } from "@/agent/chain";
import {
  myAgentsPageState,
  othersKeepCredits,
  refundAmountText,
  refundAvailability,
  researchLine,
  scanAvailability,
  scanStatusText,
  tradingStateWords,
} from "@/agent/my-agents";
import { useOwnedAgents } from "@/agent/use-agents";
import { type ActionState, useMyAgent } from "@/agent/use-my-agent";

const TIER_TONE = { base: "neutral", medium: "rare", pro: "legendary" } as const;
const TIER_NAME = { base: "Base", medium: "Medium", pro: "Pro" } as const;

/** One action's outcome, said once, for screen readers too. */
function ActionLine({ action, testId }: { action: ActionState; testId: string }) {
  if (action.state === "idle") return null;
  return (
    <p
      role="status"
      data-testid={testId}
      data-action-state={action.state}
      className={
        action.state === "error"
          ? "text-sm text-negative"
          : action.state === "done"
            ? "text-sm text-positive"
            : "text-sm text-foreground-muted"
      }
    >
      {action.message}
    </p>
  );
}

/**
 * One owned agent (UI-U1, the owner's UI direction): the trading account as
 * the centerpiece with one obvious action, the credits and the research
 * action near the top, and the spend, the activity, the funding address and
 * every holding at the bottom.
 */
function MyAgentCard({ agent, environment }: { agent: AgentView; environment: EnvironmentId }) {
  const id = agent.id.toString();
  const name = `Alpha Agent #${id}`;
  const species = agent.species === 0 ? null : speciesByIndex(agent.species);
  const {
    summary,
    activity,
    trading,
    windowView,
    armingState,
    error,
    refund,
    scan,
    requestRefund,
    requestScan,
    refresh,
  } = useMyAgent(agent.id);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const canScan = summary ? scanAvailability(summary) : null;
  const canRefund = summary ? refundAvailability(summary) : null;
  const scanLine = summary ? scanStatusText(summary) : null;
  const state = trading?.hasAccount ? tradingStateWords(armingState) : null;
  const tile: TradingTileView | null = trading
    ? {
        hasAccount: trading.hasAccount,
        valueUsdcE6: trading.valueUsdcE6,
        mode: trading.mode ?? null,
        makeup: trading.makeup,
        series: windowView?.series ?? null,
        usdcShareBps: trading.usdcShareBps,
        ...(trading.restLabel ? { restLabel: trading.restLabel } : {}),
        ...(state ? { state } : {}),
      }
    : null;

  return (
    <Card
      className="flex flex-col gap-5 p-5"
      data-testid="my-agent-card"
      data-agent-id={id}
      aria-labelledby={`agent-${id}-name`}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <SpeciesArt
          image={species ? speciesAsset(agent.species).image : null}
          speciesName={species?.name ?? null}
          tier={species?.tier ?? null}
          className="max-w-32 self-center sm:self-start"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={`agent-${id}-name`} className="text-lg font-semibold">
              {name}
            </h2>
            {species ? (
              <>
                <Tag tone={TIER_TONE[species.tier]} size="md">
                  {TIER_NAME[species.tier]}
                </Tag>
                <Tag size="md">{species.name}</Tag>
              </>
            ) : (
              <Tag size="md">Unrevealed</Tag>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {summary ? (
              <RunStatusBadge status={summary.runStatus} />
            ) : error ? null : (
              <Skeleton className="h-5 w-28" />
            )}
          </div>
          {summary?.goal ? (
            <GoalSummary
              state={summary.goal.state}
              aggressiveness={summary.goal.aggressiveness}
              action={
                <Button asChild size="sm" variant="ghost">
                  <Link href={`/agents/${id}/goal`}>
                    {summary.goal.configured ? "Change goal" : "Set goal"}
                  </Link>
                </Button>
              }
            />
          ) : null}
          {summary?.runStatus === "awaiting_reveal" ? (
            <p className="text-sm text-foreground-muted" data-testid="unrevealed-note">
              Minted and waiting for its reveal, which draws its species and tier. It is set up to
              run right after.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-negative" data-testid="card-error">
              {error}
            </p>
          ) : null}
        </div>
        <Button asChild variant="secondary" size="sm" className="self-start">
          <Link href={`/configure?agent=${id}`}>Configure</Link>
        </Button>
      </div>

      {summary ? (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <TradingTile
              agentName={name}
              trading={tile}
              primary={
                <Button asChild size="sm">
                  <Link href={`/agents/${id}/portfolio`}>
                    {trading?.hasAccount ? "Open portfolio" : "Set up trading"}
                  </Link>
                </Button>
              }
              secondary={
                <>
                  {trading?.hasAccount ? (
                    <Button asChild size="sm" variant="secondary">
                      <Link href={`/agents/${id}/window`}>Performance</Link>
                    </Button>
                  ) : null}
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/agents/${id}/skills`} data-testid="skills-link">
                      Skills
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/agents/${id}/settings`} data-testid="settings-link">
                      Settings
                    </Link>
                  </Button>
                </>
              }
            />
            <CreditsTile
              agentName={name}
              creditsUsdcE6={summary.credits}
              capUsdcE6={summary.creditCap}
              heldUsdcE6={summary.held}
              restrictedNote={
                summary.runStatus === "restricted"
                  ? `Research is paused because ${name} has no credits. Safety checks keep running. Add credits to resume.`
                  : null
              }
              addCredits={
                <>
                  <Dialog open={creditsOpen} onOpenChange={setCreditsOpen}>
                    <DialogTrigger asChild>
                      <Button size="sm" data-testid="open-add-credits">
                        <Plus aria-hidden /> Add credits
                      </Button>
                    </DialogTrigger>
                    <DialogContent aria-describedby={`agent-${id}-credits-description`}>
                      <DialogHeader>
                        <DialogTitle>Add credits to {name}</DialogTitle>
                        <DialogDescription id={`agent-${id}-credits-description`}>
                          Your wallet sends USDC to {name}&apos;s funding address in one
                          transaction, and it becomes credits with no other step.
                        </DialogDescription>
                      </DialogHeader>
                      <AddCreditsSection
                        agentId={agent.id}
                        agentName={name}
                        environment={environment}
                        fundingAddress={
                          (summary.funding?.fundingAddress as Address | undefined) ?? null
                        }
                        creditsUsdcE6={summary.credits}
                        capUsdcE6={summary.creditCap}
                        onCredited={refresh}
                      />
                    </DialogContent>
                  </Dialog>
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!canRefund?.enabled || refund.state === "working"}
                      >
                        <RotateCcw aria-hidden /> Refund credits
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Refund {name}&apos;s credits?</DialogTitle>
                        <DialogDescription>
                          Sends {refundAmountText(summary)}, your own share of the credits, from its
                          funding address to your wallet.{" "}
                          {othersKeepCredits(summary)
                            ? "Credits other people contributed stay with the agent. "
                            : null}
                          The refund is tied to your ownership (epoch{" "}
                          <span className="numeric">{summary.ownerEpoch.toString()}</span>): if{" "}
                          {name} changes hands first, it is refused and the credits stay with the
                          agent. Research pauses until it is funded again.
                        </DialogDescription>
                      </DialogHeader>
                      <DialogFooter>
                        <DialogClose asChild>
                          <Button variant="secondary">Cancel</Button>
                        </DialogClose>
                        <DialogClose asChild>
                          <Button onClick={requestRefund}>Refund</Button>
                        </DialogClose>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </>
              }
              research={
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!canScan?.enabled || scan.state === "working"}
                  onClick={requestScan}
                >
                  <Compass aria-hidden /> Research now
                </Button>
              }
              researchLine={researchLine(summary, name)}
              researchStatus={
                <>
                  {canScan && !canScan.enabled ? (
                    <p className="text-xs text-foreground-muted" data-testid="scan-unavailable">
                      {canScan.reason}
                    </p>
                  ) : null}
                  {scanLine ? (
                    <p className="text-xs text-foreground-muted" data-testid="scan-status">
                      {scanLine}
                    </p>
                  ) : null}
                  <ActionLine action={scan} testId="scan-result" />
                  <ActionLine action={refund} testId="refund-result" />
                </>
              }
            />
          </div>

          <div className="grid gap-6 border-t border-border pt-5 lg:grid-cols-3">
            <SpendPanel
              agentName={name}
              spent24hUsdcE6={summary.spent24h}
              charges={summary.charges.slice(0, 8)}
            />
            <section aria-label={`Activity of ${name}`} className="flex flex-col gap-3">
              <SectionLabel as="h4">Activity</SectionLabel>
              <ActivityFeed
                label={`Activity entries of ${name}`}
                entries={activity.slice(0, 5)}
                empty="No activity yet. Entries appear after each research run."
              />
            </section>
            <FundAgentPanel agentName={name} funding={summary.funding} />
          </div>
          <AgentHoldings agentId={agent.id} environment={environment} />
        </>
      ) : error ? null : (
        <div className="grid gap-4 lg:grid-cols-3" aria-busy="true" aria-label={`Reading ${name}`}>
          <Skeleton className="h-40 w-full lg:col-span-2" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}
    </Card>
  );
}

/**
 * My Agents (P1-U9, D-218; redesigned in UI-U1): every agent the connected
 * wallet owns, its trading account first, then its credits and research,
 * and its spend, activity, funding address and holdings. 3D stays on /configure.
 */
export function MyAgentsPage({ environment }: { environment: EnvironmentId }) {
  const wallet = useWalletSession();
  const owned = useOwnedAgents(environment);
  const state = myAgentsPageState(wallet, {
    status: owned.status,
    count: owned.agents.length,
    hasMinted: owned.hasMinted,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">My Agents</h1>
        <p className="max-w-2xl text-sm text-foreground-muted">
          Your agents on {wallet.target.name}: each one&apos;s trading account, its credits and
          research, and what it holds.
        </p>
      </div>
      {state === "logged-out" || state === "connecting" ? (
        <EmptyState
          icon={Wallet}
          title="Connect your wallet"
          description="Your agents, their credits and their activity appear here once you connect the wallet that owns them."
          action={
            state === "logged-out" ? (
              <Button onClick={wallet.connect}>
                <Wallet aria-hidden /> Connect wallet
              </Button>
            ) : undefined
          }
        />
      ) : state === "wrong-chain" ? (
        <EmptyState
          icon={PlugZap}
          title={`Switch to ${wallet.target.name}`}
          description="Your wallet is on another network. Switch it to see your agents."
          action={<Button onClick={wallet.switchChain}>Switch network</Button>}
        />
      ) : state === "not-deployed" ? (
        <EmptyState
          icon={PlugZap}
          title="Agents are not live on this network yet"
          description={`AgentNFT is not deployed on ${ENVIRONMENTS[environment].label}.`}
        />
      ) : state === "loading" ? (
        <PageLoading label="Reading your agents from the chain" />
      ) : state === "error" ? (
        <EmptyState
          icon={PlugZap}
          title="Could not read your agents"
          description="The platform did not answer. Your agents are safe; try again in a moment."
          action={
            <Button variant="secondary" onClick={owned.refresh}>
              <RotateCcw aria-hidden /> Try again
            </Button>
          }
        />
      ) : state === "empty" ? (
        <EmptyState
          icon={Bot}
          title="No agents in this wallet yet"
          description="Mint an agent to get started. It appears here as soon as it is minted."
          action={
            <Button asChild>
              <Link href="/mint">Mint an agent</Link>
            </Button>
          }
        />
      ) : state === "minted-elsewhere" ? (
        <EmptyState
          icon={Bot}
          title="The agent this wallet minted is no longer in it"
          description="Each wallet mints one agent. Connect the wallet that holds it now to see it here."
        />
      ) : (
        <div className="flex flex-col gap-6" data-testid="my-agents">
          {owned.agents.map((a) =>
            a.indexed ? (
              <MyAgentCard key={a.id.toString()} agent={a} environment={environment} />
            ) : (
              // Read only from the chain (P2-EC): no platform record yet, so no owner
              // controls; the full card replaces it when the index catches up.
              <div key={a.id.toString()} className="flex flex-col gap-3">
                <PendingAgentNotice agentId={a.id} stage={a.pending ?? "indexing"} />
                <AgentCard
                  agentId={a.id}
                  tier={a.species === 0 ? null : speciesByIndex(a.species).tier}
                  speciesName={a.species === 0 ? null : speciesByIndex(a.species).name}
                  image={a.species === 0 ? null : speciesAsset(a.species).image}
                  slots={a.species === 0 ? 0 : slotsFor(speciesByIndex(a.species).tier)}
                  tba={a.tba}
                  owner={a.owner}
                  ownerEpoch={a.ownerEpoch}
                  environment={ENVIRONMENTS[environment].label}
                />
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
