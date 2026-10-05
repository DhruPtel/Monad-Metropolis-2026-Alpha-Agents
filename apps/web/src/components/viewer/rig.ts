/**
 * The procedural rig for an insect model (P1-U11), ported from the Apiary
 * prototype's RiggedBee: it finds the body, head, antennae, wings and six legs
 * from the skeleton's hierarchy and rest positions, and computes the poses the
 * walk, hover and idle motions apply. The model files carry no animation
 * clips, so all motion is procedural. A model without bones gets none of the
 * bone layers, only the rigid travel, lift and sway.
 *
 * Changes from the prototype: nothing is logged; the rest pose and base offset
 * are kept per cloned scene (every viewer clones its own); colors come from
 * the design tokens (scene-colors.ts).
 *
 * Model space for the bee: +Z forward (head), +X right, +Y up.
 */
import {
  AdditiveBlending,
  Bone,
  Box3,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  Quaternion,
  SkinnedMesh,
  Vector3,
} from "three";

export type LegKey = "frontL" | "frontR" | "midL" | "midR" | "rearL" | "rearR";

/**
 * Every frequency, amplitude and timing, in degrees and seconds unless noted.
 * Model units are the GLB's own (the bee is about 3.4 long). The UniRig skin
 * weights bleed into the thorax, so bone rotations are kept small and scaled
 * by DEFORM_DAMPING; rigid group motion (travel, bob, lift) is not damped.
 */
export const ANIM_CONFIG = {
  DEFORM_DAMPING: 0.6,
  walk: {
    speed: 1,
    cycleHz: 0.6,
    dwell: 0.2,
    swingDeg: 8,
    liftDeg: 4,
    rearScale: 0,
    rollDeg: 0.6,
    headNodDeg: 1.2,
  },
  /**
   * The select sequence: walk in from behind, wings spin up during the last
   * steps, legs settle, lift off, hover. About 4 s to a steady hover.
   */
  sequence: {
    distance: 2.5,
    walkSec: 2.4,
    wingLeadSec: 0.9,
    settleSec: 0.6,
    liftDelaySec: 0.35,
    returnSec: 0.8,
  },
  idle: {
    fadeInSec: 1,
    headTurnDeg: 3,
    headTurnSec: 0.9,
    headHoldSec: 1.4,
    headGapSec: [3, 7] as const,
  },
  wings: {
    flapHz: 3,
    flapDeg: 2,
    dwell: 0.08,
    phaseOffset: 0,
    spinUpSec: 0.5,
    spinDownSec: 0.8,
    /** The visible stroke: translucent copies of the wing geometry pivoting at the root. */
    cue: { deg: 24, opacity: 0.14 },
  },
  hover: {
    height: 0.3,
    bobAmp: 0.04,
    bobHz: 0.8,
    swayDeg: 1.2,
    swayHz: 0.35,
    takeoffSec: 1.1,
    landSec: 1.6,
    liftAfterFlap: 0.6,
    tuckHipDeg: 6,
  },
  antennae: { swayDeg: 5, swayHz: 0.4 },
  enable: { fadeSec: 0.5 },
} as const;

export type AnimState = "walking" | "settling" | "idle" | "takingOff" | "hovering" | "landing";

/* ---- rig discovery ------------------------------------------------------- */

const boneChildren = (b: Object3D): Bone[] =>
  b.children.filter((c): c is Bone => c instanceof Bone);

function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

/** Follow single-child links from a bone until it branches or ends. */
function chainFrom(start: Bone): Bone[] {
  const chain = [start];
  let b: Bone = start;
  for (;;) {
    const kids = boneChildren(b);
    const only = kids.length === 1 ? kids[0] : undefined;
    if (!only) return chain;
    b = only;
    chain.push(b);
  }
}

/** Rest position of an object in model space (composed from local transforms up to root). */
function modelPos(obj: Object3D, root: Object3D): Vector3 {
  const p = new Vector3();
  for (let o: Object3D | null = obj; o && o !== root; o = o.parent) {
    p.multiply(o.scale).applyQuaternion(o.quaternion).add(o.position);
  }
  return p;
}

