"use client";

import { Html, useGLTF } from "@react-three/drei";
import { createPortal, useFrame } from "@react-three/fiber";
import { SlotHex } from "@alpha-agents/ui";
import { useEffect, useMemo, useRef } from "react";
import { type Group, MathUtils, type Object3D } from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import {
  ANIM_CONFIG,
  type AnimState,
  HeadTurns,
  Ramp,
  TAU,
  baseOffset,
  buildRig,
  buildWingCue,
  clamp01,
  deg,
  ease,
  frac,
  pose,
  servo,
  stepEase,
  swingLift,
} from "./rig";
import { PLATFORM_Y } from "./stage";

export interface AnimationControl {
  /** Each new value plays the select sequence from the start; null plays nothing. */
  readonly sequenceKey: string | null;
  /** Off settles the model grounded at centre with no motion. */
  readonly enabled: boolean;
  readonly onStateChange?: ((state: AnimState) => void) | undefined;
}

interface AnimatedModelProps {
  readonly url: string;
  /** Socket node names in slot order; a slot marker rides each. */
  readonly sockets: readonly string[];
  readonly animation: AnimationControl;
  readonly wingColor: string;
  readonly highlightedSlot: number | null;
}

type SeqPhase = "approach" | "settle" | "idle";

/**
 * One agent model: loaded once by drei (meshopt decoded locally, never Draco
 * from a CDN), then cloned for this viewer so two viewers never share a
 * skeleton. The select sequence walks it in, settles, lifts off and hovers.
 * A slot marker is portaled into each named socket, so it moves with the bone
 * the socket hangs from as the model walks, hovers and the camera orbits.
 */
