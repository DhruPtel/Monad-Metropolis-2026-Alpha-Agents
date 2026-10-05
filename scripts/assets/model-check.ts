// The asset checker (P1-U11): every species model must pass these limits
// before the app shows it. `pnpm assets:check` runs it on every model in the
// species manifest, and model-check.test.ts proves a broken model fails.
import type { Document } from "@gltf-transform/core";
import type { SpeciesAsset } from "@alpha-agents/domain";
import { requiredSockets } from "@alpha-agents/domain";
import { type Vec3, readGlb, worldVertices } from "./glb.ts";

/**
 * Proposed from the one model in this unit, the bee (1.90 MB, 25,229
 * triangles, 2048px WebP textures, about 3.4 units long), with room for the
 * other 24 species:
 * - file size: 3 MB, so a configure page loads one model quickly on mobile;
 * - triangles: 40,000, light for any integrated GPU at one model per page;
 * - textures: 2048px at most;
 * - scale: the longest side between 2.5 and 4.5 units, which the scene's
 *   camera, platform (radius 1.4) and walk-in distance are tuned for;
 * - no Draco: its decoder would come from a CDN; meshopt decodes locally.
 */
export interface ModelLimits {
  readonly maxBytes: number;
  readonly maxTriangles: number;
  readonly maxTextureSize: number;
  readonly minLongestSide: number;
  readonly maxLongestSide: number;
}

export const MODEL_LIMITS: ModelLimits = {
  maxBytes: 3_000_000,
  maxTriangles: 40_000,
  maxTextureSize: 2048,
  minLongestSide: 2.5,
  maxLongestSide: 4.5,
};

export interface ModelReport {
  readonly bytes: number;
  readonly triangles: number;
  readonly longestSide: number;
  readonly maxTextureSize: number;
  readonly sockets: readonly string[];
  readonly skinned: boolean;
  readonly problems: readonly string[];
}

function triangleCount(doc: Document): number {
  let total = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue; // TRIANGLES only
      const indices = prim.getIndices();
      total += Math.floor(
        (indices ? indices.getCount() : (prim.getAttribute("POSITION")?.getCount() ?? 0)) / 3,
      );
    }
  }
  return total;
}

function longestSide(doc: Document): number {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of worldVertices(doc)) {
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  }
  return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

/** Checks one model document against the limits and its species' manifest entry. */
export function checkModelDocument(
  doc: Document,
  bytes: number,
  asset: SpeciesAsset,
  limits: ModelLimits = MODEL_LIMITS,
): ModelReport {
  const problems: string[] = [];
  const root = doc.getRoot();
  const triangles = triangleCount(doc);
  const side = longestSide(doc);
  const textureSizes = root.listTextures().map((t) => Math.max(...(t.getSize() ?? [0, 0])));
  const maxTextureSize = Math.max(0, ...textureSizes);
  const nodeNames = new Set(root.listNodes().map((n) => n.getName()));
  const sockets = root
    .listNodes()
    .map((n) => n.getName())
    .filter((n) => n.startsWith("socket_"));
  // Rigged means a mesh is bound to a skin, not merely that a skin exists.
  const skinned = root.listNodes().some((n) => n.getMesh() !== null && n.getSkin() !== null);

  if (bytes > limits.maxBytes) problems.push(`file is ${bytes} bytes, over ${limits.maxBytes}`);
  if (triangles > limits.maxTriangles) {
    problems.push(`${triangles} triangles, over ${limits.maxTriangles}`);
  }
  if (maxTextureSize > limits.maxTextureSize) {
    problems.push(`a ${maxTextureSize}px texture, over ${limits.maxTextureSize}px`);
  }
  if (!(side >= limits.minLongestSide && side <= limits.maxLongestSide)) {
    problems.push(
      `longest side ${side.toFixed(2)} units, outside ${limits.minLongestSide} to ${limits.maxLongestSide}`,
    );
  }
  for (const name of requiredSockets(asset)) {
    if (!nodeNames.has(name)) problems.push(`missing socket ${name}`);
  }
  if (asset.model && asset.model.rigged !== skinned) {
    problems.push(
      asset.model.rigged
        ? "listed as rigged but has no skin"
        : "has a skin but is listed as unrigged",
    );
  }
  if (root.listExtensionsUsed().some((e) => e.extensionName === "KHR_draco_mesh_compression")) {
    problems.push("uses Draco, whose decoder would load from a CDN; use meshopt");
  }
  return { bytes, triangles, longestSide: side, maxTextureSize, sockets, skinned, problems };
}

export async function checkModelBytes(
  bytes: Uint8Array,
  asset: SpeciesAsset,
  limits: ModelLimits = MODEL_LIMITS,
): Promise<ModelReport> {
  return checkModelDocument(await readGlb(bytes), bytes.byteLength, asset, limits);
}
