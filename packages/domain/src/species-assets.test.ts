import { describe, expect, it } from "vitest";
import {
  BEE_SOCKETS,
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
    expect(() => speciesAsset(26)).toThrow(RangeError);
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

  it("puts the bee in 3D with its eight sockets, and every other species in 2D (D-189)", () => {
    const bee = speciesAsset(14);
    expect(bee.species.tier).toBe("pro");
    expect(bee.model?.sockets).toEqual(BEE_SOCKETS);
    expect(requiredSockets(bee)).toHaveLength(8);
    expect(SPECIES_ASSETS.filter((a) => a.model)).toHaveLength(1);
  });
});