/** Rest orientation of an object in model space. */
function modelQuat(obj: Object3D, root: Object3D): Quaternion {
  const q = new Quaternion();
  for (let o: Object3D | null = obj; o && o !== root; o = o.parent) q.premultiply(o.quaternion);
  return q;
}

interface Inferred {
  head?: Bone;
  antennaL?: Bone;
  antennaR?: Bone;
  wingL?: Bone;
  wingR?: Bone;
  legs: Partial<Record<LegKey, { hip: Bone; knee: Bone | undefined }>>;
}

/** Finds the insect's parts from the skeleton's shape. */
export function inferBones(bones: readonly Bone[], posOf: (b: Bone) => Vector3): Inferred {
  const out: Inferred = { legs: {} };
  const first = bones[0];
  if (!first) return out;

  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const b of bones) {
    min.min(posOf(b));
    max.max(posOf(b));
  }
  const size = Math.max(max.x - min.x, max.y - min.y, max.z - min.z) || 1;
  const eps = 0.02 * size;
  const lateral = 0.1 * size;

  // Hub: the bone with the most bone children (the thorax).
  const hub = bones.reduce(
    (best, b) => (boneChildren(b).length > boneChildren(best).length ? b : best),
    first,
  );
  const hubPos = posOf(hub);
  const chains = boneChildren(hub).map(chainFrom);
  const tipOf = (c: readonly Bone[]) => posOf(last(c) ?? hub);
  const rootOf = (c: readonly Bone[]) => c[0] ?? hub;

  // Head: the hub chain that ends in a branching bone. Forward is the way it points.
  const headChain = chains.find((c) => boneChildren(last(c) ?? hub).length >= 2);
  let forward = 1;
  const head = headChain ? last(headChain) : undefined;
  if (head) {
    out.head = head;
    forward = Math.sign(posOf(head).z - hubPos.z) || 1;
    // Antennae: head children whose tip rises above the head, leftmost and rightmost.
    const ups = boneChildren(head)
      .map(chainFrom)
      .filter((c) => tipOf(c).y > posOf(head).y + eps)
      .sort((a, b) => posOf(rootOf(a)).x - posOf(rootOf(b)).x);
    const left = ups[0];
    const right = last(ups);
    if (ups.length >= 2 && left && right) {
      out.antennaL = rootOf(left);
      out.antennaR = rootOf(right);
    }
  }

  const rest = chains.filter((c) => c !== headChain);
  // Wings reach up and out; legs reach down and out; the centre line is the abdomen.
  const wings = rest
    .filter((c) => tipOf(c).y > hubPos.y + eps && Math.abs(tipOf(c).x) > lateral)
    .sort((a, b) => posOf(rootOf(a)).x - posOf(rootOf(b)).x);
  const wingLeft = wings[0];
  const wingRight = last(wings);
  if (wings.length >= 2 && wingLeft && wingRight) {
    out.wingL = rootOf(wingLeft);
    out.wingR = rootOf(wingRight);
  }
  const legs = rest.filter((c) => tipOf(c).y < hubPos.y - eps && Math.abs(tipOf(c).x) > lateral);
  const kneeOf = (chain: readonly Bone[]): Bone | undefined => {
    const span = posOf(rootOf(chain)).distanceTo(tipOf(chain));
    if (span < 0.05 * size) return undefined; // a stub: nothing to bend
    const inner = chain.slice(1, -1).filter((b) => boneChildren(b).length > 0);
    const firstInner = inner[0];
    if (!firstInner) return undefined;
    // The knee: the highest joint along the chain (femur rises, tibia drops).
    return inner.reduce((best, b) => (posOf(b).y > posOf(best).y ? b : best), firstInner);
  };
  const bySide = (sign: number) =>
    legs
      .filter((c) => Math.sign(tipOf(c).x) === sign)
      .sort((a, b) => tipOf(b).z * forward - tipOf(a).z * forward)
      .slice(0, 3);
  const assign = (side: readonly Bone[][], keys: readonly LegKey[]) =>
    side.forEach((chain, i) => {
      const key = keys[i];
      if (key) out.legs[key] = { hip: rootOf(chain), knee: kneeOf(chain) };
    });
  assign(bySide(-1), ["frontL", "midL", "rearL"]);
  assign(bySide(1), ["frontR", "midR", "rearR"]);
  return out;
}

