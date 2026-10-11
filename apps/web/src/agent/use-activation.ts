"use client";

import { useEffect, useState } from "react";
import { type ActivationStatusJson, tradingApi } from "@/api/client";
import { useWalletSession } from "@/auth/session";
import { useOwnerSession } from "./use-owner-session";

/** How often /configure asks after the sweep: every few seconds while it runs, rarely otherwise. */
const RUNNING_POLL_MS = 3_000;
const IDLE_POLL_MS = 20_000;

/**
 * The activation sweep's status for the agent viewer (F-U10): read with the
 * owner session, so the bee can take off while the sweep runs and land when
 * it ends, and a species shown in 2D can pulse. Null while unknown, where
 * the orchestrator is not reachable, or for an agent the wallet does not own.
 */
export function useActivationStatus(agentId: bigint | null): ActivationStatusJson | null {
  const wallet = useWalletSession();
  const asOwner = useOwnerSession(agentId ?? 0n);
  const [status, setStatus] = useState<ActivationStatusJson | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => setStatus(null), [agentId, wallet.address]);
  useEffect(() => {
    if (agentId === null || !wallet.ready || !wallet.address) return;
    let live = true;
    void (async () => {
      try {
        const read = await asOwner((t) => tradingApi.activation(agentId, t));
        if (live) setStatus(read.available ? (read.activation?.status ?? null) : null);
      } catch {
        if (live) setStatus(null);
      }
    })();
    const timer = window.setTimeout(
      () => setTick((n) => n + 1),
      status === "running" ? RUNNING_POLL_MS : IDLE_POLL_MS,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [agentId, asOwner, status, tick, wallet.ready, wallet.address]);
  return agentId === null ? null : status;
}
