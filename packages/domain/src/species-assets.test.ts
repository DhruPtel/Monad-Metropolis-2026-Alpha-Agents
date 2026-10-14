import { describe, expect, it } from "vitest";
import {
  BEE_SOCKETS,
  BOUNDS_SOCKETS,
  SPECIES,
  SPECIES_ASSETS,
  requiredSockets,
  slotsFor,
  speciesAsset,
} from "./index.ts";

describe("species asset manifest (D-188)", () => {
  it("has one entry per species in onchain order", () => {
    expect(SPECIES_ASSETS.map((a) => a.species)).toEqual(SPECIES);
    expect(speciesAsset(1).species.slug).toBe("larva-grub");
    expect(() => speciesAsset(0)).toThrow(RangeError);
    expect(() => speciesAsset(35)).toThrow(RangeError);
    expect(speciesAsset(34).species.slug).toBe("orchid-mantis");
  });

  it("gives every model enough sockets for its tier, with unique names", () => {
    for (const asset of SPECIES_ASSETS) {
      if (!asset.model) {
        expect(requiredSockets(asset)).toEqual([]);
        continue;
      }
      const { sockets } = asset.model;
      expect(new Set(sockets).size).toBe(sockets.length);
      expect(sockets.length).toBeGreaterThanOrEqual(slotsFor(asset.species.tier));
      for (const s of sockets) expect(s).toMatch(/^socket_[a-z_]+$/);
      expect(requiredSockets(asset)).toHaveLength(slotsFor(asset.species.tier));
    }
  });

  it("records provenance for every model and serves paths from the app root", () => {
    for (const asset of SPECIES_ASSETS) {
      if (asset.image) expect(asset.image).toMatch(/^\/species\/[a-z-]+\.webp$/);
      if (!asset.model) continue;
      expect(asset.model.path).toMatch(/^\/models\/[a-z-]+\.glb$/);
      expect(asset.model.provenance.license).toMatch(/D-1\d\d/);
    }
  });

  it("puts the rigged bee and 24 unrigged models in 3D, and nine species on the placeholder (NFT-U1)", () => {
    const bee = speciesAsset(14);
    expect(bee.species.tier).toBe("pro");
    expect(bee.model?.rigged).toBe(true);
    expect(bee.model?.sockets).toEqual(BEE_SOCKETS);
    expect(requiredSockets(bee)).toHaveLength(8);
    const unrigged = SPECIES_ASSETS.filter((a) => a.model && !a.model.rigged);
    expect(unrigged).toHaveLength(24);
    for (const a of unrigged) {
      expect(a.model?.sockets).toEqual(BOUNDS_SOCKETS);
      expect(a.model?.provenance.rig).toBeNull();
      expect(a.image).toBe(`/species/${a.species.slug}.webp`);
    }
    expect(SPECIES_ASSETS.filter((a) => a.model)).toHaveLength(25);
    expect(SPECIES_ASSETS.filter((a) => a.image)).toHaveLength(25);
    expect(SPECIES_ASSETS.filter((a) => !a.image && !a.model)).toHaveLength(9);
    // Every species in a tier needs at least its tier's slots: 3, 5 or 8 of the 8.
    for (const a of SPECIES_ASSETS) {
      if (a.model) expect(requiredSockets(a)).toHaveLength(slotsFor(a.species.tier));
    }
  });
});

describe("the final catalog (2026-10-13)", () => {
  it("is the 25 species with the owner's art; the nine without art are left out", async () => {
    const { CATALOG_SPECIES, inCatalog } = await import("./species-assets.ts");
    const { SPECIES } = await import("./species.ts");
    expect(CATALOG_SPECIES).toHaveLength(25);
    const out = SPECIES.filter((s) => !inCatalog(s.index)).map((s) => s.name);
    expect(out).toEqual([
      "Tick",
      "Ground beetle",
      "Cricket",
      "Firefly",
      "Water strider",
      "Earwig",
      "Horseshoe crab",
      "Trilobite",
      "Cicada",
    ]);
  });
});