/* ---- rig setup ----------------------------------------------------------- */

export interface AnimBone {
  readonly bone: Bone;
  readonly rest: Quaternion;
  /** Model-space axes in the bone's parent frame, so rotations read in model terms. */
  readonly axisX: Vector3;
  readonly axisY: Vector3;
  readonly axisZ: Vector3;
}

export interface Leg {
  readonly hip: AnimBone | undefined;
  readonly knee: AnimBone | undefined;
  readonly side: 1 | -1;
  /** Gait phase offset, in cycles. */
  readonly phase: number;
  readonly rear: boolean;
}

export interface Rig {
  readonly head: AnimBone | undefined;
  readonly antennaL: AnimBone | undefined;
  readonly antennaR: AnimBone | undefined;
  readonly wingL: AnimBone | undefined;
  readonly wingR: AnimBone | undefined;
  readonly wingRootL: Vector3 | undefined;
  readonly wingRootR: Vector3 | undefined;
  readonly legs: readonly Leg[];
  /** Puts every bone back in its bind pose. */
  readonly restore: () => void;
}

// Tripod A (front-left, mid-right, rear-left) leads; tripod B is half a cycle behind.
const LEG_LAYOUT: readonly { key: LegKey; side: 1 | -1; phase: number; rear: boolean }[] = [
  { key: "frontL", side: -1, phase: 0, rear: false },
  { key: "midR", side: 1, phase: 0, rear: false },
  { key: "rearL", side: -1, phase: 0, rear: true },
  { key: "frontR", side: 1, phase: 0.5, rear: false },
  { key: "midL", side: -1, phase: 0.5, rear: false },
  { key: "rearR", side: 1, phase: 0.5, rear: true },
];

/** Builds the rig for one cloned scene, from its bind pose. */
export function buildRig(scene: Object3D): Rig {
  const bones: Bone[] = [];
  scene.traverse((o) => {
    if (o instanceof Bone) bones.push(o);
  });
  const rest = new Map(
    bones.map((b) => [b, { position: b.position.clone(), quaternion: b.quaternion.clone() }]),
  );
  const restore = () => {
    for (const [bone, t] of rest) {
      bone.position.copy(t.position);
      bone.quaternion.copy(t.quaternion);
    }
  };

  const posCache = new Map<Bone, Vector3>();
  const posOf = (b: Bone) => {
    let p = posCache.get(b);
    if (!p) {
      p = modelPos(b, scene);
      posCache.set(b, p);
    }
    return p;
  };
  const inferred = inferBones(bones, posOf);
  const wrap = (bone: Bone | undefined): AnimBone | undefined => {
    if (!bone) return undefined;
    const inv = modelQuat(bone.parent ?? bone, scene).invert();
    return {
      bone,
      rest: bone.quaternion.clone(),
      axisX: new Vector3(1, 0, 0).applyQuaternion(inv).normalize(),
      axisY: new Vector3(0, 1, 0).applyQuaternion(inv).normalize(),
      axisZ: new Vector3(0, 0, 1).applyQuaternion(inv).normalize(),
    };
  };
  const legs: Leg[] = LEG_LAYOUT.map((l) => {
    const found = inferred.legs[l.key];
    return {
      hip: wrap(found?.hip),
      knee: wrap(found?.knee),
      side: l.side,
      phase: l.phase,
      rear: l.rear,
    };
  });
  return {
    head: wrap(inferred.head),
    antennaL: wrap(inferred.antennaL),
    antennaR: wrap(inferred.antennaR),
    wingL: wrap(inferred.wingL),
    wingR: wrap(inferred.wingR),
    wingRootL: inferred.wingL ? posOf(inferred.wingL).clone() : undefined,
    wingRootR: inferred.wingR ? posOf(inferred.wingR).clone() : undefined,
    legs,
    restore,
  };
}

