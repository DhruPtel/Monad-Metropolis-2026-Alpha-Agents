"use client";

import { useEffect, useRef, useState } from "react";
import { type SentinelJson, tradingApi } from "@/api/client";
import { useWalletSession } from "@/auth/session";
import { useOwnerSession } from "./use-owner-session";

/**
 * The sentinel's view of an agent (P4-U2), read with the owner session when
 * `enabled`, and again when `refreshKey` changes. 2026-10-17: the read is keyed
 * on values, never on the owner-session callback, which is remade on every
 * render (the wallet session is not memoized); keyed on it, every re-render
 * cancelled the read in flight, so a read slower than the page's own ticks never
 * landed and the Research tab showed no way to resume the account.
 */
export function useSentinel(
  agentId: bigint,
  enabled: boolean,
  refreshKey = 0,
): SentinelJson | null {
  const wallet = useWalletSession();
  const asOwner = useOwnerSession(agentId);
  const latest = useRef(asOwner);
  latest.current = asOwner;
  const [view, setView] = useState<SentinelJson | null>(null);
  const address = wallet.address ?? null;
  useEffect(() => {
    if (!enabled || !address) {
      setView(null);
      return;
    }
    let live = true;
    void latest
      .current((t) => tradingApi.sentinel(agentId, t))
      .then((v) => {
        if (live) setView(v);
      })
      .catch(() => {
        if (live) setView(null);
      });
    return () => {
      live = false;
    };
  }, [agentId, enabled, refreshKey, address]);
  return view;
}
