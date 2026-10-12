import type { EnvironmentId } from "@alpha-agents/config";
import { useCallback, useEffect, useState } from "react";

/**
 * UI-U2: whether the owner has seen an agent's reveal, kept in this browser,
 * so the result stays hidden until they click Reveal once and never again
 * after. Storage may be blocked (a private window): then the reveal shows
 * each time the page loads, and nothing else changes.
 */
export const revealSeenKey = (environment: EnvironmentId, agentId: bigint): string =>
  `aa:reveal-seen:${environment}:${agentId.toString()}`;

export interface SeenStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const storage = (): SeenStore | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export function readRevealSeen(key: string, store: SeenStore | null = storage()): boolean {
  try {
    return store?.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeRevealSeen(key: string, store: SeenStore | null = storage()): void {
  try {
    store?.setItem(key, "1");
  } catch {
    // Storage blocked: the moment plays again next time, which costs nothing.
  }
}

/**
 * The seen flag for an agent, read after mount (the server render never
 * knows it), and a setter that stores it. Until read, the flag is true, so a
 * revealed agent never flashes the Reveal prompt before its stored answer.
 */
export function useRevealSeen(
  environment: EnvironmentId,
  agentId: bigint,
): { seen: boolean; markSeen: () => void } {
  const key = revealSeenKey(environment, agentId);
  const [seen, setSeen] = useState(true);
  useEffect(() => {
    setSeen(readRevealSeen(key));
  }, [key]);
  const markSeen = useCallback(() => {
    writeRevealSeen(key);
    setSeen(true);
  }, [key]);
  return { seen, markSeen };
}

/**
 * How long the reveal keeper usually takes after a mint, per environment:
 * its batch window plus a couple of blocks (services/orchestrator/src/keeper.ts).
 */
export const REVEAL_ETA_SECONDS: Readonly<Record<EnvironmentId, number>> = {
  local: 15,
  testnet: 90,
  beta: 90,
  canary: 90,
};

/** Seconds left of a window that starts when `active` turns on, ticking once a second, never below 0. */
export function useCountdown(totalSeconds: number, active: boolean): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!active) {
      setLeft(null);
      return;
    }
    const startedAt = Date.now();
    setLeft(totalSeconds);
    const t = window.setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1_000;
      setLeft(Math.max(0, Math.ceil(totalSeconds - elapsed)));
    }, 1_000);
    return () => window.clearInterval(t);
  }, [active, totalSeconds]);
  return left;
}
