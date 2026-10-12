// Builds every species model in apps/web/public/models/ from the owner's
// incoming Meshy exports (NFT-U1). Run: pnpm assets:build-models [slug ...]
//
// The exports are unrigged, 0.6 to 2.6 million triangles and 25 to 90 MB
// each, with three 2048px JPEG textures and a longest side of about 1.9
// units. For each model in scripts/assets/incoming.json (its hash checked):
// 1. weld and simplify to TARGET_TRIANGLES with the meshopt simplifier;
// 2. textures to WebP at TEXTURE_SIZE;
// 3. turn it by its `yaw` so it faces +Z (the camera), scale its longest
//    side to TARGET_SIZE and centre it on the platform with its lowest point
//    at y = 0, baked into the mesh so the file carries no transform;
// 4. add the eight BOUNDS_SOCKETS: plain nodes on the shell, each found by
//    walking out from the bounds' centre along a fixed direction (top, head,
//    tail, the sides and the quarters), so a slot sits on the model however
//    it is shaped and follows its rigid motion;
// 5. dedup, prune, quantize and meshopt-compress, then write the GLB.
// pnpm assets:check validates the result against MODEL_LIMITS.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Document } from "@gltf-transform/core";
import {
  dedup,
  meshopt,
  prune,
  quantize,
  simplify,
  textureCompress,
  weld,
} from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";
import { BOUNDS_SOCKETS, SPECIES, speciesBySlug } from "@alpha-agents/domain";
import { type Vec3, readGlb, worldVertices, writeGlb } from "./glb.ts";
import { REPO_ROOT, incomingRoot, readIncomingMap, readPinned } from "./incoming.ts";

export const TARGET_TRIANGLES = 38_000;
export const TEXTURE_SIZE = 1024;
export const TEXTURE_QUALITY = 82;
/** The bee is about 3.4 units long; every model gets the same longest side. */
export const TARGET_SIZE = 3.4;
/** A socket floats just off the shell so a part never clips into it. */
const SURFACE_LIFT = 0.03;
const OUT = join(REPO_ROOT, "apps/web/public/models");

/** Where each socket looks from the bounds' centre, in the model's facing frame (+Z forward). */
export const SOCKET_DIRECTIONS: Readonly<Record<(typeof BOUNDS_SOCKETS)[number], Vec3>> = {
  socket_top: [0, 1, 0],
  socket_front: [0, 0.45, 1],
  socket_back: [0, 0.45, -1],
  socket_left: [-1, 0.35, 0],
  socket_right: [1, 0.35, 0],
  socket_front_left: [-0.7, 0.5, 0.7],
  socket_front_right: [0.7, 0.5, 0.7],
  socket_rear: [0, 0.85, -0.55],
};

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

function triangleCount(doc: Document): number {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      n += Math.floor(
        (idx ? idx.getCount() : (prim.getAttribute("POSITION")?.getCount() ?? 0)) / 3,
      );
    }
  }
  return n;
}

function bounds(vertices: readonly Vec3[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of vertices) {
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  }
  return { min, max };
}

/**
 * The shell point from `origin` furthest along `dir`, staying within `near`
 * of the ray so a leg or a wing tip never wins over the body, lifted off the
 * surface. The search widens when nothing lies along the ray.
 */
export function shellPoint(vertices: readonly Vec3[], origin: Vec3, dir: Vec3, near: number): Vec3 {
  const d = norm(dir);
  for (let radius = near; radius < near * 8; radius *= 1.5) {
    let best: Vec3 | null = null;
    let bestScore = -Infinity;
    for (const v of vertices) {
      const rel: Vec3 = [v[0] - origin[0], v[1] - origin[1], v[2] - origin[2]];
      const along = rel[0] * d[0] + rel[1] * d[1] + rel[2] * d[2];
      if (along <= 0) continue;
      const off = Math.hypot(rel[0] - along * d[0], rel[1] - along * d[1], rel[2] - along * d[2]);
      if (off > radius) continue;
      const score = along - 0.5 * off;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    if (best) {
      return [
        best[0] + d[0] * SURFACE_LIFT,
        best[1] + d[1] * SURFACE_LIFT,
        best[2] + d[2] * SURFACE_LIFT,
      ];
    }
  }
  throw new Error(`no shell found from [${origin.map((n) => n.toFixed(2)).join(", ")}]`);
}

/**
 * Bakes yaw, scale and the centring translation into every vertex position
 * (and turns the normals), so the file's nodes carry no transform the viewer
 * or the checker could read differently.
 */
function bakeTransform(doc: Document, yawDeg: number, scale: number, offset: Vec3): void {
  const yaw = (yawDeg * Math.PI) / 180;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const turn = (v: Vec3): Vec3 => [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      if (pos) {
        const v: number[] = [];
        for (let i = 0; i < pos.getCount(); i++) {
          pos.getElement(i, v);
          const t = turn([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0]);
          pos.setElement(i, [
            t[0] * scale + offset[0],
            t[1] * scale + offset[1],
            t[2] * scale + offset[2],
          ]);
        }
      }
      const nrm = prim.getAttribute("NORMAL");
      if (nrm) {
        const v: number[] = [];
        for (let i = 0; i < nrm.getCount(); i++) {
          nrm.getElement(i, v);
          nrm.setElement(i, turn([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0]));
        }
      }
      const tan = prim.getAttribute("TANGENT");
      if (tan) {
        const v: number[] = [];
        for (let i = 0; i < tan.getCount(); i++) {
          tan.getElement(i, v);
          const t = turn([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0]);
          tan.setElement(i, [t[0], t[1], t[2], v[3] ?? 1]);
        }
      }
    }
  }
  // Mesh nodes keep the identity transform: everything is in the vertices now.
  for (const node of doc.getRoot().listNodes()) {
    if (node.getMesh()) {
      node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
    }
  }
}

