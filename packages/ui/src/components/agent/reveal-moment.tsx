"use client";

import { AGENT_MAX_SUPPLY, TIER_SUPPLY, speciesAsset, speciesByIndex } from "@alpha-agents/domain";
import { ArrowRight, Sparkles } from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tag } from "../ui/tag";
import { type ArtTier, SpeciesArt } from "./species-art";

/**
 * The reveal moment (UI-U2). The onchain reveal stays automatic and fair:
 * the keeper draws the tier and species from what is left, and nothing here
 * can change the draw. What changes is when the owner sees it. While the
 * reveal is pending, the pre-reveal placeholder counts down the time the
 * keeper usually takes. Once the chain has drawn, the result stays hidden
 * until the owner clicks Reveal, which plays a rare-pull moment with the real
 * art: the placeholder shakes, the art bursts in with the tier's rays, and
 * the rarity is said plainly, with a one-of-one marked as the only one.
 * Reduced motion skips the animation. Presentational: the app says whether
 * the owner has seen the reveal, and stores that when the moment ends.
 */
export type RevealPhase = "waiting" | "ready" | "shaking" | "bursting" | "revealed";

/** A link component that takes an href, such as Next's Link. */
type LinkComponent = ComponentType<{ href: string; children?: ReactNode }>;

export interface RevealMomentProps {
  readonly agentId: bigint;
  /** The species the chain drew (1 to 34), or null while the reveal is pending. */
  readonly speciesIndex: number | null;
  /** Seconds until the keeper is expected to reveal, while pending; null when unknown. */
  readonly secondsLeft?: number | null | undefined;
  /** Whether the owner has already seen this agent's reveal. */
  readonly seen: boolean;
  /** Called when the moment ends: the app remembers the reveal as seen. */
  readonly onSeen: () => void;
  /** Where the agent is configured, shown once revealed. */
  readonly href?: string | undefined;
  readonly linkAs?: LinkComponent | undefined;
  /** How long the moment plays before the result stands; tests shorten it. */
  readonly durationMs?: number | undefined;
  readonly className?: string | undefined;
}

export const REVEAL_MOMENT_MS = 1_600;

const TIER_NAME: Readonly<Record<ArtTier, string>> = { base: "Base", medium: "Medium", pro: "Pro" };
const TIER_TONE = { base: "neutral", medium: "rare", pro: "legendary" } as const;
const TIER_RAYS: Readonly<Record<ArtTier, string>> = {
  base: "reveal-rays-base",
  medium: "reveal-rays-medium",
  pro: "reveal-rays-pro",
};
const TIER_RING: Readonly<Record<ArtTier, string>> = {
  base: "ring-border-strong",
  medium: "ring-rare/70",
  pro: "ring-detail/80",
};

/** The words for the time left: whole seconds at first, then any moment. */
export function countdownWords(secondsLeft: number | null | undefined): string {
  if (secondsLeft === null || secondsLeft === undefined) return "The keeper reveals it soon.";
  const s = Math.max(0, Math.ceil(secondsLeft));
  if (s === 0) return "Any moment now.";
  return `About ${s} second${s === 1 ? "" : "s"} to go.`;
}

/** What a draw means, in plain words: the tier's share and the species' count. */
export function rarityWords(speciesIndex: number): {
  readonly tier: ArtTier;
  readonly name: string;
  readonly oneOfOne: boolean;
  readonly tierLine: string;
  readonly speciesLine: string;
} {
  const s = speciesByIndex(speciesIndex);
  const share = Math.round((TIER_SUPPLY[s.tier] / AGENT_MAX_SUPPLY) * 100);
  return {
    tier: s.tier,
    name: s.name,
    oneOfOne: s.count === 1,
    tierLine: `${TIER_NAME[s.tier]}: ${TIER_SUPPLY[s.tier]} of ${AGENT_MAX_SUPPLY.toLocaleString("en-US")} agents (${share}%)`,
    speciesLine:
      s.count === 1
        ? "One of one: no other agent will ever be this species."
        : `One of ${s.count} ${s.name.toLowerCase()} agents in the whole supply.`,
  };
}

const reducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function RevealMoment({
  agentId,
  speciesIndex,
  secondsLeft,
  seen,
  onSeen,
  href,
  linkAs,
  durationMs = REVEAL_MOMENT_MS,
  className,
}: RevealMomentProps) {
  const [playing, setPlaying] = useState<"shaking" | "bursting" | null>(null);
  const timers = useRef<number[]>([]);
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;
  useEffect(
    () => () => {
      for (const t of timers.current) window.clearTimeout(t);
    },
    [],
  );
  const id = agentId.toString();
  const LinkAs = linkAs ?? "a";
  const species = speciesIndex && speciesIndex > 0 ? speciesIndex : null;
  const phase: RevealPhase =
    species === null ? "waiting" : playing ? playing : seen ? "revealed" : "ready";

  const reveal = () => {
    if (species === null || playing) return;
    if (reducedMotion() || durationMs <= 0) {
      onSeenRef.current();
      return;
    }
    setPlaying("shaking");
    const shake = Math.round(durationMs * 0.35);
    timers.current.push(
      window.setTimeout(() => setPlaying("bursting"), shake),
      window.setTimeout(() => {
        setPlaying(null);
        onSeenRef.current();
      }, durationMs),
    );
  };

  const rarity = species ? rarityWords(species) : null;
  const art = species ? speciesAsset(species) : null;
  const showArt = phase === "bursting" || phase === "revealed";
  const open =
    href && (phase === "waiting" || phase === "ready" || phase === "revealed") ? (
      <Button asChild variant="secondary" size="sm" className="w-fit">
        <LinkAs href={href}>
          Open agent #{id} <ArrowRight aria-hidden />
        </LinkAs>
      </Button>
    ) : null;
  return (
    <div
      data-slot="reveal-moment"
      data-phase={phase}
      className={cn(
        "flex flex-col gap-3 rounded-md border bg-surface-raised p-3 sm:flex-row sm:items-center",
        className,
      )}
    >
      <div className="relative w-36 shrink-0 self-center">
        {showArt && rarity ? (
          <span
            aria-hidden
            data-testid="reveal-rays"
            className={cn(
              "reveal-rays pointer-events-none absolute -inset-6 rounded-full blur-md",
              TIER_RAYS[rarity.tier],
              phase === "bursting" ? "motion-safe:animate-reveal-rays" : "opacity-40",
              rarity.oneOfOne && phase === "revealed" ? "motion-safe:animate-reveal-rays" : "",
            )}
          />
        ) : null}
        <div
          className={cn(
            "relative rounded-md",
            phase === "ready" ? "ring-2 ring-primary motion-safe:animate-status-pulse" : "",
            phase === "shaking" ? "motion-safe:animate-reveal-shake" : "",
            phase === "bursting" ? "motion-safe:animate-reveal-pop" : "",
            showArt && rarity ? ["ring-2", TIER_RING[rarity.tier]] : "",
          )}
        >
          {showArt && art && rarity ? (
            <SpeciesArt image={art.image} speciesName={rarity.name} tier={rarity.tier} />
          ) : (
            <SpeciesArt image={null} speciesName={null} tier={null} />
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="flex items-baseline gap-2 text-base font-semibold">
          Alpha Agent <span className="numeric text-primary">#{id}</span>
        </p>
        {phase === "waiting" ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm">Waiting for its reveal.</p>
            <p className="text-sm text-foreground-muted" aria-live="polite">
              <span data-countdown>{countdownWords(secondsLeft)}</span> Its tier and species are
              drawn onchain from what is left; nothing here can change the draw.
            </p>
            {open}
          </div>
        ) : null}
        {phase === "ready" ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm">The chain has drawn its tier and species. Ready when you are.</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" className="w-fit" onClick={reveal} data-testid="reveal">
                <Sparkles aria-hidden /> Reveal
              </Button>
              {open}
            </div>
          </div>
        ) : null}
        {phase === "shaking" || phase === "bursting" ? (
          <p className="text-sm text-foreground-muted" role="status">
            Revealing…
          </p>
        ) : null}
        {phase === "revealed" && rarity ? (
          <div className="flex flex-col gap-2" data-testid="reveal-result">
            <span className="flex flex-wrap items-center gap-2">
              <Tag tone={TIER_TONE[rarity.tier]} size="md">
                {TIER_NAME[rarity.tier]}
              </Tag>
              <span className="text-base font-semibold">{rarity.name}</span>
              {rarity.oneOfOne ? (
                <Tag tone="legendary" size="md" data-testid="one-of-one">
                  <Sparkles aria-hidden className="size-3" /> 1 of 1
                </Tag>
              ) : null}
            </span>
            <p
              className={cn(
                "text-sm",
                rarity.oneOfOne ? "font-medium text-detail" : "text-foreground-muted",
              )}
            >
              {rarity.speciesLine}
            </p>
            <p className="text-xs text-foreground-muted">{rarity.tierLine}</p>
            {open}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export { RevealMoment };
