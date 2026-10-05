import { useId } from "react";
import { StatBar } from "../stat-bar";
import { Card } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { Tag } from "../ui/tag";
import { cn } from "../../lib/utils";
import { type ArtTier, SpeciesArt } from "./species-art";

/**
 * One agent tier on the mint page (P1-U10): its slots, its supply, how much
 * is left and the chance a mint lands in it, with every species it holds. The
 * tier is drawn at reveal (D-178), so the card informs and is not a choice.
 * Presentational only: the app reads the numbers from AgentNFT and passes
 * them in, already formatted; `null` shows a loading placeholder.
 */
export interface TierCardSpecies {
  readonly name: string;
  readonly image: string | null;
  /** The species' full supply; 1 marks a one of one. */
  readonly total: number;
  /** Left in the deck, or null while loading. */
  readonly remaining: number | null;
}

interface TierCardProps {
  readonly tier: ArtTier;
  readonly slots: number;
  /** The tier's full supply, formatted, for example "600". */
  readonly total: string;
  /** Left in the deck, formatted; null while loading. */
  readonly remaining: string | null;
  /** Remaining over total in basis points, for the bar. */
  readonly remainingBps: number;
  /** The chance per mint, formatted, for example "60.0%"; null while loading. */
  readonly odds: string | null;
  /** Nothing of this tier is left. */
  readonly soldOut?: boolean;
  readonly species: readonly TierCardSpecies[];
  readonly className?: string;
}

const TIER_TAG = { base: "neutral", medium: "rare", pro: "legendary" } as const;
const TIER_NAME = { base: "Base", medium: "Medium", pro: "Pro" } as const;

const fmt = (n: number) => n.toLocaleString("en-US");

function SpeciesRow({ tier, species }: { tier: ArtTier; species: TierCardSpecies }) {
  const oneOfOne = species.total === 1;
  let left: string | null = null;
  if (species.remaining !== null) {
    if (oneOfOne) left = species.remaining > 0 ? "Not drawn yet" : "Drawn";
    else left = `${fmt(species.remaining)} of ${fmt(species.total)} left`;
  }
  return (
    <li className="flex items-center gap-3" data-one-of-one={oneOfOne ? "" : undefined}>
      <SpeciesArt
        compact
        image={species.image}
        speciesName={species.name}
        tier={tier}
        className="size-9 shrink-0"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-sm">
          {species.name}
          {oneOfOne ? <Tag tone="legendary">1 of 1</Tag> : null}
        </span>
        {left === null ? (
          <Skeleton className="h-3 w-20" />
        ) : (
          <span
            className={cn(
              "numeric text-2xs",
              species.remaining === 0 ? "text-foreground-subtle" : "text-foreground-muted",
            )}
          >
            {left}
          </span>
        )}
      </span>
    </li>
  );
}

function TierCard({
  tier,
  slots,
  total,
  remaining,
  remainingBps,
  odds,
  soldOut = false,
  species,
  className,
}: TierCardProps) {
  const titleId = useId();
  return (
    <Card
      role="region"
      aria-labelledby={titleId}
      data-slot="tier-card"
      data-tier={tier}
      className={cn("gap-4", className)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <h3 id={titleId} className="text-lg font-semibold">
            {TIER_NAME[tier]} tier
          </h3>
          <span className="flex flex-wrap items-center gap-2">
            <Tag tone={TIER_TAG[tier]} size="md">
              {slots} skill slots
            </Tag>
            {soldOut ? (
              <Tag tone="warning" size="md">
                Sold out
              </Tag>
            ) : null}
          </span>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-2xs tracking-label text-foreground-muted uppercase">
            Chance per mint
          </span>
          {odds === null ? (
            <Skeleton className="h-7 w-16" />
          ) : (
            <span className="numeric text-2xl font-semibold" data-testid="tier-odds">
              {odds}
            </span>
          )}
        </div>
      </div>
      {remaining === null ? (
        <Skeleton className="h-8 w-full" />
      ) : (
        <StatBar
          label={`Remaining of ${total}`}
          value={`${remaining} of ${total}`}
          fillBps={remainingBps}
        />
      )}
      <ul aria-label={`${TIER_NAME[tier]} species`} className="flex flex-col gap-2.5">
        {species.map((s) => (
          <SpeciesRow key={s.name} tier={tier} species={s} />
        ))}
      </ul>
    </Card>
  );
}

export { TierCard };