/**
 * The offset that stands the model on its feet, from its bind-pose geometry:
 * x and z centre it, y puts its lowest point at 0. Measured once per cloned
 * scene before any motion, so remounts never sink the model.
 */
export function baseOffset(scene: Object3D): Vector3 {
  const box = new Box3();
  const part = new Box3();
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    o.geometry.computeBoundingBox();
    const bounds = o.geometry.boundingBox;
    if (!bounds) return;
    part.copy(bounds);
    if (o instanceof SkinnedMesh) {
      part.applyMatrix4(o.bindMatrix);
    } else {
      const m = new Matrix4();
      for (let p: Object3D | null = o; p && p !== scene; p = p.parent) {
        p.updateMatrix();
        m.premultiply(p.matrix);
      }
      part.applyMatrix4(m);
    }
    box.union(part);
  });
  if (box.isEmpty()) return new Vector3();
  const c = box.getCenter(new Vector3());
  return new Vector3(-c.x, -box.min.y, -c.z);
}

/* ---- wing cue ------------------------------------------------------------ */

/**
 * The wing's own triangles copied out of the skinned mesh: vertices at least
 * 70% weighted to the wing chain and 0.1 clear of the root sideways, so no
 * thorax comes along. Model space, translated so the wing root is the origin.
 */
function wingCueGeometry(scene: Object3D, wing: Bone, root: Vector3): BufferGeometry | null {
  let out: BufferGeometry | null = null;
  const side = Math.sign(root.x) || 1;
  const v = new Vector3();
  scene.traverse((o) => {
    if (out || !(o instanceof SkinnedMesh)) return;
    const chain = new Set<number>();
    wing.traverse((b) => {
      const i = o.skeleton.bones.indexOf(b as Bone);
      if (i >= 0) chain.add(i);
    });
    if (chain.size === 0) return;
    const g = o.geometry;
    const pos = g.getAttribute("position");
    const skinIndex = g.getAttribute("skinIndex");
    const skinWeight = g.getAttribute("skinWeight");
    if (!pos || !skinIndex || !skinWeight) return;
    const keep = new Uint8Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++)
        if (chain.has(skinIndex.getComponent(i, k))) w += skinWeight.getComponent(i, k);
      v.fromBufferAttribute(pos, i).applyMatrix4(o.bindMatrix);
      keep[i] = w >= 0.7 && side * v.x > Math.abs(root.x) + 0.1 ? 1 : 0;
    }
    const index = g.index;
    const vertexAt = (n: number) => (index ? index.getX(n) : n);
    const count = index ? index.count : pos.count;
    const verts: number[] = [];
    for (let n = 0; n < count; n += 3) {
      const tri = [vertexAt(n), vertexAt(n + 1), vertexAt(n + 2)];
      if (!tri.every((i) => keep[i] === 1)) continue;
      for (const i of tri) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.bindMatrix).sub(root);
        verts.push(v.x, v.y, v.z);
      }
    }
    if (verts.length > 0) {
      out = new BufferGeometry();
      out.setAttribute("position", new Float32BufferAttribute(verts, 3));
    }
  });
  return out;
}

export interface CueLayer {
  readonly pivot: Group;
  readonly material: MeshBasicMaterial;
  /** Fraction of the cue stroke this copy travels. */
  readonly reach: number;
  /** Fraction of the cue opacity. */
  readonly weight: number;
  readonly side: 1 | -1;
}

