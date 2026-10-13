"use client";

import { Info, Puzzle, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { SlotHex } from "./slot-hex";

/**
 * UI-FAST: the configure page's skill loadout, editable on screen only. The
 * inventory's cards and the slots are buttons: a card goes into the first
 * free slot and comes out again, a filled slot empties when clicked, and
 * hovering a card lights the slot it would take. Presentational: the app
 * holds which skill sits in which slot and saves nothing yet, which
 * LoadoutUnsavedNote says plainly.
 */

export interface LoadoutSkillView {
  readonly id: string;
  readonly name: string;
  readonly kind: "skill" | "playbook" | "owner";
}

const KIND_WORD = { skill: "Built in", playbook: "Playbook", owner: "Yours" } as const;

/** The inventory as clickable cards; each says where it is or where it would go. */
function SkillInventoryCards({
  skills,
  slotOf,
  nextFreeSlot,
  hovered,
  onToggle,
  onHover,
  className,
}: {
  skills: readonly LoadoutSkillView[];
  /** The slot (0-based) each equipped skill sits in, by id. */
  slotOf: Readonly<Record<string, number>>;
  /** The first free slot, or null when every slot is full. */
  nextFreeSlot: number | null;
  hovered: string | null;
  onToggle: (id: string) => void;
  onHover: (id: string | null) => void;
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-col gap-2", className)} data-testid="skill-inventory">
      {skills.map((s) => {
        const slot = slotOf[s.id];
        const equipped = slot !== undefined;
        const full = !equipped && nextFreeSlot === null;
        const hint = equipped
          ? hovered === s.id
            ? `Take it out of slot ${slot + 1}`
            : `In slot ${slot + 1}`
          : full
            ? "Every slot is full"
            : hovered === s.id
              ? `Goes into slot ${(nextFreeSlot ?? 0) + 1}`
              : "Not equipped";
        return (
          <li key={s.id}>
            <button
              type="button"
              aria-pressed={equipped}
              disabled={full}
              onClick={() => onToggle(s.id)}
              onMouseEnter={() => onHover(s.id)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(s.id)}
              onBlur={() => onHover(null)}
              data-testid="inventory-skill"
              data-skill={s.id}
              className={cn(
                "flex w-full items-center gap-2 rounded-md border bg-surface p-2 text-left transition-colors outline-none",
                "hover:border-primary-muted is-focus:focus-ring disabled:cursor-not-allowed disabled:opacity-50",
                equipped && "border-primary bg-surface-raised",
              )}
            >
              <Puzzle aria-hidden className="size-4 shrink-0 text-foreground-muted" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{s.name}</span>
                <span className="text-2xs text-foreground-muted" data-testid="inventory-hint">
                  {hint}
                </span>
              </span>
              <Badge tone={s.kind === "owner" ? "detail" : "neutral"}>{KIND_WORD[s.kind]}</Badge>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The slots as buttons: a filled one empties when clicked; the hovered card's target lights up. */
function SkillSlotButtons({
  slots,
  highlighted,
  onRemove,
  className,
}: {
  /** One entry per slot: the equipped skill's name, or null when empty. */
  slots: readonly (string | null)[];
  highlighted: number | null;
  onRemove: (slot: number) => void;
  className?: string;
}) {
  return (
    <ul aria-label="Skill slots" className={cn("flex flex-wrap items-center gap-3", className)}>
      {slots.map((name, i) => (
        <li key={i}>
          <button
            type="button"
            disabled={name === null}
            onClick={() => onRemove(i)}
            aria-label={
              name ? `Slot ${i + 1}: ${name}, click to take it out` : `Slot ${i + 1}: empty`
            }
            data-testid="loadout-slot"
            data-filled={name ? "" : undefined}
            className="group flex items-center gap-2 rounded-md p-1 text-left outline-none is-focus:focus-ring enabled:hover:bg-surface-raised disabled:cursor-default"
          >
            <SlotHex
              index={i}
              state={name ? "filled" : highlighted === i ? "highlighted" : "empty"}
              skillName={name ?? undefined}
            />
            <span className="font-mono text-2xs text-foreground-muted">
              Slot {i + 1}
              <br />
              {name ? (
                <span className="flex items-center gap-1 text-foreground">
                  {name}
                  <X aria-hidden className="size-3 opacity-0 group-hover:opacity-100" />
                </span>
              ) : highlighted === i ? (
                "goes here"
              ) : (
                "empty"
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Says that the loadout on screen is not saved anywhere yet. */
function LoadoutUnsavedNote({ className }: { className?: string }) {
  return (
    <p
      className={cn("flex items-start gap-1.5 text-xs text-foreground-muted", className)}
      data-testid="loadout-unsaved"
    >
      <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      Preview only: equipping here is not saved and does not change what your agent runs. Saving
      skill changes comes later.
    </p>
  );
}

export { LoadoutUnsavedNote, SkillInventoryCards, SkillSlotButtons };
