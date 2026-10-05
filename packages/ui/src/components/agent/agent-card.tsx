import type { ReactNode } from "react";
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
