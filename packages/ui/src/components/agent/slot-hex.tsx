import { cn } from "../../lib/utils";

/**
 * A skill slot marker: the prototype's hexagon (P1-U11). The 3D viewer anchors
 * one to each named socket on the model so it follows the model; without a
 * model they sit on the 2D image. Empty slots pulse softly; a highlighted slot
 * brightens; a filled slot shows its skill's label.
 */
export const SLOT_STATES = ["empty", "highlighted", "filled"] as const;
export type SlotState = (typeof SLOT_STATES)[number];

interface SlotHexProps {
  /** Zero-based slot index; the label reads "Slot 1" for index 0. */
  readonly index: number;
  readonly state: SlotState;
  /** The equipped skill's name, for a filled slot. */
  readonly skillName?: string | undefined;
  readonly className?: string | undefined;
}

/** The hexagon outline, pointy-top, inscribed in a 44 by 44 box. */
const HEX_POINTS = Array.from({ length: 6 }, (_, i) => {
  const a = (Math.PI / 180) * (90 + i * 60);
  return `${(22 + 20 * Math.cos(a)).toFixed(2)},${(22 - 20 * Math.sin(a)).toFixed(2)}`;
}).join(" ");

function SlotHex({ index, state, skillName, className }: SlotHexProps) {
  const label =
    state === "filled" && skillName
      ? `Slot ${index + 1}: ${skillName}`
      : `Slot ${index + 1}: empty`;
  return (
    <span
      role="img"
      aria-label={label}
      data-slot="slot-hex"
      data-state={state}
      className={cn("relative inline-flex size-11 shrink-0 items-center justify-center", className)}
    >
      <svg
        viewBox="0 0 44 44"
        aria-hidden
        className={cn(
          "absolute inset-0 size-full transition-transform",
          state === "empty" && "animate-slot-pulse",
          state === "highlighted" && "scale-110 drop-shadow-glow",
        )}
      >
        <polygon
          points={HEX_POINTS}
          strokeLinejoin="round"
          className={cn(
            state === "filled" && "fill-surface-raised stroke-primary-muted stroke-[1.25]",
            state === "highlighted" && "fill-primary/10 stroke-primary stroke-[1.5]",
            state === "empty" && "fill-background/40 stroke-primary-muted stroke-[1.25]",
          )}
        />
        {state !== "filled" && <circle cx="22" cy="22" r="1.6" className="fill-primary-muted" />}
      </svg>
      {state === "filled" && skillName ? (
        <span className="relative font-mono text-2xs text-foreground">
          {skillName.slice(0, 2).toUpperCase()}
        </span>
      ) : null}
    </span>
  );
}

export { SlotHex };
