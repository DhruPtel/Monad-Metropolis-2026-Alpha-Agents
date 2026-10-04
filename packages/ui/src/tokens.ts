/**
 * The token manifest for the /design page: every semantic token, by name. The
 * values live only in packages/ui/src/styles.css; this file lists names, never values,
 * and a test checks every name here is defined there.
 */
export const COLOR_TOKENS = [
  { name: "background", use: "Page background, graphite" },
  { name: "surface", use: "Cards and panels" },
  { name: "surface-raised", use: "Inputs, raised controls" },
  { name: "surface-overlay", use: "Menus, dialogs, toasts" },
  { name: "foreground", use: "Primary text, off-white" },
  { name: "foreground-muted", use: "Secondary text" },
  { name: "foreground-subtle", use: "Placeholders and codes" },
  { name: "border", use: "Dividers and card edges" },
  { name: "border-strong", use: "Control edges" },
  { name: "primary", use: "Primary actions and active states, lime" },
  { name: "primary-muted", use: "Outlines of secondary lime actions, dim lime" },
  { name: "positive", use: "Positive values, lime" },
  { name: "negative", use: "Losses and errors only, muted red" },
  { name: "negative-surface", use: "Background behind an error" },
  { name: "detail", use: "Secondary detail and Legendary rarity, brass" },
  { name: "warning", use: "Stale data, awaiting approval, load failures, amber" },
  { name: "rare", use: "Rare rarity, steel" },
  { name: "viewer-glow", use: "Centre of the 3D viewer background" },
] as const;

export const TYPE_SCALE = [
  { name: "3xl", className: "text-3xl", sample: "Agent profile" },
  { name: "2xl", className: "text-2xl", sample: "Section title" },
  { name: "xl", className: "text-xl", sample: "Panel title" },
  { name: "lg", className: "text-lg", sample: "Dialog title" },
  { name: "base", className: "text-base", sample: "Card titles and lead text" },
  { name: "sm", className: "text-sm", sample: "Body text, controls and tables (13px)" },
  { name: "xs", className: "text-xs", sample: "Captions, badges and codes" },
  { name: "2xs", className: "text-2xs", sample: "Section labels, chips and tags" },
] as const;

/** Spacing utilities are multiples of --space-unit (0.25rem). */
export const SPACING_SCALE = [
  { step: "1", className: "w-1" },
  { step: "2", className: "w-2" },
  { step: "3", className: "w-3" },
  { step: "4", className: "w-4" },
  { step: "6", className: "w-6" },
  { step: "8", className: "w-8" },
  { step: "12", className: "w-12" },
  { step: "16", className: "w-16" },
  { step: "24", className: "w-24" },
] as const;

export const RADIUS_SCALE = [
  { name: "xs", className: "rounded-xs" },
  { name: "sm", className: "rounded-sm" },
  { name: "md", className: "rounded-md" },
  { name: "lg", className: "rounded-lg" },
  { name: "xl", className: "rounded-xl" },
  { name: "full", className: "rounded-full" },
] as const;

/** Cards are flat (`raised` is none); shadows are for floating things and selection. */
export const SHADOW_SCALE = [
  { name: "raised", className: "shadow-raised" },
  { name: "overlay", className: "shadow-overlay" },
  { name: "panel", className: "shadow-panel" },
  { name: "glow", className: "shadow-glow" },
  { name: "selected", className: "shadow-selected" },
] as const;

/** Motion: transitions default to the fast duration and snap easing; animations stop under reduced motion. */
export const MOTION_TOKENS = [
  { name: "motion-fast", use: "Default transition, 140ms" },
  { name: "motion-medium", use: "Panels and layout, 180ms" },
  { name: "motion-ease", use: "Snap easing for every transition" },
] as const;
