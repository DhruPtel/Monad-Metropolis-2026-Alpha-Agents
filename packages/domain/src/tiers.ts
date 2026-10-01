import { z } from "zod";

/** Agent tiers and their slot points (FINAL_PLAN 4.1.1: slots 3, 5, 8). */
export const TIERS = {
  base: { slots: 3, rank: 0 },
  medium: { slots: 5, rank: 1 },
  pro: { slots: 8, rank: 2 },
} as const;

export const TIER_IDS = ["base", "medium", "pro"] as const;
export type Tier = (typeof TIER_IDS)[number];
export const TierSchema = z.enum(TIER_IDS);

export function slotsFor(tier: Tier): number {
  return TIERS[tier].slots;
}

/** True when an agent of tier `have` meets a `required` tier. */
export function meetsTier(have: Tier, required: Tier): boolean {
  return TIERS[have].rank >= TIERS[required].rank;
}
