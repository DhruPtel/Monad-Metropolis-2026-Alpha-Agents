"use client";

import { Center, OrbitControls, useGLTF } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { Component, type ReactNode, Suspense, useEffect } from "react";
import { NeutralToneMapping, PMREMGenerator } from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export const HERO_MODEL_URL = "/models/home/homegraphic.glb";

export interface HeroModelProps {
  /** The model is on screen: the logo underneath can go. */
  readonly onReady: () => void;
  /** WebGL was lost or the model failed to load: keep the logo. */
  readonly onFailure: () => void;
}

/** Catches a failed model load; the logo stays through onError. */
class ModelBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    useGLTF.clear(HERO_MODEL_URL);
    this.props.onError();
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

function Model({ onReady }: { onReady: () => void }) {
  // drei decodes the meshopt-compressed file itself.
  const { scene } = useGLTF(HERO_MODEL_URL);
  useEffect(onReady, [onReady]);
  return (
    <Center>
      <primitive object={scene} />
    </Center>
  );
}

/** A neutral studio environment: the model's metal reflects it instead of rendering black. */
function RoomLight() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 1.4;
    return () => {
      scene.environment = null;
      env.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
}

/**
 * 2026-10-14: the home hero's 3D graphic. Imported only with next/dynamic and ssr: false
 * (hero-visual.tsx), so three loads after the page renders. It sits still; drag rotates it
 * slowly and it eases to a stop. No zoom or pan.
 */
export default function HeroModel({ onReady, onFailure }: HeroModelProps) {
  // R3F sets its wrapper's position inline, so the wrapper is placed by this div. It spans the
  // whole hero slot (the box it sits in is the slot's middle two thirds), so the frame's corners
  // can reach the outer dashed circle.
  return (
    <div className="absolute -inset-1/4">
      <Canvas
        data-testid="hero-canvas"
        dpr={[1, 2]}
        camera={{ position: [0, 1.15, 4.37], fov: 35, near: 0.1, far: 30 }}
        gl={{ antialias: true, alpha: true, toneMapping: NeutralToneMapping }}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener("webglcontextlost", onFailure, { once: true });
        }}
      >
        <RoomLight />
        <ambientLight intensity={1.1} />
        <directionalLight position={[3, 4, 3]} intensity={0.5} />
        <ModelBoundary onError={onFailure}>
          <Suspense fallback={null}>
            <Model onReady={onReady} />
          </Suspense>
        </ModelBoundary>
        <OrbitControls
          enableZoom={false}
          enablePan={false}
          enableDamping
          dampingFactor={0.06}
          rotateSpeed={0.33}
        />
      </Canvas>
    </div>
  );
}
