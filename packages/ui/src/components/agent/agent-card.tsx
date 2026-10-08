import type { ReactNode } from "react";
import { Hourglass } from "lucide-react";
import { AddressDisplay } from "../address-display";
import { Card } from "../ui/card";
import { SectionLabel } from "../ui/section-label";
import { Tag } from "../ui/tag";
import { cn } from "../../lib/utils";
import { type ArtTier, SpeciesArt } from "./species-art";

/**
 * An agent NFT as a card (P1-U11): token ID, tier, species, its art or the
 * placeholder before reveal, its token-bound account and its owner, labeled
 * with the environment it lives in. Every value comes from the chain.
 */
interface AgentCardProps {
  readonly agentId: bigint;
  /** Null before reveal. */
  readonly tier: ArtTier | null;
  readonly speciesName: string | null;
  readonly image: string | null;
  readonly slots: number;
  readonly tba: string;
  readonly owner: string;
  readonly ownerEpoch: bigint;
  /** For example "local fork" or "testnet". */
  readonly environment: string;
  readonly className?: string;
}

const TIER_TAG = { base: "neutral", medium: "rare", pro: "legendary" } as const;
const TIER_NAME = { base: "Base", medium: "Medium", pro: "Pro" } as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <dt className="text-foreground-muted">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function AgentCard({
  agentId,
  tier,
  speciesName,
  image,
  slots,
  tba,
  owner,
  ownerEpoch,
  environment,
  className,
}: AgentCardProps) {
  return (
    <Card data-slot="agent-card" className={cn("gap-3 p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-baseline gap-2 text-base font-semibold">
          Alpha Agent <span className="numeric text-primary">#{agentId.toString()}</span>
        </h3>
        <Tag tone="neutral" size="sm">
          {environment}
        </Tag>
      </div>
      <SpeciesArt
        image={image}
        speciesName={speciesName}
        tier={tier}
        className="max-w-48 self-center"
      />
      <dl className="flex flex-col gap-2">
        <Row label="Tier">
          {tier ? (
            <Tag tone={TIER_TAG[tier]} size="md">
              {TIER_NAME[tier]}
            </Tag>
          ) : (
            <span className="text-foreground-subtle">Unrevealed</span>
          )}
        </Row>
        <Row label="Species">
          {speciesName ? (
            <span>{speciesName}</span>
          ) : (
            <span className="text-foreground-subtle">Unrevealed</span>
          )}
        </Row>
        <Row label="Skill slots">
          <span className="numeric">{tier ? slots : "after reveal"}</span>
        </Row>
        <Row label="Ownership epoch">
          <span className="numeric">{ownerEpoch.toString()}</span>
        </Row>
      </dl>
      <div className="flex flex-col gap-1.5">
        <SectionLabel as="h4">Token-bound account</SectionLabel>
        <AddressDisplay
          address={tba}
          label={`Token-bound account of agent ${agentId.toString()}`}
        />
        <SectionLabel as="h4">Owner</SectionLabel>
        <AddressDisplay address={owner} label={`Owner of agent ${agentId.toString()}`} />
      </div>
    </Card>
  );
}

export { AgentCard };

/** Why an agent shows as pending: the index has not caught up, or the reveal has not come. */
export type PendingAgentStage = "indexing" | "reveal";

const PENDING_TEXT: Readonly<Record<PendingAgentStage, { title: string; detail: string }>> = {
  indexing: {
    title: "Indexing your agent…",
    detail:
      "It is minted and in your wallet on chain. The platform's index has not caught up yet; this page updates when it does.",
  },
  reveal: {
    title: "Waiting for reveal…",
    detail:
      "It is minted. Its species comes from Pyth Entropy's randomness, usually within about a minute.",
  },
};

/**
 * An agent the wallet holds on chain that the platform cannot show in full
 * yet (P2-EC): not yet in the index, or not yet revealed. Never a mint prompt.
 */
export function PendingAgentNotice({
  agentId,
  stage,
  className,
}: {
  readonly agentId: bigint;
  readonly stage: PendingAgentStage;
  readonly className?: string;
}) {
  const text = PENDING_TEXT[stage];
  return (
    <div
      role="status"
      data-testid={`pending-agent-${stage}`}
      className={cn("flex items-start gap-3 rounded-lg border bg-surface p-4", className)}
    >
      <Hourglass aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground-muted" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-medium">
          Agent <span className="numeric">#{agentId.toString()}</span>: {text.title}
        </p>
        <p className="text-xs text-foreground-muted">{text.detail}</p>
      </div>
    </div>
  );
}
