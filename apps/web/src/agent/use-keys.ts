"use client";

import { ownerKeyProblem } from "@alpha-agents/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type DataKeysJson, keysApi } from "@/api/client";
import { useWalletSession } from "@/auth/session";
import { useOwnerSession } from "./use-owner-session";

/**
 * The owner's own data keys for an agent (BK-U1): which paid sources have
 * one, saving a key (held in memory only while it is typed, cleared the
 * moment it is saved) and removing one. Every call runs on the owner session.
 */
export type KeysStatus =
  | { readonly state: "idle" }
  | { readonly state: "saving"; readonly provider: string }
  | { readonly state: "saved"; readonly provider: string; readonly hint: string }
  | { readonly state: "removed"; readonly provider: string }
  | { readonly state: "error"; readonly message: string };

const words = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong; try again.";

export function useKeys(agentId: bigint) {
  const wallet = useWalletSession();
  const asOwner = useOwnerSession(agentId);
  const [keys, setKeys] = useState<DataKeysJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<KeysStatus>({ state: "idle" });
  const [tick, setTick] = useState(0);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Another wallet's data is never shown, and a typed key never outlives the account it was typed for.
  useEffect(() => {
    setKeys(null);
    setError(null);
    setDraft("");
    setStatus({ state: "idle" });
  }, [wallet.address, agentId]);

  useEffect(() => {
    if (!wallet.ready || !wallet.address) return;
    let live = true;
    void (async () => {
      try {
        const k = await asOwner((t) => keysApi.list(agentId, t));
        if (live && mounted.current) {
          setKeys(k);
          setError(null);
        }
      } catch (err) {
        if (live && mounted.current) setError(words(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [agentId, asOwner, wallet.ready, wallet.address, tick]);

  const save = useCallback(
    (provider: string) => {
      if (running.current) return;
      const problem = ownerKeyProblem(draft);
      if (problem) {
        setStatus({ state: "error", message: problem });
        return;
      }
      running.current = true;
      setStatus({ state: "saving", provider });
      const key = draft;
      // The key leaves the page's state before the request returns: nothing shows it again.
      setDraft("");
      void (async () => {
        try {
          const saved = await asOwner((t) => keysApi.save(agentId, provider, key, t));
          if (mounted.current) setStatus({ state: "saved", provider, hint: saved.hint ?? "••••" });
        } catch (err) {
          if (mounted.current) setStatus({ state: "error", message: words(err) });
        } finally {
          running.current = false;
          if (mounted.current) setTick((t) => t + 1);
        }
      })();
    },
    [agentId, asOwner, draft],
  );

  const remove = useCallback(
    (provider: string) => {
      if (running.current) return;
      running.current = true;
      void (async () => {
        try {
          await asOwner((t) => keysApi.remove(agentId, provider, t));
          if (mounted.current) setStatus({ state: "removed", provider });
        } catch (err) {
          if (mounted.current) setStatus({ state: "error", message: words(err) });
        } finally {
          running.current = false;
          if (mounted.current) setTick((t) => t + 1);
        }
      })();
    },
    [agentId, asOwner],
  );

  return {
    keys,
    error,
    draft,
    setDraft: useCallback((v: string) => {
      setDraft(v);
      setStatus((s) => (s.state === "error" ? { state: "idle" } : s));
    }, []),
    problem: draft.length === 0 ? null : ownerKeyProblem(draft),
    status,
    busy: status.state === "saving",
    save,
    remove,
    reset: useCallback(() => {
      setDraft("");
      setStatus({ state: "idle" });
    }, []),
  };
}
