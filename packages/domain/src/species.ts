import type { Tier } from "./tiers.ts";

/**
 * The 34 agent species and their exact supply (D-178, D-179, revised by
 * NFT-U1: 500 base, 300 medium and 200 pro, 1,000 in total). The order is
 * the onchain order: AgentNFT's `speciesOf` returns `index` (1 to 34, 0 while
 * unrevealed), and its species table lists the same names, slugs and counts in
 * the same order (species.test.ts checks the contract source against this).
 * A species' tier is its own field, not a range of indexes: the nine species
 * NFT-U1 added (the owner's Snake, Hummingbird and Fish, then the six the
 * incoming art turned out to hold) are appended after Cicada so every index
 * minted before them keeps its meaning, and AgentNFT reads the tier from a
 * packed table in the same order.
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

const species = (tier: Tier, slug: string, name: string, count: number): Omit<Species, "index"> => ({
  slug,
  name,
  tier,
  count,
});
const base = (slug: string, name: string, count: number) => species("base", slug, name, count);
const medium = (slug: string, name: string, count: number) => species("medium", slug, name, count);
const pro = (slug: string, name: string, count: number) => species("pro", slug, name, count);

/**
 * The counts, as evenly as each tier's supply divides across its species
 * (NFT-U1, A-94): the remainder goes to the tier's first species in onchain
 * order. Base, six species over 500: 84, 84, then 83. Medium, eleven over
 * 300: 28, 28, 28, then 27. Pro: the four one of ones, then 196 over the other
 * thirteen: 16 for the Jumping spider, 15 for the rest.
 */
export const SPECIES: readonly Species[] = [
  base("larva-grub", "Larva grub", 84),
  base("roly-poly", "Roly-poly", 84),
  base("ant", "Ant", 83),
  base("tick", "Tick", 83),
  base("weevil", "Weevil", 83),
  medium("silkworm", "Silkworm", 28),
  medium("ground-beetle", "Ground beetle", 28),
  medium("cricket", "Cricket", 28),
  medium("moth", "Moth", 27),
  medium("firefly", "Firefly", 27),
  medium("centipede", "Centipede", 27),
  medium("water-strider", "Water strider", 27),
  medium("earwig", "Earwig", 27),
  pro("bee", "Bee", 1),
  pro("praying-mantis", "Praying mantis", 1),
  pro("hercules-beetle", "Hercules beetle", 1),
  pro("horseshoe-crab", "Horseshoe crab", 1),
  pro("jumping-spider", "Jumping spider", 16),
  pro("mantis-shrimp", "Mantis shrimp", 15),
  pro("dragonfly", "Dragonfly", 15),
  pro("scorpion", "Scorpion", 15),
  pro("trilobite", "Trilobite", 15),
  pro("stag-beetle", "Stag beetle", 15),
  pro("atlas-moth", "Atlas moth", 15),
  pro("cicada", "Cicada", 15),
  // NFT-U1: the owner's three new pro species.
  pro("snake", "Snake", 15),
  pro("hummingbird", "Hummingbird", 15),
  pro("fish", "Fish", 15),
  // NFT-U1: the six animals the incoming art holds that no listed species
  // names, each in the tier it fits (A-94, for the owner to confirm).
  base("ladybug", "Ladybug", 83),
  medium("grasshopper", "Grasshopper", 27),
  medium("butterfly", "Butterfly", 27),
  medium("leaf-insect", "Leaf insect", 27),
  pro("crab", "Crab", 15),
  pro("orchid-mantis", "Orchid mantis", 15),
].map((s, i) => ({ ...s, index: i + 1 }));

/** Supply per tier (D-178, revised by NFT-U1): 500 base, 300 medium, 200 pro. */
export const TIER_SUPPLY: Readonly<Record<Tier, number>> = { base: 500, medium: 300, pro: 200 };

/** Total agents (D-172). */
export const AGENT_MAX_SUPPLY = 1000;

/** How many agents one wallet may mint (D-183, revised by NFT-U1: two). Holding more is allowed. */
export const MINTS_PER_WALLET = 2;

/** The image placeholder shown before reveal (D-181). */
export const UNREVEALED_IMAGE_SLUG = "unrevealed";

/** The onchain tier number AgentNFT uses: 1 base, 2 medium, 3 pro. */
export const TIER_NUMBER: Readonly<Record<Tier, number>> = { base: 1, medium: 2, pro: 3 };

/**
 * AgentNFT packs the deck as 7 bits per species (a count of at most 127) and
 * the tier table as 2 bits per species, species 1 in the lowest bits; these
 * are the constants the contract must carry (species.test.ts checks them).
 */
export const DECK_BITS_PER_SPECIES = 7;
export function packedDeck(list: readonly Species[] = SPECIES): bigint {
  return list.reduce(
    (acc, s) => acc | (BigInt(s.count) << BigInt(DECK_BITS_PER_SPECIES * (s.index - 1))),
    0n,
  );
}
export function packedTierTable(list: readonly Species[] = SPECIES): bigint {
  return list.reduce(
    (acc, s) => acc | (BigInt(TIER_NUMBER[s.tier]) << BigInt(2 * (s.index - 1))),
    0n,
  );
}

/** The species at an onchain index (1 to 34); throws for 0 (unrevealed) or out of range. */
export function speciesByIndex(index: number): Species {
  const s = SPECIES[index - 1];
  if (!s || index < 1) throw new RangeError(`no species at index ${index}`);
  return s;
}

/** The species with a slug, or undefined. */
export function speciesBySlug(slug: string): Species | undefined {
  return SPECIES.find((s) => s.slug === slug);
}
