import { CATALOG_SPECIES } from "./species-assets.ts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_MAX_SUPPLY,
  DECK_BITS_PER_SPECIES,
  MINTS_PER_WALLET,
  SPECIES,
  TIER_IDS,
  TIER_SUPPLY,
  packedDeck,
  packedTierTable,
  speciesByIndex,
  speciesBySlug,
  type Tier,
} from "./index.ts";

describe("species (D-178, D-179, revised by NFT-U1)", () => {
  it("has 34 species indexed 1 to 34 with unique names and slugs", () => {
    expect(SPECIES).toHaveLength(34);
    expect(SPECIES.map((s) => s.index)).toEqual(Array.from({ length: 34 }, (_, i) => i + 1));
    expect(new Set(SPECIES.map((s) => s.slug)).size).toBe(34);
    expect(new Set(SPECIES.map((s) => s.name)).size).toBe(34);
    for (const s of SPECIES) expect(s.slug).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it("adds up to 500 base, 300 medium and 200 pro, 1,000 in total", () => {
    const byTier = (t: Tier) =>
      SPECIES.filter((s) => s.tier === t).reduce((sum, s) => sum + s.count, 0);
    for (const t of TIER_IDS) expect(byTier(t)).toBe(TIER_SUPPLY[t]);
    expect(SPECIES.reduce((sum, s) => sum + s.count, 0)).toBe(AGENT_MAX_SUPPLY);
  });

  it("carries the final catalog's counts: the 25 species with art, no one of ones (CO-U1)", () => {
    const counts = (t: Tier) => SPECIES.filter((s) => s.tier === t).map((s) => s.count);
    expect(counts("base")).toEqual([100, 100, 100, 0, 100, 100]);
    expect(counts("medium")).toEqual([60, 0, 0, 60, 0, 60, 0, 0, 60, 60]);
    expect(counts("pro")).toEqual([
      13, 13, 13, 0, 14, 14, 14, 14, 0, 14, 13, 0, 13, 13, 13, 13, 13, 13,
    ]);
    expect(SPECIES.find((s) => s.slug === "butterfly")?.tier).toBe("pro");
    expect(SPECIES.find((s) => s.slug === "orchid-mantis")?.tier).toBe("pro");
    // Exactly the catalog is drawn, and no species is a one of one.
    expect(SPECIES.filter((s) => s.count > 0).map((s) => s.index)).toEqual(
      CATALOG_SPECIES.map((s) => s.index),
    );
    expect(SPECIES.some((s) => s.count === 1)).toBe(false);
    for (const s of SPECIES) expect(s.count).toBeLessThanOrEqual(2 ** DECK_BITS_PER_SPECIES - 1);
  });

  it("keeps every index of the first 25 species and appends the nine new ones", () => {
    expect(speciesByIndex(14).name).toBe("Bee");
    expect(speciesByIndex(4).name).toBe("Tick");
    expect(speciesByIndex(25).name).toBe("Cicada");
    expect(SPECIES.slice(25).map((s) => [s.name, s.tier])).toEqual([
      ["Snake", "pro"],
      ["Hummingbird", "pro"],
      ["Fish", "pro"],
      ["Ladybug", "base"],
      ["Grasshopper", "medium"],
      ["Butterfly", "pro"],
      ["Leaf insect", "medium"],
      ["Crab", "pro"],
      ["Orchid mantis", "pro"],
    ]);
  });

  it("looks up by onchain index or slug and refuses 0 (unrevealed)", () => {
    expect(speciesByIndex(1).name).toBe("Larva grub");
    expect(speciesByIndex(34).name).toBe("Orchid mantis");
    expect(speciesBySlug("orchid-mantis")?.index).toBe(34);
    expect(speciesBySlug("unicorn")).toBeUndefined();
    expect(() => speciesByIndex(0)).toThrow(RangeError);
    expect(() => speciesByIndex(35)).toThrow(RangeError);
  });

  it("allows two mints per wallet (D-183, revised by NFT-U1)", () => {
    expect(MINTS_PER_WALLET).toBe(2);
  });
});

const speciesName = (name: string) => SPECIES.find((s) => s.name === name)?.count;

describe("AgentNFT's species table matches this list", () => {
  const source = readFileSync(
    new URL("../../../chains/monad/src/AgentNFT.sol", import.meta.url),
    "utf8",
  );

  it("names and slugs every species in the same order", () => {
    const table = source.slice(
      source.indexOf("// SPECIES TABLE START"),
      source.indexOf("// SPECIES TABLE END"),
    );
    const rows = [...table.matchAll(/if \(s == (\d+)\) return \("([^"]+)", "([^"]+)"\);/g)].map(
      (m) => ({ index: Number(m[1]), name: m[2], slug: m[3] }),
    );
    expect(rows).toEqual(SPECIES.map(({ index, name, slug }) => ({ index, name, slug })));
    expect(source).toContain(`uint8 public constant SPECIES_COUNT = ${SPECIES.length};`);
  });

  it("packs the same counts into the initial deck, 7 bits per species", () => {
    const deck = /INITIAL_DECK = (0x[0-9a-f]+);/.exec(source)?.[1];
    expect(deck && BigInt(deck)).toBe(packedDeck());
    expect(source).toContain(`uint256 internal constant DECK_BITS = ${DECK_BITS_PER_SPECIES};`);
  });

  it("packs the same tiers into the tier table, 2 bits per species", () => {
    const table = /TIER_TABLE = (0x[0-9a-f]+);/.exec(source)?.[1];
    expect(table && BigInt(table)).toBe(packedTierTable());
  });

  it("allows the same number of mints per wallet", () => {
    expect(source).toContain(`uint8 public constant MINTS_PER_WALLET = ${MINTS_PER_WALLET};`);
  });
});
