"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, type WindowJson, tradingApi } from "@/api/client";
import { useWalletSession } from "@/auth/session";
import { useOwnerSession } from "./use-owner-session";
import { schedulePoll } from "./poll";

/** The window re-reads itself this often: the platform records a reading every 15 minutes. */
const POLL_MS = 60_000;

/**
 * The portfolio window (F-U11) for one agent, read with the owner session.
 * Another wallet's data is never shown: a new wallet starts over, and an
 * owner session the API refuses becomes the error the page says.
 */
export function useWindow(agentId: bigint) {
  const wallet = useWalletSession();
  const asOwner = useOwnerSession(agentId);
  const [window_, setWindow] = useState<WindowJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    setWindow(null);
    setError(null);
  }, [wallet.address, agentId]);

  useEffect(() => {
    if (!wallet.ready || !wallet.address) return;
    let live = true;
    void (async () => {
      try {
        const w = await asOwner((t) => tradingApi.window(agentId, t));
        if (!live) return;
        setWindow(w);
        setError(null);
      } catch (err) {
        if (!live) return;
        setError(
          err instanceof ApiError || err instanceof Error
            ? err.message
            : "Could not read the window.",
        );
      }
    })();
    const cancelPoll = schedulePoll(refresh, POLL_MS);
    return () => {
      live = false;
      cancelPoll();
    };
  }, [agentId, asOwner, refresh, tick, wallet.ready, wallet.address]);

  return { window: window_, error, refresh };
}
