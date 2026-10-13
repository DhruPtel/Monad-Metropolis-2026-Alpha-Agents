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
