"use client";

import { Environment, Html, Lightformer, OrbitControls, useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { Component, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Color, DoubleSide, MathUtils, type ShaderMaterial } from "three";
import { type AnimationControl, AnimatedModel } from "./animated-model";
import type { SceneColors } from "./scene-colors";
import { PLATFORM_RADIUS, PLATFORM_Y } from "./stage";

const IDLE_RESUME_MS = 3000;

/** Small text at the model's position, in the DOM so it stays crisp. */
function SceneNote({ children, tone }: { children: ReactNode; tone: "muted" | "warning" }) {
  return (
    <Html center className="pointer-events-none">
      <span
        className={
          tone === "warning"
            ? "font-mono text-2xs whitespace-nowrap text-warning"
            : "font-mono text-2xs whitespace-nowrap text-foreground-muted"
        }
      >
        {children}
      </span>
    </Html>
  );
}

/** Catches a failed model load so the rest of the scene keeps rendering. Keyed by url. */
class ModelBoundary extends Component<
  { url: string; onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    // Drop the cached rejection so a retry fetches again.
    useGLTF.clear(this.props.url);
    this.props.onError();
  }
  override render() {
    if (this.state.failed) return <SceneNote tone="warning">Failed to load model</SceneNote>;
    return this.props.children;
  }
}

/* The platform: a disc, two grid scales fading to the edge, and a thin accent
   ring with a soft glow that brightens while a slot is highlighted. One shader,
   one draw call. Colors are uniforms set from the design tokens. */
const PLATFORM_VERT = /* glsl */ `
  varying vec2 vPos;
  void main() {
    vPos = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const PLATFORM_FRAG = /* glsl */ `
  uniform vec3 uDisc;
  uniform vec3 uCell;
  uniform vec3 uSection;
  uniform vec3 uAccent;
  uniform float uRadius;
  uniform float uActive;
  varying vec2 vPos;

  float gridLine(vec2 p, float size) {
    vec2 q = p / size;
    vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
    return 1.0 - min(min(g.x, g.y), 1.0);
  }

  void main() {
    float d = length(vPos);
    float inside = 1.0 - smoothstep(uRadius - 0.01, uRadius + 0.01, d);
    float fade = 1.0 - smoothstep(uRadius * 0.3, uRadius * 0.96, d);

    vec3 disc = uDisc;
    disc = mix(disc, uCell, gridLine(vPos, 0.2) * fade * 0.8);
    disc = mix(disc, uSection, gridLine(vPos, 1.0) * fade * 0.9);
    float discA = inside * 0.92;

    float glowW = 0.07 + 0.03 * uActive;
    float glow = exp(-pow((d - uRadius) / glowW, 2.0)) * (0.18 + 0.2 * uActive);
    float ring = 1.0 - smoothstep(0.0, 0.012, abs(d - uRadius) - 0.006);

    float a = 1.0 - (1.0 - discA) * (1.0 - glow);
    vec3 col = (disc * discA + uAccent * glow) / max(a, 1e-4);
    col = mix(col, uAccent, ring);
    a = max(a, ring * 0.95);

    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }
`;

function Platform({ active, colors }: { active: boolean; colors: SceneColors }) {
  const material = useRef<ShaderMaterial>(null);
  const uniforms = useMemo(
    () => ({
      uDisc: { value: new Color(colors.platform) },
      uCell: { value: new Color(colors.grid) },
      uSection: { value: new Color(colors.gridMajor) },
      uAccent: { value: new Color(colors.accent) },
      uRadius: { value: PLATFORM_RADIUS },
      uActive: { value: 0 },
    }),
    [colors],
  );
  useFrame((_, dt) => {
    const u = material.current?.uniforms.uActive;
    if (u) u.value = MathUtils.damp(u.value as number, active ? 1 : 0, 8, dt);
  });
  const size = (PLATFORM_RADIUS + 0.5) * 2;
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, PLATFORM_Y, 0]} renderOrder={1}>
      <planeGeometry args={[size, size]} />
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        vertexShader={PLATFORM_VERT}
        fragmentShader={PLATFORM_FRAG}
        transparent
        depthWrite={false}
        side={DoubleSide}
      />
    </mesh>
  );
}

/** Orbit: rotate and zoom only. Auto-rotate pauses on interaction and resumes after 3 s. */
function IdleControls({ reducedMotion }: { reducedMotion: boolean }) {
  const [auto, setAuto] = useState(true);
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  return (
    <OrbitControls
      makeDefault
      target={[0, -0.2, 0]}
      enablePan={false}
      enableDamping
      dampingFactor={0.08}
      autoRotate={auto && !reducedMotion}
      autoRotateSpeed={0.5}
      minDistance={3.2}
      maxDistance={8}
      minPolarAngle={0.45}
      maxPolarAngle={1.5}
      onStart={() => {
        clear();
        setAuto(false);
      }}
      onEnd={() => {
        clear();
        timer.current = window.setTimeout(() => setAuto(true), IDLE_RESUME_MS);
      }}
    />
  );
}

export interface AgentSceneProps {
  readonly modelUrl: string;
  readonly sockets: readonly string[];
  readonly animation: AnimationControl;
  readonly highlightedSlot: number | null;
  readonly reducedMotion: boolean;
  readonly colors: SceneColors;
  readonly onModelError: () => void;
}

export function AgentScene({
  modelUrl,
  sockets,
  animation,
  highlightedSlot,
  reducedMotion,
  colors,
  onModelError,
}: AgentSceneProps) {
  return (
    <>
      <ambientLight intensity={0.3} />
      <directionalLight position={[3.5, 5, 3]} intensity={2.6} color={colors.keyLight} />
      <directionalLight position={[-4, 1.5, -2.5]} intensity={0.8} color={colors.rimLight} />
      {/* Reflections from a tiny, render-once cube map: no HDR file is fetched. */}
      <Environment resolution={128} frames={1}>
        <Lightformer
          form="rect"
          intensity={1.5}
          position={[0, 6, 0]}
          rotation={[Math.PI / 2, 0, 0]}
          scale={[10, 10, 1]}
          color={colors.fillLight}
        />
        <Lightformer
          form="rect"
          intensity={0.8}
          position={[-6, 2, -3]}
          scale={[3, 8, 1]}
          color={colors.rimLight}
        />
        <Lightformer
          form="rect"
          intensity={0.3}
          position={[6, 0.5, 4]}
          scale={[3, 3, 1]}
          color={colors.accent}
        />
      </Environment>
      <ModelBoundary key={modelUrl} url={modelUrl} onError={onModelError}>
        <Suspense fallback={<SceneNote tone="muted">Loading model</SceneNote>}>
          <AnimatedModel
            url={modelUrl}
            sockets={sockets}
            animation={animation}
            wingColor={colors.wing}
            highlightedSlot={highlightedSlot}
          />
        </Suspense>
      </ModelBoundary>
      <Platform active={highlightedSlot !== null} colors={colors} />
      <IdleControls reducedMotion={reducedMotion} />
    </>
  );
}