/** Two translucent copies per wing, pivoting rigidly at the root. */
export function buildWingCue(scene: Object3D, rig: Rig, color: string) {
  const group = new Group();
  const layers: CueLayer[] = [];
  const geometries: BufferGeometry[] = [];
  const wings = [
    [rig.wingL, rig.wingRootL, -1],
    [rig.wingR, rig.wingRootR, 1],
  ] as const;
  for (const [wing, root, side] of wings) {
    const geometry = wing && root ? wingCueGeometry(scene, wing.bone, root) : null;
    if (!geometry || !root) continue;
    geometries.push(geometry);
    for (const [reach, weight] of [
      [0.55, 0.7],
      [1, 1],
    ] as const) {
      const material = new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
      });
      const pivot = new Group();
      pivot.position.copy(root);
      pivot.add(new Mesh(geometry, material));
      pivot.visible = false;
      group.add(pivot);
      layers.push({ pivot, material, reach, weight, side });
    }
  }
  const dispose = () => {
    for (const l of layers) l.material.dispose();
    for (const g of geometries) g.dispose();
  };
  return { group, layers, dispose };
}

/* ---- motion math --------------------------------------------------------- */

const TMP_Q = new Quaternion();
export const TAU = Math.PI * 2;
export const deg = MathUtils.degToRad;
export const clamp01 = (x: number) => MathUtils.clamp(x, 0, 1);
export const frac = (x: number) => x - Math.floor(x);
const smootherstep = (p: number) => p * p * p * (p * (p * 6 - 15) + 10);
/** Smootherstep clamped to 0..1: zero velocity and acceleration at both ends. */
export const ease = (p: number) => smootherstep(clamp01(p));

/** Progress through one half-cycle: holds at 0 for `dwell`, then eases to 1. */
export const stepEase = (h: number, dwell: number) => ease((h - dwell) / Math.max(1 - dwell, 1e-3));

/** Servo wave over one cycle, -1..1, with eased reversals and a pause at each end. */
export function servo(p: number, dwell: number): number {
  const c = frac(p);
  const e = stepEase(frac(c * 2), dwell);
  return c < 0.5 ? 2 * e - 1 : 1 - 2 * e;
}

/** Raise, hold, lower over the leg's forward swing; 0 while planted. */
export function swingLift(p: number, dwell: number): number {
  const c = frac(p);
  if (c >= 0.5) return 0;
  const q = (c * 2 - dwell) / Math.max(1 - dwell, 1e-3);
  return ease(q / 0.3) * (1 - ease((q - 0.7) / 0.3));
}

/** A 0..1 ramp with eased output and separate up and down durations. */
export class Ramp {
  p = 0;
  step(target: boolean, dt: number, up: number, down: number): number {
    const dur = target ? up : down;
    this.p = clamp01(this.p + ((target ? 1 : -1) * dt) / Math.max(dur, 1e-3));
    return smootherstep(this.p);
  }
}

/** An occasional head turn: ease out to a side, hold, ease back, wait. Returns -1..1. */
export class HeadTurns {
  private seed = 7;
  private start = -1e3;
  private dir = 0;
  private next = 2;
  private rand() {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }
  value(t: number, c: typeof ANIM_CONFIG.idle): number {
    const d = Math.max(c.headTurnSec, 1e-3);
    if (t >= this.next) {
      this.start = t;
      this.dir = (this.rand() < 0.5 ? -1 : 1) * (0.6 + 0.4 * this.rand());
      const [a, b] = c.headGapSec;
      this.next = t + 2 * d + c.headHoldSec + a + (b - a) * this.rand();
    }
    const u = t - this.start;
    return this.dir * (ease(u / d) - ease((u - d - c.headHoldSec) / d));
  }
}

/** Rotates a bone from rest by model-space angles (radians) about X, Y and Z. */
export function pose(b: AnimBone | undefined, rx: number, ry: number, rz: number): void {
  if (!b) return;
  b.bone.quaternion.copy(b.rest);
  if (rz) b.bone.quaternion.premultiply(TMP_Q.setFromAxisAngle(b.axisZ, rz));
  if (rx) b.bone.quaternion.premultiply(TMP_Q.setFromAxisAngle(b.axisX, rx));
  if (ry) b.bone.quaternion.premultiply(TMP_Q.setFromAxisAngle(b.axisY, ry));
}
