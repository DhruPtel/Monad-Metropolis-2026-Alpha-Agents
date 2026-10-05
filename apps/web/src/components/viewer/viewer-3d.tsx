"use client";

import { Canvas } from "@react-three/fiber";
import { useEffect, useState } from "react";
import type { AnimationControl } from "./animated-model";
import { AgentScene } from "./agent-scene";
import { type SceneColors, readSceneColors } from "./scene-colors";

export interface Viewer3DProps {
  readonly modelUrl: string;
  readonly sockets: readonly string[];
  readonly animation: AnimationControl;
  readonly highlightedSlot: number | null;
  readonly reducedMotion: boolean;
  /** WebGL failed at runtime or the model failed to load: show the 2D fallback. */
  readonly onFailure: () => void;
}

/**
 * The 3D canvas. Imported only with next/dynamic and ssr: false (agent-stage.tsx),
 * so three, React Three Fiber and drei load only on routes that show a model.
 */
export default function Viewer3D({
  modelUrl,
  sockets,
  animation,
  highlightedSlot,
  reducedMotion,
  onFailure,
}: Viewer3DProps) {
  const [colors, setColors] = useState<SceneColors | null>(null);
  useEffect(() => setColors(readSceneColors()), []);
  if (!colors) return null;
  return (
    <Canvas
      data-testid="agent-canvas"
      className="absolute inset-0"
      dpr={[1, 2]}
      camera={{ position: [0, 1.9, 5.6], fov: 32, near: 0.1, far: 60 }}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener("webglcontextlost", onFailure, { once: true });
      }}
    >
      <AgentScene
        modelUrl={modelUrl}
        sockets={sockets}
        animation={animation}
        highlightedSlot={highlightedSlot}
        reducedMotion={reducedMotion}
        colors={colors}
        onModelError={onFailure}
      />
    </Canvas>
  );
}
