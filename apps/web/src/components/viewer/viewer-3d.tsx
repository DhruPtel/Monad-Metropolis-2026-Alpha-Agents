"use client";

import { SlotHex } from "@alpha-agents/ui";
import { Canvas } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
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
 *
 * The slot markers and the loading note are ordinary DOM in an overlay this
 * component owns, not drei Html: Html mounts a second React root per element,
 * and unmounting those raced React and threw (L-59). The scene moves each
 * marker to its socket every frame and shows it once placed.
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
  const [loading, setLoading] = useState(true);
  const anchors = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => setColors(readSceneColors()), []);
  if (!colors) return null;
  return (
    <div className="absolute inset-0">
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
          anchors={anchors}
          onLoadingChange={setLoading}
        />
      </Canvas>
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {sockets.map((socket, i) => (
          <div
            key={socket}
            ref={(el) => {
              anchors.current[i] = el;
            }}
            data-testid={`slot-anchor-${i}`}
            className="invisible absolute top-0 left-0"
          >
            <SlotHex index={i} state={highlightedSlot === i ? "highlighted" : "empty"} />
          </div>
        ))}
      </div>
      {loading ? (
        <p className="absolute inset-0 flex items-center justify-center font-mono text-2xs text-foreground-muted">
          Loading model
        </p>
      ) : null}
    </div>
  );
}