export function AnimatedModel({
  url,
  sockets,
  animation,
  wingColor,
  highlightedSlot,
}: AnimatedModelProps) {
  const { scene: shared } = useGLTF(url, false, true);
  const scene = useMemo(() => cloneSkinned(shared), [shared]);
  const rig = useMemo(() => buildRig(scene), [scene]);
  const base = useMemo(() => baseOffset(scene), [scene]);
  const cue = useMemo(() => buildWingCue(scene, rig, wingColor), [scene, rig, wingColor]);
  const socketNodes = useMemo(
    () => sockets.map((name) => scene.getObjectByName(name) ?? null),
    [scene, sockets],
  );
  useEffect(() => rig.restore, [rig]);
  useEffect(() => cue.dispose, [cue]);

  const liftRef = useRef<Group>(null);
  const bodyRef = useRef<Group>(null);
  const control = useRef(animation);
  control.current = animation;
  const ramps = useRef({
    enable: new Ramp(),
    flap: new Ramp(),
    lift: new Ramp(),
    idle: new Ramp(),
  });
  const seq = useRef({
    phase: "idle" as SeqPhase,
    t: 0,
    pending: false,
    key: null as string | null,
    flyArmed: false,
    fly: false,
    seqT: 0,
    gait: 0,
    gaitAmp: 0,
    travel: 1,
  });
  const headTurns = useRef(new HeadTurns());
  const lastState = useRef<AnimState | null>(null);
  const flapPhase = useRef(0);

  useFrame((state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const t = state.clock.elapsedTime;
    const { sequenceKey, enabled, onStateChange } = control.current;
    const C = ANIM_CONFIG;
    const W = C.walk;
    const D = clamp01(C.DEFORM_DAMPING);
    const R = ramps.current;
    const S = seq.current;

    if (sequenceKey !== S.key) {
      S.key = sequenceKey;
      S.pending = sequenceKey !== null;
    }
    if (S.pending && enabled) {
      S.pending = false;
      Object.assign(S, { phase: "approach", t: 0, seqT: 0, flyArmed: true, fly: false, travel: 0 });
      R.lift.p = 0;
      R.flap.p = 0;
      R.idle.p = 0;
    }
    if (!enabled && (S.phase !== "idle" || S.flyArmed || S.fly)) {
      Object.assign(S, { phase: "idle", t: 0, flyArmed: false, fly: false });
    }
    if (enabled) {
      S.t += dt;
      S.seqT += dt;
    }

    const hz = W.cycleHz * W.speed;
    const Q = C.sequence;
    const steps = Math.max(1, Math.round(Q.walkSec * hz * 2));
    const walkEnd = steps / (2 * hz);
    if (S.flyArmed && S.seqT >= walkEnd - Q.wingLeadSec) {
      S.flyArmed = false;
      S.fly = true;
    }
    const liftOk = S.fly && S.seqT >= walkEnd + Q.liftDelaySec;
    if (S.phase === "approach") {
      S.gait = S.t * hz;
      if (S.gait * 2 >= steps) {
        S.phase = "settle";
        S.t = 0;
      } else {
        S.travel = (Math.floor(S.gait * 2) + stepEase(frac(S.gait * 2), W.dwell)) / steps;
        S.gaitAmp = ease(S.t / 0.4);
      }
    }
    if (S.phase === "settle") {
      const u = S.t / Math.max(Q.settleSec, 1e-3);
      S.gait = steps / 2;
      S.gaitAmp = 1 - ease(u);
      S.travel = 1;
      if (u >= 1) {
        S.phase = "idle";
        S.t = 0;
      }
    }
    if (S.phase === "idle") {
      const k = 4 / Math.max(Q.returnSec, 1e-3);
      S.gaitAmp = MathUtils.damp(S.gaitAmp, 0, k, dt);
      S.travel = MathUtils.damp(S.travel, 1, k, dt);
    }
    const { gait, gaitAmp, travel } = S;

    const on = R.enable.step(enabled, dt, C.enable.fadeSec, C.enable.fadeSec);
    const wantFly = enabled && S.fly;
    const flapOn = R.flap.step(
      wantFly || R.lift.p > 0.02,
      dt,
      C.wings.spinUpSec,
      C.wings.spinDownSec,
    );
    const lift = R.lift.step(
      wantFly && liftOk && R.flap.p > C.hover.liftAfterFlap,
      dt,
      C.hover.takeoffSec,
      C.hover.landSec,
    );
    const idleW = R.idle.step(S.phase === "idle", dt, C.idle.fadeInSec, 0.3) * on;

    const next: AnimState =
      !wantFly && R.lift.p > 0
        ? "landing"
        : R.lift.p > 0
          ? lift >= 0.98
            ? "hovering"
            : "takingOff"
          : S.phase === "approach"
            ? "walking"
            : S.phase === "settle"
              ? "settling"
              : wantFly
                ? "takingOff"
                : "idle";
    if (next !== lastState.current) {
      lastState.current = next;
      onStateChange?.(next);
    }

    // Legs: a tripod gait on the servo wave. Swing at the knee, lift at the hip.
    const walk = on * gaitAmp * (1 - lift);
    for (const leg of rig.legs) {
      const k = (leg.rear ? W.rearScale : 1) * D;
      const p = gait + leg.phase;
      const x = -deg(W.swingDeg) * servo(p, W.dwell) * walk * k;
      const z =
        leg.side *
        (deg(W.liftDeg) * swingLift(p, W.dwell) * walk + deg(C.hover.tuckHipDeg) * lift) *
        k;
      if (leg.knee) {
        pose(leg.hip, 0, 0, z);
        pose(leg.knee, x, 0, 0);
      } else {
        pose(leg.hip, x, 0, z);
      }
    }

    // Body, rigid: a slight roll per step on the ground, sway in the air.
    const half = gait * 2;
    const stepBump = Math.sin(Math.PI * stepEase(frac(half), W.dwell)) ** 2 * walk;
    const stepSign = Math.floor(half) % 2 === 0 ? 1 : -1;
    if (bodyRef.current) {
      const sway = deg(C.hover.swayDeg) * lift;
      bodyRef.current.rotation.set(
        sway * 0.6 * Math.sin(t * C.hover.swayHz * 0.7 * TAU + 1),
        0,
        deg(W.rollDeg) * stepSign * stepBump + sway * Math.sin(t * C.hover.swayHz * TAU),
      );
    }

    // Head: a nod per step and the occasional turn when idle. Antennae sway.
    pose(
      rig.head,
      deg(W.headNodDeg) * stepBump * D,
      deg(C.idle.headTurnDeg) * headTurns.current.value(t, C.idle) * idleW * D,
      0,
    );
    const as = deg(C.antennae.swayDeg) * on * D;
    const at = t * C.antennae.swayHz * TAU;
    pose(rig.antennaL, as * 0.25 * Math.sin(at * 0.7 + 1.3), 0, as * Math.sin(at));
    pose(rig.antennaR, as * 0.25 * Math.sin(at * 0.7 + 2.1), 0, -as * Math.sin(at + 0.9));

    // Wings: a slow servo beat. The bone stays small; the cue carries the visible stroke.
    flapPhase.current += dt * C.wings.flapHz * flapOn;
    const wL = servo(flapPhase.current, C.wings.dwell);
    const wR = servo(flapPhase.current + C.wings.phaseOffset, C.wings.dwell);
    const flap = deg(C.wings.flapDeg) * flapOn * D;
    pose(rig.wingL, 0, 0, -flap * wL);
    pose(rig.wingR, 0, 0, flap * wR);
    for (const l of cue.layers) {
      const w = l.side < 0 ? wL : wR;
      const opacity = C.wings.cue.opacity * l.weight * flapOn * on * Math.abs(w) ** 1.5;
      l.pivot.visible = opacity > 0.002;
      l.pivot.rotation.z = l.side * deg(C.wings.cue.deg) * l.reach * flapOn * w;
      l.material.opacity = opacity;
    }

    // Travel and lift, absolute: the model walks in along +Z (its facing) and
    // rises from the platform height; nothing accumulates frame to frame.
    if (liftRef.current) {
      const back = Q.distance * (1 - travel);
      const hoverBob = C.hover.bobAmp * Math.sin(t * C.hover.bobHz * TAU) * lift;
      liftRef.current.position.set(0, PLATFORM_Y + C.hover.height * lift + hoverBob, -back);
    }
  });

  return (
    <group ref={liftRef}>
      <group position={[base.x, base.y, base.z]}>
        <group ref={bodyRef}>
          <primitive object={scene} />
          <primitive object={cue.group} />
        </group>
      </group>
      {socketNodes.map((node, i) =>
        node ? (
          <SocketSlot
            key={sockets[i] ?? i}
            node={node}
            index={i}
            highlighted={highlightedSlot === i}
          />
        ) : null,
      )}
    </group>
  );
}

/** A slot marker living inside its socket node, so it follows the bone. */
function SocketSlot({
  node,
  index,
  highlighted,
}: {
  node: Object3D;
  index: number;
  highlighted: boolean;
}) {
  return createPortal(
    <Html center zIndexRange={[20, 0]} className="pointer-events-none">
      <div data-testid={`slot-anchor-${index}`}>
        <SlotHex index={index} state={highlighted ? "highlighted" : "empty"} />
      </div>
    </Html>,
    node,
  );
}
