"use client";

import { type EnvironmentId, ENVIRONMENTS } from "@alpha-agents/config";
import { speciesAsset, speciesByIndex } from "@alpha-agents/domain";
import {
  ActivityFeed,
  Button,
  Card,
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
  RunStatusBadge,
  SectionLabel,
  Skeleton,
  SpeciesArt,
  SpendPanel,
  Tag,
} from "@alpha-agents/ui";
import { Bot, PlugZap, RotateCcw, Sparkles, Wallet } from "lucide-react";
import Link from "next/link";
import { useWalletSession } from "@/auth/session";
import type { AgentView } from "@/agent/chain";
import {
  myAgentsPageState,
  othersKeepCredits,
  refundAmountText,
  refundAvailability,
  scanAvailability,
  scanCostText,
  scanStatusText,
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

/** One owned agent: what it is, what it is doing, how to fund it, its spend and its activity. */
function MyAgentCard({ agent }: { agent: AgentView }) {
  const name = `Alpha Agent #${agent.id.toString()}`;
  const species = agent.species === 0 ? null : speciesByIndex(agent.species);
  const { summary, activity, trading, error, refund, scan, requestRefund, requestScan } =
    useMyAgent(agent.id);
  const canScan = summary ? scanAvailability(summary) : null;
  const canRefund = summary ? refundAvailability(summary) : null;
  const scanLine = summary ? scanStatusText(summary) : null;

  return (
    <Card
      className="flex flex-col gap-5 p-5"
      data-testid="my-agent-card"
      data-agent-id={agent.id.toString()}
      aria-labelledby={`agent-${agent.id.toString()}-name`}
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
            <h2 id={`agent-${agent.id.toString()}-name`} className="text-lg font-semibold">
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
          {summary?.runStatus === "restricted" ? (
            <p className="text-sm text-foreground-muted" data-testid="restricted-note">
              Research is paused because {name} has no credits. Safety checks keep running. Send
              USDC to its funding address to resume.
            </p>
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
          <Link href={`/configure?agent=${agent.id.toString()}`}>Configure</Link>
        </Button>
      </div>

      {summary ? (
        <>
          <div className="grid gap-6 lg:grid-cols-3">
            <FundAgentPanel
              agentName={name}
              funding={summary.funding}
              trading={trading}
              tradingAction={
                <Button asChild size="sm" variant="secondary" className="self-start">
                  <Link href={`/agents/${agent.id.toString()}/portfolio`}>
                    {trading?.hasAccount ? "Open portfolio" : "Set up trading"}
                  </Link>
                </Button>
              }
            />
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
                empty="No activity yet. Entries appear after each Scan."
              />
            </section>
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <Dialog>
                <DialogTrigger asChild>
                  <Button size="sm" disabled={!canScan?.enabled || scan.state === "working"}>
                    <Sparkles aria-hidden /> Run Scan now
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Run a Scan for {name}?</DialogTitle>
                    <DialogDescription>
                      {name} searches the web, reads the most relevant pages and saves its notes. A
                      Scan costs {scanCostText(summary)} of credits, taken as it runs; if its
                      credits run out, it stops.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="secondary">Cancel</Button>
                    </DialogClose>
                    <DialogClose asChild>
                      <Button onClick={requestScan}>Run Scan</Button>
                    </DialogClose>
                  </DialogFooter>
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
                      <span className="numeric">{summary.ownerEpoch.toString()}</span>): if {name}{" "}
                      changes hands first, it is refused and the credits stay with the agent.
                      Research pauses until it is funded again.
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
            </div>
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
          </div>
        </>
      ) : null}
    </Card>
  );
}

/**
 * My Agents (P1-U9, D-218): every agent the connected wallet owns, with its
 * status, funding, spend, activity and owner actions. 3D stays on /configure.
 */
export function MyAgentsPage({ environment }: { environment: EnvironmentId }) {
  const wallet = useWalletSession();
  const owned = useOwnedAgents(environment);
  const state = myAgentsPageState(wallet, { status: owned.status, count: owned.agents.length });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">My Agents</h1>
        <p className="max-w-2xl text-sm text-foreground-muted">
          Your agents on {wallet.target.name}: what each is doing, how to fund it, what it has spent
          and what it has been researching.
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
        <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading your agents">
          <Skeleton className="h-48 w-full" />
        </div>
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
      ) : (
        <div className="flex flex-col gap-6" data-testid="my-agents">
          {owned.agents.map((a) => (
            <MyAgentCard key={a.id.toString()} agent={a} />
          ))}
        </div>
      )}
    </div>
  );
}
