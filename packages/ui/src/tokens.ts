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
  { name: "positive", use: "Positive values, lime" },
  { name: "negative", use: "Losses and errors only, muted red" },
  { name: "negative-surface", use: "Background behind an error" },
  { name: "detail", use: "Secondary detail, brass" },
] as const;

export const TYPE_SCALE = [
  { name: "3xl", className: "text-3xl", sample: "Agent profile" },
  { name: "2xl", className: "text-2xl", sample: "Section title" },
  { name: "xl", className: "text-xl", sample: "Panel title" },
  { name: "lg", className: "text-lg", sample: "Dialog title" },
  { name: "base", className: "text-base", sample: "Body text and card titles" },
  { name: "sm", className: "text-sm", sample: "Controls, tables and descriptions" },
  { name: "xs", className: "text-xs", sample: "Captions, badges and codes" },
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
  { name: "sm", className: "rounded-sm" },
  { name: "md", className: "rounded-md" },
  { name: "lg", className: "rounded-lg" },
  { name: "xl", className: "rounded-xl" },
  { name: "full", className: "rounded-full" },
] as const;

export const SHADOW_SCALE = [
  { name: "raised", className: "shadow-raised" },
  { name: "overlay", className: "shadow-overlay" },
  { name: "glow", className: "shadow-glow" },
] as const;
