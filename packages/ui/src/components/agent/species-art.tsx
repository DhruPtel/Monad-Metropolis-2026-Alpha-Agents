import { cn } from "../../lib/utils";
import { SlotHex } from "./slot-hex";

/**
 * An agent's 2D art (P1-U11): the species image, or a placeholder styled by
 * tier when the species has no art yet, or the unrevealed placeholder before
 * reveal. With `slots`, the skill slots sit on the art, which is how a species
 * without a 3D model shows them (D-188). A placeholder with slots moves its
 * label and note into a caption below the art, so a slot never covers text,
 * however small the art is drawn.
 */
export type ArtTier = "base" | "medium" | "pro";

interface SpeciesArtProps {
  /** Image URL, or null to show the placeholder. */
  readonly image: string | null;
  /** The species name; null before reveal. */
  readonly speciesName: string | null;
  /** The tier; null before reveal. */
  readonly tier: ArtTier | null;
  /** Slot markers to place on the art (the tier's slot count), or 0 for none. */
  readonly slots?: number;
  /**
   * A thumbnail beside the species name (the mint page's tier cards): the
   * placeholder shows only its outline, and the art is hidden from screen
   * readers, since the name next to it says the same. Takes no slots.
   */
  readonly compact?: boolean;
  readonly className?: string;
}

const TIER_FRAME: Readonly<Record<ArtTier, string>> = {
  base: "border-border-strong",
  medium: "border-rare/60",
  pro: "border-detail/60",
};

const TIER_TEXT: Readonly<Record<ArtTier, string>> = {
  base: "text-foreground-muted",
  medium: "text-rare",
  pro: "text-detail",
};

const TIER_LABEL: Readonly<Record<ArtTier, string>> = {
  base: "Base",
  medium: "Medium",
  pro: "Pro",
};

/** Slot positions on the art, as percentages: evenly round an ellipse, slot 1 at the top. */
export function slotPositionsOnArt(count: number): { left: string; top: string }[] {
  return Array.from({ length: count }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(count, 1);
    return {
      left: `${(50 + 40 * Math.cos(a)).toFixed(2)}%`,
      top: `${(50 + 40 * Math.sin(a)).toFixed(2)}%`,
    };
  });
}

/** The placeholder's words: the tier and species (or "Unrevealed") and the note. */
function PlaceholderText({
  tier,
  speciesName,
}: {
  tier: ArtTier | null;
  speciesName: string | null;
}) {
  return (
    <>
      <span className="font-mono text-2xs tracking-label uppercase">
        {tier ? `${TIER_LABEL[tier]} · ${speciesName ?? ""}` : "Unrevealed"}
      </span>
      {tier ? <span className="text-2xs text-foreground-subtle">Art coming soon</span> : null}
    </>
  );
}

function Placeholder({
  tier,
  speciesName,
  withText,
  compact = false,
}: {
  tier: ArtTier | null;
  speciesName: string | null;
  withText: boolean;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex size-full flex-col items-center justify-center gap-2 border bg-surface",
        compact ? "rounded-sm" : "rounded-md",
        tier
          ? [TIER_FRAME[tier], TIER_TEXT[tier]]
          : "border-dashed border-primary-muted text-primary",
      )}
    >
      <svg
        viewBox="0 0 44 44"
        aria-hidden
        className={cn("opacity-80", compact ? "size-1/2" : "size-16")}
      >
        <polygon
          points="22,2 39.32,12 39.32,32 22,42 4.68,32 4.68,12"
          className="fill-none stroke-current stroke-[1.25]"
        />
        {tier ? null : (
          <text x="22" y="27" textAnchor="middle" className="fill-current font-mono text-sm">
            ?
          </text>
        )}
      </svg>
      {withText ? <PlaceholderText tier={tier} speciesName={speciesName} /> : null}
    </div>
  );
}

function SpeciesArt({
  image,
  speciesName,
  tier,
  slots = 0,
  compact = false,
  className,
}: SpeciesArtProps) {
  if (compact) {
    return (
      <div
        data-slot="species-art"
        data-compact=""
        aria-hidden
        className={cn("aspect-square", className)}
      >
        {image ? (
          <img src={image} alt="" className="size-full rounded-sm object-cover" />
        ) : (
          <Placeholder tier={tier} speciesName={speciesName} withText={false} compact />
        )}
      </div>
    );
  }
  const alt = speciesName ? `${speciesName} agent` : "Unrevealed agent";
  const caption = !image && slots > 0;
  return (
    <div data-slot="species-art" className={cn("flex w-full flex-col gap-2", className)}>
      <div className="relative aspect-square w-full">
        {image ? (
          // A plain img: the art is a small static file served by the app.
          <img src={image} alt={alt} className="size-full rounded-md object-cover" />
        ) : (
          <div role="img" aria-label={alt} className="size-full">
            <Placeholder tier={tier} speciesName={speciesName} withText={!caption} />
          </div>
        )}
        {slots > 0 ? (
          <ul aria-label="Skill slots" className="absolute inset-0">
            {slotPositionsOnArt(slots).map((pos, i) => (
              <li
                key={i}
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{ left: pos.left, top: pos.top }}
              >
                <SlotHex index={i} state="empty" />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {caption ? (
        <p
          className={cn(
            "flex flex-col items-center gap-1 text-center",
            tier ? TIER_TEXT[tier] : "text-primary",
          )}
        >
          <PlaceholderText tier={tier} speciesName={speciesName} />
        </p>
      ) : null}
    </div>
  );
}

export { SpeciesArt };
