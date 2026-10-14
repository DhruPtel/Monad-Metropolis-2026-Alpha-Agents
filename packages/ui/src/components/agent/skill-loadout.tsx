"use client";

import { BadgeCheck, Info, Puzzle, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tag } from "../ui/tag";
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

/** 2026-10-13: what a skill is for, by its manifest type. */
export type SkillCategory = "Research" | "Strategy" | "Execution" | "Protocol";
export const SKILL_CATEGORIES: readonly SkillCategory[] = [
  "Research",
  "Strategy",
  "Execution",
  "Protocol",
];

/** One skill as the catalog card shows it, from the skill's real record. */
export interface SkillCardView {
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  /** A built-in or verified publisher, shown with a check. */
  readonly verified: boolean;
  readonly category: SkillCategory;
  readonly description: string;
  readonly version: string;
  /** The tools and data it reads, in plain names. */
  readonly tools: readonly string[];
  /** The research stage that uses it, or null when any stage may load it. */
  readonly stage: string | null;
}

const CATEGORY_EDGE: Readonly<Record<SkillCategory, string>> = {
  Research: "border-l-primary",
  Strategy: "border-l-detail",
  Execution: "border-l-warning",
  Protocol: "border-l-positive",
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

/**
 * The skill inventory as catalog cards (2026-10-13): the publisher's mark and name (checked
 * when built in or verified), the skill's name, its category, a short description, Free, and
 * Equipped when it sits in a slot; a colored left edge by category and filter chips on top.
 */
function SkillCatalog({
  skills,
  slotOf,
  selected,
  onSelect,
  className,
}: {
  skills: readonly SkillCardView[];
  slotOf: Readonly<Record<string, number>>;
  selected: string | null;
  onSelect: (id: string) => void;
  className?: string;
}) {
  const [filter, setFilter] = useState<SkillCategory | "All">("All");
  const shown = filter === "All" ? skills : skills.filter((s) => s.category === filter);
  return (
    <div className={cn("flex flex-col gap-3", className)} data-testid="skill-catalog">
      <div role="group" aria-label="Filter skills" className="flex flex-wrap gap-1">
        {(["All", ...SKILL_CATEGORIES] as const).map((c) => (
          <Button
            key={c}
            size="sm"
            variant="secondary"
            aria-pressed={filter === c}
            onClick={() => setFilter(c)}
            data-testid={`skill-filter-${c}`}
          >
            {c}
          </Button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-foreground-muted">No skills in this category.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((s) => {
            const slot = slotOf[s.id];
            return (
              <li key={s.id}>
                <button
                  type="button"
                  aria-pressed={selected === s.id}
                  onClick={() => onSelect(s.id)}
                  data-testid="skill-card"
                  data-skill={s.id}
                  data-category={s.category}
                  className={cn(
                    "flex w-full flex-col gap-1.5 rounded-md border border-l-4 bg-surface p-3 text-left outline-none transition-colors",
                    "hover:border-primary-muted is-focus:focus-ring",
                    CATEGORY_EDGE[s.category],
                    selected === s.id && "bg-surface-raised",
                  )}
                >
                  <span className="flex items-center gap-2 text-xs">
                    <span
                      aria-hidden
                      className="flex size-5 items-center justify-center rounded-full bg-surface-overlay text-2xs font-semibold"
                    >
                      {initials(s.publisher)}
                    </span>
                    <span className="text-foreground-muted">{s.publisher}</span>
                    {s.verified ? (
                      <BadgeCheck
                        aria-label="Verified publisher"
                        className="size-3.5 text-primary"
                      />
                    ) : null}
                    {slot !== undefined ? (
                      <Badge tone="positive" className="ml-auto">
                        Equipped
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-sm font-semibold">{s.name}</span>
                  <span className="line-clamp-2 text-xs text-foreground-muted">
                    {s.description}
                  </span>
                  <span className="flex items-center gap-2 text-xs">
                    <Tag>{s.category}</Tag>
                    <span className="ml-auto font-medium">Free</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** One skill in full, opened from its card: what it does, where and with what, and Equip. */
function SkillDetailPanel({
  skill,
  equippedSlot,
  canEquip,
  onToggle,
  onClose,
  note,
  className,
}: {
  skill: SkillCardView;
  equippedSlot: number | null;
  /** False when every slot is full and the skill is not in one. */
  canEquip: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** The preview note: the loadout is not saved yet. */
  note?: ReactNode;
  className?: string;
}) {
  return (
    <aside
      aria-label={skill.name}
      className={cn("flex flex-col gap-3 rounded-md border bg-surface p-4", className)}
      data-testid="skill-detail"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold">{skill.name}</h3>
          <span className="flex items-center gap-1 text-xs text-foreground-muted">
            {skill.publisher}
            {skill.verified ? (
              <BadgeCheck aria-label="Verified publisher" className="size-3.5 text-primary" />
            ) : null}
            · version {skill.version}
          </span>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="text-sm">{skill.description}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-foreground-muted">Category</dt>
        <dd>{skill.category}</dd>
        <dt className="text-foreground-muted">Used in</dt>
        <dd>{skill.stage ?? "Any research stage that loads it"}</dd>
        <dt className="text-foreground-muted">Reads</dt>
        <dd>{skill.tools.length > 0 ? skill.tools.join(", ") : "No tools of its own"}</dd>
      </dl>
      <Button
        size="sm"
        className="w-fit"
        variant={equippedSlot === null ? "primary" : "secondary"}
        disabled={equippedSlot === null && !canEquip}
        onClick={onToggle}
        data-testid="skill-detail-toggle"
      >
        {equippedSlot === null
          ? canEquip
            ? "Equip"
            : "Every slot is full"
          : `Unequip from slot ${equippedSlot + 1}`}
      </Button>
      {note}
    </aside>
  );
}

export {
  SkillCatalog,
  SkillDetailPanel,
  LoadoutUnsavedNote,
  SkillInventoryCards,
  SkillSlotButtons,
};
