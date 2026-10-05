// Shared glTF helpers for the asset scripts (P1-U11): reading GLBs with every
// extension registered, and the few matrix operations the scripts need.
import { type Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

export type Vec3 = [number, number, number];
/** Column-major 4x4, as glTF stores it. */
export type Mat4 = readonly number[];

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Element `i` of an array the caller knows is long enough. */
const at = (a: readonly number[], i: number): number => a[i] ?? 0;

export async function gltfIO(): Promise<NodeIO> {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "meshopt.decoder": MeshoptDecoder,
    "meshopt.encoder": MeshoptEncoder,
  });
}

export async function readGlb(bytes: Uint8Array): Promise<Document> {
  return (await gltfIO()).readBinary(bytes);
}

export async function writeGlb(doc: Document): Promise<Uint8Array> {
  return (await gltfIO()).writeBinary(doc);
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const [x, y, z] = p;
  return [
    at(m, 0) * x + at(m, 4) * y + at(m, 8) * z + at(m, 12),
    at(m, 1) * x + at(m, 5) * y + at(m, 9) * z + at(m, 13),
    at(m, 2) * x + at(m, 6) * y + at(m, 10) * z + at(m, 14),
  ];
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out: number[] = [];
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += at(a, k * 4 + r) * at(b, c * 4 + k);
      out.push(sum);
    }
  }
  return out;
}

/** Inverse of an affine column-major matrix (rotation, scale and translation). */
export function invertAffine(m: Mat4): Mat4 {
  // Row-major names for the 3x3 part: m[col * 4 + row].
  const [a, b, c] = [at(m, 0), at(m, 4), at(m, 8)];
  const [d, e, f] = [at(m, 1), at(m, 5), at(m, 9)];
  const [g, h, i] = [at(m, 2), at(m, 6), at(m, 10)];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) throw new Error("matrix is not invertible");
  const r0: Vec3 = [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det];
  const r1: Vec3 = [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det];
  const r2: Vec3 = [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
  const [x, y, z] = [at(m, 12), at(m, 13), at(m, 14)];
  const t = (r: Vec3) => -(r[0] * x + r[1] * y + r[2] * z);
  // Back to column-major.
  return [
    r0[0],
    r1[0],
    r2[0],
    0,
    r0[1],
    r1[1],
    r2[1],
    0,
    r0[2],
    r1[2],
    r2[2],
    0,
    t(r0),
    t(r1),
    t(r2),
    1,
  ];
}

/**
 * Every vertex position of every mesh, in world space at rest. A skinned
 * mesh is posed through its skin (joint world matrix times inverse bind
 * matrix, blended by weight), as a renderer does: glTF ignores a skinned
 * node's own transform, and quantization moves a skinned mesh's scale into
 * the inverse bind matrices.
 */
export function worldVertices(doc: Document): Vec3[] {
  const out: Vec3[] = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const skin = node.getSkin();
    const world: Mat4 = node.getWorldMatrix();
    const jointMatrices = skin
      ? skin.listJoints().map((joint, j) => {
          const ibm: number[] = [];
          skin.getInverseBindMatrices()?.getElement(j, ibm);
          return multiply(joint.getWorldMatrix(), ibm.length === 16 ? ibm : IDENTITY);
        })
      : null;
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      if (!pos) continue;
      const joints = prim.getAttribute("JOINTS_0");
      const weights = prim.getAttribute("WEIGHTS_0");
      const v: number[] = [];
      const j: number[] = [];
      const w: number[] = [];
      for (let k = 0; k < pos.getCount(); k++) {
        pos.getElement(k, v);
        const p: Vec3 = [at(v, 0), at(v, 1), at(v, 2)];
        if (!jointMatrices || !joints || !weights) {
          out.push(transformPoint(world, p));
          continue;
        }
        joints.getElement(k, j);
        weights.getElement(k, w);
        const sum: Vec3 = [0, 0, 0];
        let total = 0;
        for (let n = 0; n < 4; n++) {
          const weight = at(w, n);
          const matrix = jointMatrices[at(j, n)];
          if (weight === 0 || !matrix) continue;
          const q = transformPoint(matrix, p);
          sum[0] += q[0] * weight;
          sum[1] += q[1] * weight;
          sum[2] += q[2] * weight;
          total += weight;
        }
        out.push(
          total > 0 ? [sum[0] / total, sum[1] / total, sum[2] / total] : transformPoint(world, p),
        );
      }
    }
  }
  return out;
}
