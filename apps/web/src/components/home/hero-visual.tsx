"use client";

import { cn } from "@alpha-agents/ui";
import dynamic from "next/dynamic";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { webglAvailable } from "../viewer/agent-stage";

/** 2026-10-14: what the home hero shows on the right: "model" (the 3D graphic) or "logo". */
const HERO_VISUAL: "model" | "logo" = "logo";

const HeroModel = dynamic(() => import("./hero-model"), { ssr: false });

/**
 * 2026-10-14: the hero's right side. The logo renders with the page; with WebGL the 3D
 * graphic loads after it and replaces the logo once on screen. A failure keeps the logo.
 */
export function HeroVisual() {
  const [mode, setMode] = useState<"logo" | "loading" | "model">("logo");
  useEffect(() => {
    if (HERO_VISUAL === "model" && webglAvailable()) setMode("loading");
  }, []);
  const onReady = useCallback(() => setMode("model"), []);
  const onFailure = useCallback(() => setMode("logo"), []);
  return (
    <div className="relative size-full" data-testid="hero-visual" data-mode={mode}>
      <Image
        src="/brand/vivarium-logo.png"
        alt="Vivarium"
        width={512}
        height={512}
        className={cn(
          "size-full object-contain transition-opacity",
          mode === "model" && "opacity-0",
        )}
        priority
      />
      {mode !== "logo" ? <HeroModel onReady={onReady} onFailure={onFailure} /> : null}
    </div>
  );
}
