"use client";

import { ArrowRight, RotateCcw, Wallet } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { SectionLabel } from "../ui/section-label";
import { Skeleton } from "../ui/skeleton";
import { Tag } from "../ui/tag";
import { cn } from "../../lib/utils";
import { MintButton, type MintButtonProps } from "./mint-button";
import { RevealMoment, type RevealMomentProps } from "./reveal-moment";
import { type ArtTier, SpeciesArt } from "./species-art";

/**
 * The mint column of the mint page (P1-U10): what the connected wallet can
 * do now, from "connect first" to its revealed agent. The mint itself, from
 * the claim to the reveal, is MintButton; this panel adds the states around
 * it. Presentational only: the app decides the state and passes it in.
 */
export const MINT_PANEL_STATES = [
  "unavailable",
  "logged-out",
  "connecting",
  "wrong-network",
  "loading",
  "read-error",
  "not-eligible",
  "ready",
  "already-minted",
  "sold-out",
  "awaiting-reveal",
  "revealed",
] as const;
export type MintPanelState = (typeof MINT_PANEL_STATES)[number];

/** A link component that takes an href, such as Next's Link. */
export type LinkComponent = ComponentType<{ href: string; children?: ReactNode }>;

export interface MintPanelAgent {
  readonly id: bigint;
  /** Null before reveal. */
  readonly tier: ArtTier | null;
  readonly speciesName: string | null;
  readonly image: string | null;
  /** Where this agent is configured, for the agents the wallet minted before. */
  readonly href?: string | undefined;
}

interface MintPanelProps {
  readonly state: MintPanelState;
  /** The mint control, for ready, awaiting-reveal and revealed. */
  readonly mint?: MintButtonProps | undefined;
  /** The agent just minted, for awaiting-reveal and revealed. */
  readonly agent?: MintPanelAgent | undefined;
  /**
   * The agents the wallet minted before (NFT-U1: up to two per wallet), for
   * ready, already-minted and sold-out; each with its own href.
   */
  readonly agents?: readonly MintPanelAgent[] | undefined;
  /** How many mints the wallet has left, for ready; 2 when unknown. */
  readonly mintsLeft?: number | undefined;
  /** Where the agent is configured, for example "/configure?agent=7". */
  readonly agentHref?: string | undefined;
  /** For unavailable and not-eligible: why this wallet cannot mint here. */
  readonly message?: string | undefined;
  /**
   * The link component for the agent link: the app passes its router's Link
   * for client-side navigation; a plain anchor otherwise.
   */
  readonly linkAs?: LinkComponent | undefined;
  /** The network the app needs, and the one the wallet is on, for wrong-network. */
  readonly targetNetwork?: string | undefined;
  readonly walletNetwork?: string | undefined;
  /** The supply cap, formatted, for sold-out. */
  readonly maxSupply?: string | undefined;
  /** An extra line under an unrevealed agent, such as how to reveal on a dev chain. */
  readonly revealNote?: ReactNode;
  /**
   * UI-U2: the reveal moment for the agent just minted (awaiting-reveal and
   * revealed): the countdown while pending, then the result hidden until the
   * owner clicks Reveal. Without it the plain preview shows.
   */
  readonly reveal?:
    | Pick<RevealMomentProps, "speciesIndex" | "secondsLeft" | "seen" | "onSeen" | "durationMs">
    | undefined;
  readonly onConnect?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly className?: string | undefined;
}

const TIER_TAG = { base: "neutral", medium: "rare", pro: "legendary" } as const;
const TIER_NAME = { base: "Base", medium: "Medium", pro: "Pro" } as const;

const TERMS = "Free to mint: you pay only gas. Up to two agents per wallet.";

