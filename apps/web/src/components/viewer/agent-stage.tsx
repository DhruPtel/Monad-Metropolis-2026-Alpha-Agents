"use client";

import { type SpeciesAsset, slotsFor } from "@alpha-agents/domain";
import { Button, SpeciesArt, Tag, ViewerFrame } from "@alpha-agents/ui";
import dynamic from "next/dynamic";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { AnimState } from "./rig";

/** three, React Three Fiber and drei load only here, only on the client. */
const Viewer3D = dynamic(() => import("./viewer-3d"), { ssr: false });

/** True when the browser can create a WebGL context. */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export type StageMode = "checking" | "3d" | "2d" | "no-webgl";

interface AgentStageProps {
  /** The revealed agent's species asset, or null before reveal. */
  readonly asset: SpeciesAsset | null;
  /** Identifies the agent: a new value replays the select sequence. */
  readonly agentKey: string;
  readonly badge?: ReactNode;
  readonly overlay?: ReactNode;
  readonly highlightedSlot?: number | null;
}

/**
 * The agent viewer (P1-U11): the 3D model when the species has one and WebGL
 * works, otherwise the 2D art with the slots on it. Without WebGL it says so,
 * so a GPU failure never hides the agent (FINAL_PLAN 4.10).
 */
export function AgentStage({
  asset,
  agentKey,
  badge,
  overlay,
  highlightedSlot = null,
}: AgentStageProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [webgl, setWebgl] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const [animationOn, setAnimationOn] = useState(true);
  const [replay, setReplay] = useState(0);
  const [animState, setAnimState] = useState<AnimState>("idle");
  useEffect(() => setWebgl(webglAvailable()), []);
  useEffect(() => setAnimationOn(!reducedMotion), [reducedMotion]);
  useEffect(() => setFailed(false), [asset]);
  const onFailure = useCallback(() => setFailed(true), []);

  const model = asset?.model ?? null;
  const slots = asset ? slotsFor(asset.species.tier) : 0;
  const mode: StageMode =
    webgl === null ? "checking" : !model ? "2d" : !webgl || failed ? "no-webgl" : "3d";

  const art = (
    <div className="flex size-full items-center justify-center p-10">
      <SpeciesArt
        image={asset?.image ?? null}
        speciesName={asset?.species.name ?? null}
        tier={asset?.species.tier ?? null}
        slots={slots}
        className="max-w-80"
      />
    </div>
  );

  const toggleAnimation = () => {
    if (!animationOn) setReplay((r) => r + 1);
    setAnimationOn(!animationOn);
  };

  return (
    <ViewerFrame
      label="Agent viewer"
      className="h-full"
      badge={badge}
      overlay={overlay}
      tools={
        mode === "3d" ? (
          <Button
            variant={animationOn ? "secondary-accent" : "secondary"}
            size="sm"
            aria-pressed={animationOn}
            onClick={toggleAnimation}
          >
            Animation {animationOn ? "on" : "off"}
          </Button>
        ) : mode === "no-webgl" ? (
          <Tag tone="warning" size="md">
            3D unavailable: showing the 2D art
          </Tag>
        ) : null
      }
      readoutLeft={asset ? `${asset.species.tier} · ${asset.species.name}` : "unrevealed"}
      readoutRight={
        <span data-testid="stage-mode" data-mode={mode} data-anim={animState}>
          {asset ? `slots 0/${slots}` : "slots after reveal"}
        </span>
      }
    >
      {mode === "3d" && model ? (
        <Viewer3D
          modelUrl={model.path}
          sockets={model.sockets.slice(0, slots)}
          animation={{
            sequenceKey: `${agentKey}:${replay}`,
            enabled: animationOn,
            onStateChange: setAnimState,
          }}
          highlightedSlot={highlightedSlot}
          reducedMotion={reducedMotion}
          onFailure={onFailure}
        />
      ) : mode === "checking" || overlay ? null : (
        // Behind a gate (no wallet, no agent, not yet revealed) the frame stays
        // empty: the gate says what is happening, and no art shows through it.
        art
      )}
    </ViewerFrame>
  );
}
