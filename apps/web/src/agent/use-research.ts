"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type ResearchJson, type TerminalEventJson, tradingApi } from "@/api/client";
import { useWalletSession } from "@/auth/session";
import { useOwnerSession } from "./use-owner-session";

/** The Research page re-reads itself this often: fast while a cycle is open, rarely otherwise. */
const OPEN_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;

/**
 * The research loop as the owner reads it (P3-U10), read with the owner
 * session. Another wallet's data is never shown: a new wallet starts over.
 */
export function useResearch(agentId: bigint) {
  const wallet = useWalletSession();
  const asOwner = useOwnerSession(agentId);
  const [research, setResearch] = useState<ResearchJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    setResearch(null);
    setError(null);
  }, [wallet.address, agentId]);

  useEffect(() => {
    if (!wallet.ready || !wallet.address) return;
    let live = true;
    void (async () => {
      try {
        const r = await asOwner((t) => tradingApi.research(agentId, t));
        if (!live) return;
        setResearch(r);
        setError(null);
      } catch (err) {
        if (!live) return;
        setError(
          err instanceof ApiError || err instanceof Error
            ? err.message
            : "Could not read the research.",
        );
      }
    })();
    const timer = window.setTimeout(refresh, research?.open ? OPEN_POLL_MS : IDLE_POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [agentId, asOwner, refresh, tick, wallet.ready, wallet.address, research?.open]);

  const pause = useCallback(
    async (paused: boolean) => {
      await asOwner((t) => tradingApi.pauseResearch(agentId, t, paused));
      refresh();
    },
    [agentId, asOwner, refresh],
  );

  return { research, error, refresh, pause };
}

export type TerminalFeedState = "connecting" | "live" | "ended" | "reconnecting" | "idle";

/** The terminal asks for new lines this often while the cycle runs, and backs off while reconnecting. */
const LIVE_POLL_MS = 2_000;
const ENDED_POLL_MS = 15_000;
const RETRY_MS = [2_000, 4_000, 8_000];

/**
 * The agent terminal's feed (P3-U10): reads the cycle's lines from the last
 * sequence it has, so a dropped read resumes where it left off, never
 * repeating or skipping a line. `cycleId` pins one cycle; without it the
 * open cycle is followed, else the newest.
 */
export function useTerminal(agentId: bigint, cycleId: string | null = null, enabled = true) {
  const wallet = useWalletSession();
  const asOwner = useOwnerSession(agentId);
  const [lines, setLines] = useState<TerminalEventJson[]>([]);
  const [cycle, setCycle] = useState<{ cycleId: string; kind: string; status: string } | null>(
    null,
  );
  const [state, setState] = useState<TerminalFeedState>("connecting");
  const [tick, setTick] = useState(0);
  const failures = useRef(0);
  const last = useRef(0);
  const following = useRef<string | null>(null);

  useEffect(() => {
    setLines([]);
    setCycle(null);
    setState("connecting");
    failures.current = 0;
    last.current = 0;
    following.current = null;
  }, [wallet.address, agentId, cycleId]);

  useEffect(() => {
    if (!enabled || !wallet.ready || !wallet.address) return;
    let live = true;
    let delay = LIVE_POLL_MS;
    void (async () => {
      try {
        const r = await asOwner((t) =>
          tradingApi.terminal(agentId, t, { cycleId, after: last.current }),
        );
        if (!live) return;
        failures.current = 0;
        if (!r.cycle) {
          setState("idle");
          delay = ENDED_POLL_MS;
          return;
        }
        // A new cycle replaces the lines of the one followed before.
        if (following.current !== null && following.current !== r.cycle.cycleId) {
          last.current = 0;
          setLines([]);
          if (r.events[0]?.seq !== 1) {
            delay = 0;
            return;
          }
        }
        following.current = r.cycle.cycleId;
        setCycle(r.cycle);
        if (r.events.length > 0) {
          last.current = r.events[r.events.length - 1]?.seq ?? last.current;
          setLines((prev) => [...prev, ...r.events.filter((e) => e.seq > (prev.at(-1)?.seq ?? 0))]);
        }
        setState(r.live ? "live" : "ended");
        delay = r.live ? LIVE_POLL_MS : ENDED_POLL_MS;
      } catch {
        if (!live) return;
        failures.current += 1;
        setState("reconnecting");
        delay = RETRY_MS[Math.min(failures.current, RETRY_MS.length) - 1] ?? 8_000;
      } finally {
        if (live) window.setTimeout(() => setTick((n) => n + 1), delay);
      }
    })();
    return () => {
      live = false;
    };
  }, [agentId, asOwner, cycleId, enabled, tick, wallet.ready, wallet.address]);

  return { lines, cycle, state, last: last.current };
}
