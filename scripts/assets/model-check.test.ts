import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SPECIES_ASSETS, requiredSockets, speciesAsset } from "@alpha-agents/domain";
import type { Document, Node } from "@gltf-transform/core";
import { readGlb, worldVertices } from "./glb.ts";
import { MODEL_LIMITS, checkModelBytes, checkModelDocument } from "./model-check.ts";

const PUBLIC = new URL("../../apps/web/public/", import.meta.url);
const beeAsset = speciesAsset(14);
const beeBytes = readFileSync(new URL("models/bee.glb", PUBLIC));
const loadBee = () => readGlb(beeBytes);

function nodeNamed(doc: Document, name: string): Node {
  const node = doc
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === name);
  if (!node) throw new Error(`no node ${name}`);
  return node;
}

describe("asset checker", () => {
  it("passes every model in the species manifest", async () => {
    for (const asset of SPECIES_ASSETS) {
      if (!asset.model) continue;
      const bytes = readFileSync(new URL(asset.model.path.slice(1), PUBLIC));
      const report = await checkModelBytes(bytes, asset);
      expect(report.problems, asset.species.slug).toEqual([]);
    }
  });

  it("reports the bee's size, triangles, scale and every socket", async () => {
    const report = await checkModelBytes(beeBytes, beeAsset);
    expect(report.triangles).toBe(25_229);
    expect(report.bytes).toBeLessThan(MODEL_LIMITS.maxBytes);
    expect(report.longestSide).toBeGreaterThan(3.3);
    expect(report.longestSide).toBeLessThan(3.6);
    expect(report.skinned).toBe(true);
    expect([...report.sockets].sort()).toEqual([...requiredSockets(beeAsset)].sort());
  }, 30_000);

  it("fails a model that lost a socket", async () => {
    const doc = await loadBee();
    nodeNamed(doc, "socket_head").dispose();
    const report = checkModelDocument(doc, beeBytes.byteLength, beeAsset);
    expect(report.problems).toEqual(["missing socket socket_head"]);
  }, 30_000);

  it("fails a model at the wrong scale", async () => {
    const doc = await loadBee();
    nodeNamed(doc, "UniRigArmature").setScale([10, 10, 10]);
    const report = checkModelDocument(doc, beeBytes.byteLength, beeAsset);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatch(/^longest side 34\.\d\d units, outside 2\.5 to 4\.5$/);
  }, 30_000);

  it("fails a model over the size or triangle limits", async () => {
    const doc = await loadBee();
    const tight = { ...MODEL_LIMITS, maxBytes: 1_000_000, maxTriangles: 10_000 };
    const report = checkModelDocument(doc, beeBytes.byteLength, beeAsset, tight);
    expect(report.problems).toEqual([
      `file is ${beeBytes.byteLength} bytes, over 1000000`,
      "25229 triangles, over 10000",
    ]);
  }, 30_000);

  it("fails a rigged model that lost its skin", async () => {
    const doc = await loadBee();
    for (const node of doc.getRoot().listNodes()) node.setSkin(null);
    const report = checkModelDocument(doc, beeBytes.byteLength, beeAsset);
    expect(report.problems).toContain("listed as rigged but has no skin");
  }, 30_000);

  it("refuses a file that is not a GLB", async () => {
    await expect(checkModelBytes(new Uint8Array([1, 2, 3, 4]), beeAsset)).rejects.toThrow();
  });

  it("places every socket on the bee's shell, not inside it or floating away", async () => {
    const doc = await loadBee();
    const vertices = worldVertices(doc);
    for (const name of requiredSockets(beeAsset)) {
      const p = nodeNamed(doc, name).getWorldTranslation();
      const nearest = Math.min(
        ...vertices.map((v) => Math.hypot(v[0] - p[0], v[1] - p[1], v[2] - p[2])),
      );
      expect(nearest, name).toBeLessThan(0.08);
    }
  }, 60_000);

  it("lists only the bee as a model in this unit (D-189)", () => {
    expect(SPECIES_ASSETS.filter((a) => a.model).map((a) => a.species.slug)).toEqual(["bee"]);
    expect(speciesAsset(14).species.slug).toBe("bee");
  });
});
