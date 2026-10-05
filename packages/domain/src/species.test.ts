import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_MAX_SUPPLY,
  SPECIES,
  TIER_IDS,
  TIER_SUPPLY,
  speciesByIndex,
  type Tier,
} from "./index.ts";

describe("species (D-178, D-179)", () => {
  it("has 25 species indexed 1 to 25 with unique names and slugs", () => {
    expect(SPECIES).toHaveLength(25);
    expect(SPECIES.map((s) => s.index)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(new Set(SPECIES.map((s) => s.slug)).size).toBe(25);
    expect(new Set(SPECIES.map((s) => s.name)).size).toBe(25);
    for (const s of SPECIES) expect(s.slug).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it("adds up to 600 base, 300 medium and 100 pro, 1,000 in total", () => {
    const byTier = (t: Tier) =>
      SPECIES.filter((s) => s.tier === t).reduce((sum, s) => sum + s.count, 0);
    for (const t of TIER_IDS) expect(byTier(t)).toBe(TIER_SUPPLY[t]);
    expect(SPECIES.reduce((sum, s) => sum + s.count, 0)).toBe(AGENT_MAX_SUPPLY);
  });

  it("lists the owner's exact counts, one of ones included", () => {
    const count = (name: string) => SPECIES.find((s) => s.name === name)?.count;
    expect(SPECIES.filter((s) => s.tier === "base").map((s) => s.count)).toEqual(
      Array(5).fill(120),
    );
    expect(["Silkworm", "Ground beetle", "Cricket", "Moth"].map(count)).toEqual([38, 38, 38, 38]);
    expect(["Firefly", "Centipede", "Water strider", "Earwig"].map(count)).toEqual([
      37, 37, 37, 37,
    ]);
    expect(["Bee", "Praying mantis", "Hercules beetle", "Horseshoe crab"].map(count)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(SPECIES.filter((s) => s.tier === "pro" && s.count === 12)).toHaveLength(8);
  });

  it("keeps tiers in contiguous index ranges: base 1-5, medium 6-13, pro 14-25", () => {
    expect(SPECIES.slice(0, 5).every((s) => s.tier === "base")).toBe(true);
    expect(SPECIES.slice(5, 13).every((s) => s.tier === "medium")).toBe(true);
    expect(SPECIES.slice(13).every((s) => s.tier === "pro")).toBe(true);
  });

  it("looks up by onchain index and refuses 0 (unrevealed)", () => {
    expect(speciesByIndex(1).name).toBe("Larva grub");
    expect(speciesByIndex(25).name).toBe("Cicada");
    expect(() => speciesByIndex(0)).toThrow(RangeError);
    expect(() => speciesByIndex(26)).toThrow(RangeError);
  });
});

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
  });

  it("packs the same counts into the initial deck", () => {
    const deck = /INITIAL_DECK = (0x[0-9a-f]+);/.exec(source)?.[1];
    const expected = SPECIES.reduce(
      (acc, s) => acc | (BigInt(s.count) << BigInt(8 * (s.index - 1))),
      0n,
    );
    expect(deck && BigInt(deck)).toBe(expected);
  });

  it("puts tier boundaries at species 5 and 13, as the contract does", () => {
    expect(source).toContain("if (species <= 5) return TIER_BASE;");
    expect(source).toContain("if (species <= 13) return TIER_MEDIUM;");
    expect(SPECIES.filter((s) => s.tier === "base").at(-1)?.index).toBe(5);
    expect(SPECIES.filter((s) => s.tier === "medium").at(-1)?.index).toBe(13);
  });
});
