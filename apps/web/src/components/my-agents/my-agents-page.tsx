"use client";

import { type EnvironmentId, ENVIRONMENTS } from "@alpha-agents/config";
import { slotsFor, speciesAsset, speciesByIndex } from "@alpha-agents/domain";
import {
  AgentCard,
  AgentListCard,
  Button,
  EmptyState,
  PageLoading,
  PendingAgentNotice,
  RevealMoment,
  usdcCents,
} from "@alpha-agents/ui";
import { Bot, PlugZap, RotateCcw, Wallet } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useWalletSession } from "@/auth/session";
import type { AgentView } from "@/agent/chain";
import { myAgentsPageState } from "@/agent/my-agents";
import { useRevealSeen } from "@/agent/reveal-seen";
import { useRevealStatus } from "@/agent/reveal-status";
import { useOwnedAgents } from "@/agent/use-agents";
import { type ActionState, useMyAgent } from "@/agent/use-my-agent";
import { useSkillInventory } from "@/agent/use-skill-inventory";

/** One action's outcome, said once, for screen readers too. */
export function ActionLine({ action, testId }: { action: ActionState; testId: string }) {
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

const GOAL_WORD: Readonly<Record<string, string>> = {
  CONSERVATIVE: "Conservative",
  BALANCED: "Balanced",
  AGGRESSIVE: "Aggressive",
};

/**
 * One owned agent on My Agents (UI-FAST): a card with its art, name, tier,
 * skills, value and goal; the card opens the agent's page, and Set goal sits
 * on it while the agent has none. An agent not yet revealed, or whose reveal
 * the owner has not seen, shows its reveal moment above the card.
 */
function MyAgentItem({ agent, environment }: { agent: AgentView; environment: EnvironmentId }) {
  const id = agent.id.toString();
  const species = agent.species === 0 ? null : speciesByIndex(agent.species);
  const { summary, trading } = useMyAgent(agent.id, { performance: false });
  const skills = useSkillInventory(species ? agent.id : null);
  const { seen, markSeen } = useRevealSeen(environment, agent.id);
  const [revealedNow, setRevealedNow] = useState(false);
  const waitingNote = useRevealStatus(environment, species === null ? agent.id : null);
  const moment = species === null || !seen || revealedNow;
  const shown = species && !moment ? species : null;
  const goal = summary?.goal?.configured
    ? (GOAL_WORD[summary.goal.aggressiveness ?? ""] ?? "Goal set")
    : null;
  const value =
    trading === null || trading.valueUsdcE6 === null
      ? trading?.hasAccount === false
        ? "No account"
        : "–"
      : `${usdcCents(trading.valueUsdcE6)} USDC`;
  return (
    <li className="flex flex-col gap-2" data-testid="my-agent-item" data-agent-id={id}>
      {moment ? (
        <RevealMoment
          agentId={agent.id}
          speciesIndex={species ? agent.species : null}
          waitingNote={waitingNote}
          seen={seen}
          onSeen={() => {
            markSeen();
            setRevealedNow(true);
          }}
          href={`/agents/${id}`}
          linkAs={Link}
        />
      ) : null}
      <AgentListCard
        agent={{
          id,
          name: `Agent #${id}`,
          image: shown ? speciesAsset(agent.species).image : null,
          tier: shown?.tier ?? null,
          speciesName: shown?.name ?? null,
          skills:
            skills.state === "ready"
              ? `${skills.skills.length} ${skills.skills.length === 1 ? "skill" : "skills"}`
              : "– skills",
          value,
          goal,
          href: `/agents/${id}`,
        }}
        setGoal={
          summary ? (
            <Button asChild size="sm" variant="secondary">
              <Link href={`/agents/${id}/goal`}>Set goal</Link>
            </Button>
          ) : undefined
        }
        linkAs={Link}
      />
    </li>
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
        <p className="text-sm text-foreground-muted">Your agents on {wallet.target.name}.</p>
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
          title="The agents this wallet minted are no longer in it"
          description="Each wallet mints up to two agents. Connect the wallet that holds them now to see them here."
        />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="my-agents">
          {owned.agents.map((a) =>
            a.indexed ? (
              <MyAgentItem key={a.id.toString()} agent={a} environment={environment} />
            ) : (
              // Read only from the chain (P2-EC): no platform record yet, so no owner
              // controls; the full card replaces it when the index catches up.
              <li key={a.id.toString()} className="flex flex-col gap-3">
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
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