function AgentPreview({
  agent,
  href,
  revealNote,
  linkAs,
}: {
  agent: MintPanelAgent;
  href: string | undefined;
  revealNote: ReactNode;
  linkAs?: LinkComponent | undefined;
}) {
  const id = agent.id.toString();
  const LinkAs = linkAs ?? "a";
  return (
    <div className="flex flex-col gap-3 rounded-md border bg-surface-raised p-3 sm:flex-row sm:items-center">
      <SpeciesArt
        image={agent.image}
        speciesName={agent.speciesName}
        tier={agent.tier}
        className="w-28 shrink-0 self-center"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="flex items-baseline gap-2 text-base font-semibold">
          Alpha Agent <span className="numeric text-primary">#{id}</span>
        </p>
        {agent.tier ? (
          <span className="flex flex-wrap items-center gap-2">
            <Tag tone={TIER_TAG[agent.tier]} size="md">
              {TIER_NAME[agent.tier]}
            </Tag>
            <span className="text-sm">{agent.speciesName}</span>
          </span>
        ) : (
          <span className="flex flex-col gap-1">
            <span className="text-sm text-foreground-muted">
              Waiting for reveal: its tier and species are drawn then.
            </span>
            {revealNote ? (
              <span className="text-xs text-foreground-muted">{revealNote}</span>
            ) : null}
          </span>
        )}
        {href ? (
          <Button asChild variant="secondary" size="sm" className="w-fit">
            <LinkAs href={href}>
              Open agent #{id} <ArrowRight aria-hidden />
            </LinkAs>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The agents the wallet minted before, each with its link. */
function MintedBefore({
  agents,
  linkAs,
  revealNote,
}: {
  agents: readonly MintPanelAgent[];
  linkAs?: LinkComponent | undefined;
  revealNote: ReactNode;
}) {
  if (agents.length === 0) return null;
  return (
    <ul aria-label="Agents this wallet minted" className="flex flex-col gap-3">
      {agents.map((a) => (
        <li key={a.id.toString()}>
          <AgentPreview agent={a} href={a.href} revealNote={revealNote} linkAs={linkAs} />
        </li>
      ))}
    </ul>
  );
}

function Lead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-base font-semibold">{title}</p>
      {children ? <p className="text-sm text-foreground-muted">{children}</p> : null}
    </div>
  );
}

function MintPanel(props: MintPanelProps) {
  const { state, mint, agent, agentHref, revealNote, linkAs, className } = props;
  const before = props.agents ?? [];
  const mintsLeft = props.mintsLeft ?? 2;
  let body: ReactNode;
  switch (state) {
    case "unavailable":
      body = <Lead title="Minting is not open here">{props.message}</Lead>;
      break;
    case "logged-out":
      body = (
        <>
          <Lead title="Connect your wallet to mint">{TERMS}</Lead>
          {props.onConnect ? (
            <Button variant="primary" className="w-fit" onClick={props.onConnect}>
              <Wallet aria-hidden /> Connect wallet
            </Button>
          ) : null}
        </>
      );
      break;
    case "connecting":
      body = (
        <>
          <Lead title="Connecting your wallet" />
          <Button variant="primary" className="w-fit" loading disabled>
            Connecting
          </Button>
        </>
      );
      break;
    case "wrong-network":
      body = (
        <Lead title={`Switch to ${props.targetNetwork ?? "the app's network"} to mint`}>
          {props.walletNetwork
            ? `Your wallet is on ${props.walletNetwork}. `
            : "Your wallet is on another network. "}
          Nothing is sent until it is on {props.targetNetwork ?? "the app's network"}.
        </Lead>
      );
      break;
    case "loading":
      body = (
        <>
          <Lead title="Checking this wallet's mint" />
          <Skeleton className="h-9 w-40" />
        </>
      );
      break;
    case "read-error":
      body = (
        <>
          <Lead title="Could not read this wallet's mint from the chain." />
          {props.onRetry ? (
            <Button variant="secondary" className="w-fit" onClick={props.onRetry}>
              <RotateCcw aria-hidden /> Try again
            </Button>
          ) : null}
        </>
      );
      break;
    case "not-eligible":
      body = (
        <Lead title="This wallet cannot mint">
          {props.message ?? "This wallet is not yet invited to mint during the beta."} Try another
          wallet, or ask to be added during the beta.
        </Lead>
      );
      break;
    case "sold-out":
      body = (
        <>
          <Lead title="Sold out">
            All {props.maxSupply ?? ""} agents are minted. Agents change hands through the
            marketplace.
          </Lead>
          <MintedBefore agents={before} linkAs={linkAs} revealNote={revealNote} />
        </>
      );
      break;
    case "already-minted":
      body = (
        <>
          <Lead title="This wallet has minted both of its agents">
            Two agents per wallet: this wallet cannot mint again.
          </Lead>
          <MintedBefore
            agents={before.length > 0 ? before : agent ? [agent] : []}
            linkAs={linkAs}
            revealNote={revealNote}
          />
        </>
      );
      break;
    case "ready":
      body = (
        <>
          <Lead title={before.length > 0 ? "Mint your second agent" : "Mint your agent"}>
            {TERMS} Your tier and species are drawn at reveal.
            {before.length > 0
              ? ` This wallet has ${mintsLeft === 1 ? "one mint" : `${mintsLeft} mints`} left.`
              : ""}
          </Lead>
          {mint ? <MintButton {...mint} className={cn("sm:max-w-xs", mint.className)} /> : null}
          <MintedBefore agents={before} linkAs={linkAs} revealNote={revealNote} />
        </>
      );
      break;
    case "awaiting-reveal":
    case "revealed":
      body = (
        <>
          {mint ? <MintButton {...mint} className={cn("sm:max-w-xs", mint.className)} /> : null}
          {agent && props.reveal ? (
            <div className="flex flex-col gap-1">
              <RevealMoment
                agentId={agent.id}
                href={agentHref}
                linkAs={linkAs}
                {...props.reveal}
              />
              {props.reveal.speciesIndex === null && revealNote ? (
                <span className="text-xs text-foreground-muted">{revealNote}</span>
              ) : null}
            </div>
          ) : agent ? (
            <AgentPreview agent={agent} href={agentHref} revealNote={revealNote} linkAs={linkAs} />
          ) : null}
        </>
      );
      break;
  }
  return (
    <Card data-slot="mint-panel" data-state={state} className={cn("gap-4", className)}>
      <SectionLabel as="h2">Your mint</SectionLabel>
      {body}
    </Card>
  );
}

export { MintPanel };