export interface BuildReport {
  readonly slug: string;
  readonly bytes: number;
  readonly trianglesBefore: number;
  readonly triangles: number;
  readonly longestSide: number;
  readonly sockets: Readonly<Record<string, Vec3>>;
}

export async function buildModel(
  source: Uint8Array,
  slug: string,
  yaw: number,
): Promise<{ bytes: Uint8Array; report: BuildReport }> {
  await MeshoptSimplifier.ready;
  await MeshoptEncoder.ready;
  const doc = await readGlb(source);
  const root = doc.getRoot();
  if (root.listSkins().length > 0) throw new Error(`${slug}: a rigged source needs its own build`);
  const trianglesBefore = triangleCount(doc);

  await doc.transform(weld());
  if (trianglesBefore > TARGET_TRIANGLES) {
    await doc.transform(
      simplify({
        simplifier: MeshoptSimplifier,
        ratio: TARGET_TRIANGLES / trianglesBefore,
        error: 0.01,
      }),
    );
  }
  await doc.transform(
    textureCompress({
      encoder: sharp,
      targetFormat: "webp",
      resize: [TEXTURE_SIZE, TEXTURE_SIZE],
      quality: TEXTURE_QUALITY,
    }),
  );

  // The bounds of the turned model set the scale and the centring, so a
  // turned model has the same longest side as an unturned one.
  const yawRad = (yaw * Math.PI) / 180;
  const turned = worldVertices(doc).map(([x, y, z]): Vec3 => [
    x * Math.cos(yawRad) + z * Math.sin(yawRad),
    y,
    -x * Math.sin(yawRad) + z * Math.cos(yawRad),
  ]);
  const b = bounds(turned);
  const side = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const scale = TARGET_SIZE / side;
  // Turn, then scale, then stand on y = 0 centred on x and z.
  const offset: Vec3 = [
    (-(b.min[0] + b.max[0]) / 2) * scale,
    -b.min[1] * scale,
    (-(b.min[2] + b.max[2]) / 2) * scale,
  ];
  // The exports put every vertex on one unparented node; fold its matrix in.
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    const identity = m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9);
    if (!identity)
      throw new Error(`${slug}: a mesh node carries a transform; bake it in Blender first`);
  }
  bakeTransform(doc, yaw, scale, offset);

  const vertices = worldVertices(doc);
  const after = bounds(vertices);
  const centre: Vec3 = [
    (after.min[0] + after.max[0]) / 2,
    (after.min[1] + after.max[1]) / 2,
    (after.min[2] + after.max[2]) / 2,
  ];
  const near = 0.12 * TARGET_SIZE;
  const sockets: Record<string, Vec3> = {};
  const scene = root.listScenes()[0] ?? doc.createScene("scene");
  for (const name of BOUNDS_SOCKETS) {
    const p = shellPoint(vertices, centre, SOCKET_DIRECTIONS[name], near);
    sockets[name] = p;
    scene.addChild(doc.createNode(name).setTranslation(p));
  }

  // The sockets are empty leaf nodes: prune must keep them.
  await doc.transform(
    dedup(),
    prune({ keepLeaves: true }),
    quantize(),
    meshopt({ encoder: MeshoptEncoder, level: "medium" }),
  );
  const bytes = await writeGlb(doc);
  const longest = Math.max(
    after.max[0] - after.min[0],
    after.max[1] - after.min[1],
    after.max[2] - after.min[2],
  );
  return {
    bytes,
    report: {
      slug,
      bytes: bytes.byteLength,
      trianglesBefore,
      triangles: triangleCount(doc),
      longestSide: longest,
      sockets,
    },
  };
}

const only = new Set(process.argv.slice(2));
const map = readIncomingMap();
const root = incomingRoot(map, "models");
if (!root) {
  console.error(`error: ${map.roots.models} is not on this machine; the committed models stand`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
let total = 0;
for (const [slug, entry] of Object.entries(map.models)) {
  if (only.size > 0 && !only.has(slug)) continue;
  if (!speciesBySlug(slug)) throw new Error(`${slug} is not one of the ${SPECIES.length} species`);
  const started = Date.now();
  const { bytes, report } = await buildModel(readPinned(root, entry), slug, entry.yaw);
  writeFileSync(join(OUT, `${slug}.glb`), bytes);
  total += bytes.byteLength;
  console.log(
    `${slug.padEnd(16)} ${(report.bytes / 1e6).toFixed(2)} MB, ${report.trianglesBefore} -> ${report.triangles} triangles, ` +
      `longest side ${report.longestSide.toFixed(2)}, yaw ${entry.yaw}, ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
}
console.log(`${(total / 1e6).toFixed(2)} MB of models in all`);
