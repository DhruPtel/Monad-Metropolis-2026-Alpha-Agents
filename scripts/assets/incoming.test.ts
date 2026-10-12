import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SPECIES, SPECIES_ASSETS, speciesBySlug } from "@alpha-agents/domain";
import { REPO_ROOT, incomingRoot, readIncomingMap, sha256 } from "./incoming.ts";

const map = readIncomingMap();
const PUBLIC = join(REPO_ROOT, "apps/web/public");

describe("the incoming art mapping (NFT-U1)", () => {
  it("maps every file to a species and pins it by hash", () => {
    for (const [slug, entry] of [...Object.entries(map.images), ...Object.entries(map.models)]) {
      expect(speciesBySlug(slug), slug).toBeDefined();
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.file).not.toMatch(/Zone\.Identifier/);
    }
    for (const entry of map.unused) expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("covers the owner's 25 images and 24 models, with the bee's unrigged export set aside", () => {
    expect(Object.keys(map.images)).toHaveLength(25);
    expect(Object.keys(map.models)).toHaveLength(24);
    expect(map.models.bee).toBeUndefined();
    expect(map.unused.map((u) => u.file)).toEqual(["Bee.glb"]);
    // Every modelled species has its image; the bee keeps P1-U11's rigged model.
    for (const slug of Object.keys(map.models)) expect(map.images[slug], slug).toBeDefined();
    // The owner's three named species and the six the art holds are all mapped.
    for (const slug of [
      "snake",
      "hummingbird",
      "fish",
      "ladybug",
      "grasshopper",
      "butterfly",
      "leaf-insect",
      "crab",
      "orchid-mantis",
    ]) {
      expect(map.images[slug], slug).toBeDefined();
      expect(map.models[slug], slug).toBeDefined();
    }
  });

  it("agrees with the species asset manifest and the committed files", () => {
    for (const asset of SPECIES_ASSETS) {
      const { slug } = asset.species;
      expect(asset.image !== null, `${slug} image`).toBe(slug in map.images);
      expect(asset.model !== null, `${slug} model`).toBe(slug in map.models || slug === "bee");
      if (asset.image) expect(existsSync(join(PUBLIC, asset.image)), asset.image).toBe(true);
      if (asset.model)
        expect(existsSync(join(PUBLIC, asset.model.path)), asset.model.path).toBe(true);
    }
    // Nine species keep the placeholder until their art arrives.
    expect(SPECIES_ASSETS.filter((a) => !a.image).map((a) => a.species.slug)).toEqual([
      "tick",
      "ground-beetle",
      "cricket",
      "firefly",
      "water-strider",
      "earwig",
      "horseshoe-crab",
      "trilobite",
      "cicada",
    ]);
    expect(SPECIES).toHaveLength(34);
  });

  it("names every file in the folder, with its pinned hash, when the originals are here", () => {
    const images = incomingRoot(map, "images");
    const models = incomingRoot(map, "models");
    if (!images || !models) return; // The folder is gitignored; CI has no originals.
    const listed = (dir: string) => readdirSync(dir).filter((f) => !f.endsWith(":Zone.Identifier"));
    expect([...listed(images)].sort()).toEqual(
      Object.values(map.images)
        .map((e) => e.file)
        .sort(),
    );
    expect([...listed(models)].sort()).toEqual(
      [...Object.values(map.models).map((e) => e.file), ...map.unused.map((u) => u.file)].sort(),
    );
    for (const [dir, entries] of [
      [images, Object.values(map.images)],
      [models, [...Object.values(map.models), ...map.unused]],
    ] as const) {
      for (const entry of entries) {
        expect(sha256(readFileSync(join(dir, entry.file))), entry.file).toBe(entry.sha256);
      }
    }
  }, 120_000);
});
