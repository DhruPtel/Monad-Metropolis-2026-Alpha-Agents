// Builds apps/web/public/models/bee.glb from the prototype's optimized rigged
// bee (P1-U11). Run: pnpm assets:build-bee [path to bee_rig_opt.glb]
//
// The source is the Apiary prototype's `public/models/bee_rig_opt.glb`
// (Meshy mesh, UniRig rig, glTF Transform WebP textures; provenance in
// packages/domain species-assets.ts and docs/assets.md). It is not in this
// repository; the hash below pins exactly which file the committed model came
// from. The script:
// 1. drops the skin attribute sets three.js never reads (JOINTS_1-4, WEIGHTS_1-4);
// 2. adds the eight named socket nodes, each parented to a body, head or
//    abdomen bone (never a wing or leg, whose weights drag the shell) and placed
//    on the surface above, beside or behind that bone, so a slot follows the
//    walk and hover;
// 3. compresses geometry with meshopt and quantization.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Document, Node } from "@gltf-transform/core";
import { dedup, meshopt, prune } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import { BEE_SOCKETS } from "@alpha-agents/domain";
import {
  type Mat4,
  type Vec3,
  invertAffine,
  readGlb,
  transformPoint,
  worldVertices,
  writeGlb,
} from "./glb.ts";

export const BEE_SOURCE_SHA256 = "5f7e2d7bd19664b5c12add839178fc30d0d823ac53f83cc0aa1f2658b5bdeb47";
const DEFAULT_SOURCE = join(homedir(), "Monad-Test/public/models/bee_rig_opt.glb");
const OUTPUT = new URL("../../apps/web/public/models/bee.glb", import.meta.url);

/** Where each socket sits: the bone it follows and the surface direction from it. */
const SOCKET_PLACEMENT: Readonly<
  Record<(typeof BEE_SOCKETS)[number], { bone: string; dir: Vec3 }>
> = {
  socket_thorax_top: { bone: "Bone_001", dir: [0, 1, 0] },
  socket_head: { bone: "Bone_002", dir: [0, 1, 0.4] },
  socket_abdomen_top: { bone: "Bone_036", dir: [0, 1, 0] },
  socket_thorax_left: { bone: "Bone_001", dir: [-1, 0.3, 0] },
  socket_thorax_right: { bone: "Bone_001", dir: [1, 0.3, 0] },
  socket_abdomen_left: { bone: "Bone_035", dir: [-1, 0.3, 0] },
  socket_abdomen_right: { bone: "Bone_035", dir: [1, 0.3, 0] },
  socket_abdomen_rear: { bone: "Bone_034", dir: [0, 0.3, -1] },
};

/** How far from the bone to look for its own shell, model units (the bee is about 3.4 long). */
const NEAR_BONE = 0.45;
/** A socket floats just off the surface so a part never clips into it. */
const SURFACE_LIFT = 0.03;

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** The shell point near `origin` furthest along `dir`, lifted slightly off the surface. */
function surfacePoint(vertices: Vec3[], origin: Vec3, dir: Vec3): Vec3 {
  const d = norm(dir);
  let best: Vec3 | null = null;
  let bestScore = -Infinity;
  for (const v of vertices) {
    const rel: Vec3 = [v[0] - origin[0], v[1] - origin[1], v[2] - origin[2]];
    const along = rel[0] * d[0] + rel[1] * d[1] + rel[2] * d[2];
    if (along <= 0) continue;
    // Distance from the ray through the bone: stay over the bone, not out on a limb.
    const off = Math.hypot(rel[0] - along * d[0], rel[1] - along * d[1], rel[2] - along * d[2]);
    if (off > NEAR_BONE) continue;
    const score = along - 0.5 * off;
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  if (!best) throw new Error(`no surface found from [${origin.join(", ")}]`);
  return [
    best[0] + d[0] * SURFACE_LIFT,
    best[1] + d[1] * SURFACE_LIFT,
    best[2] + d[2] * SURFACE_LIFT,
  ];
}

export function addSockets(doc: Document): void {
  const nodes = new Map(
    doc
      .getRoot()
      .listNodes()
      .map((n) => [n.getName(), n] as [string, Node]),
  );
  const vertices = worldVertices(doc);
  for (const name of BEE_SOCKETS) {
    if (nodes.has(name)) throw new Error(`${name} already exists`);
    const { bone, dir } = SOCKET_PLACEMENT[name];
    const parent = nodes.get(bone);
    if (!parent) throw new Error(`bone ${bone} not found`);
    const world = parent.getWorldMatrix() as Mat4;
    const origin = transformPoint(world, [0, 0, 0]);
    const local = transformPoint(invertAffine(world), surfacePoint(vertices, origin, dir));
    parent.addChild(doc.createNode(name).setTranslation(local));
  }
}

export function pruneUnusedSkinSets(doc: Document): void {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const semantic of prim.listSemantics()) {
        if (/^(JOINTS|WEIGHTS)_[1-9]$/.test(semantic)) prim.setAttribute(semantic, null);
      }
    }
  }
}

async function main() {
  const source = process.argv[2] ?? DEFAULT_SOURCE;
  const bytes = readFileSync(source);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== BEE_SOURCE_SHA256) {
    throw new Error(`${source} is not the recorded source (sha256 ${hash})`);
  }
  const doc = await readGlb(bytes);
  pruneUnusedSkinSets(doc);
  addSockets(doc);
  // keepLeaves: sockets are empty leaf nodes, which prune would otherwise remove.
  await doc.transform(
    prune({ keepLeaves: true }),
    dedup(),
    meshopt({ encoder: MeshoptEncoder, level: "medium" }),
  );
  doc.getRoot().getAsset().generator = "Alpha Agents scripts/assets/build-bee-model.ts";
  const out = await writeGlb(doc);
  writeFileSync(OUTPUT, out);
  console.log(`wrote apps/web/public/models/bee.glb: ${(out.byteLength / 1e6).toFixed(2)} MB`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
