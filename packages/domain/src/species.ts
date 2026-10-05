import type { Tier } from "./tiers.ts";

/**
 * The 25 agent species and their exact supply (D-178, D-179). The order is
 * the onchain order: AgentNFT's `speciesOf` returns `index` (1 to 25, 0 while
 * unrevealed), and its species table lists the same names, slugs and counts in
 * the same order (species.test.ts checks the contract source against this).
 *
 * `slug` names the image file: `<imageBaseURI><slug>.png`, with
 * `unrevealed.png` as the placeholder before reveal (D-181). 3D models are
 * mapped from the slug by the app's asset manifest, never onchain (D-182).
 */
export interface Species {
  readonly index: number;
  readonly slug: string;
  readonly name: string;
  readonly tier: Tier;
  readonly count: number;
}

const base = (slug: string, name: string): Omit<Species, "index"> => ({
  slug,
  name,
  tier: "base",
  count: 120,
});
const medium = (slug: string, name: string, count: number): Omit<Species, "index"> => ({
  slug,
  name,
  tier: "medium",
  count,
});
const pro = (slug: string, name: string, count: number): Omit<Species, "index"> => ({
  slug,
  name,
  tier: "pro",
  count,
});

export const SPECIES: readonly Species[] = [
  base("larva-grub", "Larva grub"),
  base("roly-poly", "Roly-poly"),
  base("ant", "Ant"),
  base("tick", "Tick"),
  base("weevil", "Weevil"),
  medium("silkworm", "Silkworm", 38),
  medium("ground-beetle", "Ground beetle", 38),
  medium("cricket", "Cricket", 38),
  medium("moth", "Moth", 38),
  medium("firefly", "Firefly", 37),
  medium("centipede", "Centipede", 37),
  medium("water-strider", "Water strider", 37),
  medium("earwig", "Earwig", 37),
  pro("bee", "Bee", 1),
  pro("praying-mantis", "Praying mantis", 1),
  pro("hercules-beetle", "Hercules beetle", 1),
  pro("horseshoe-crab", "Horseshoe crab", 1),
  pro("jumping-spider", "Jumping spider", 12),
  pro("mantis-shrimp", "Mantis shrimp", 12),
  pro("dragonfly", "Dragonfly", 12),
  pro("scorpion", "Scorpion", 12),
  pro("trilobite", "Trilobite", 12),
  pro("stag-beetle", "Stag beetle", 12),
  pro("atlas-moth", "Atlas moth", 12),
  pro("cicada", "Cicada", 12),
].map((s, i) => ({ ...s, index: i + 1 }));

/** Supply per tier (D-178): 600 base, 300 medium, 100 pro. */
export const TIER_SUPPLY: Readonly<Record<Tier, number>> = { base: 600, medium: 300, pro: 100 };

/** Total agents (D-172). */
export const AGENT_MAX_SUPPLY = 1000;

/** The image placeholder shown before reveal (D-181). */
export const UNREVEALED_IMAGE_SLUG = "unrevealed";

/** The species at an onchain index (1 to 25); throws for 0 (unrevealed) or out of range. */
export function speciesByIndex(index: number): Species {
  const s = SPECIES[index - 1];
  if (!s || index < 1) throw new RangeError(`no species at index ${index}`);
  return s;
}
