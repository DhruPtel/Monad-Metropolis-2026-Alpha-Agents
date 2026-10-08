"use client";

import { useCallback, useEffect, useRef } from "react";
import { ApiError, type OwnerSession, api } from "@/api/client";
import { useWalletSession } from "@/auth/session";

/**
 * The owner session for one agent (D-218), shared by its My Agents card and
 * its portfolio (P2-U7): made from the wallet's login, reused until 30 seconds
 * before it expires, renewed once when the API calls it stale or invalid, and
 * dropped when the wallet's account changes, since a session belongs to one
 * address (L-95). The API rechecks ownership on chain on every call.
 */
export function useOwnerSession(agentId: bigint) {
  const wallet = useWalletSession();
  const session = useRef<OwnerSession | null>(null);

  useEffect(() => {
    session.current = null;
  }, [wallet.address, agentId]);

  const ownerToken = useCallback(async (): Promise<string> => {
    const s = session.current;
    if (s && s.expiresAt - 30 > Date.now() / 1000) return s.token;
    const fresh = await api.ownerSession(agentId, await wallet.getAccessToken());
    session.current = fresh;
    return fresh.token;
  }, [agentId, wallet]);

  /** Runs an owner call; a session the API calls stale or invalid is renewed once. */
  return useCallback(
    async <T>(fn: (token: string) => Promise<T>): Promise<T> => {
      try {
        return await fn(await ownerToken());
      } catch (err) {
        if (
          err instanceof ApiError &&
          (err.code === "session_stale" || err.code === "invalid_token")
        ) {
          session.current = null;
          return fn(await ownerToken());
        }
        throw err;
      }
    },
    [ownerToken],
  );
}
