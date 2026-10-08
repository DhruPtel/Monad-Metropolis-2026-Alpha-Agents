"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type ActivityJson, ApiError, api, tradingApi } from "@/api/client";
import { useWalletSession } from "@/auth/session";
import { type SummaryView, refundOutcomeText, scanOpen, summaryView } from "./my-agents";
import { positions } from "./portfolio";
import { useOwnerSession } from "./use-owner-session";

/** The trading account as the card shows it (P2-U7): open or not, and its value. */
export interface TradingSummary {
  readonly hasAccount: boolean;
  readonly valueUsdcE6: bigint | null;
}

/** How often a card re-reads its summary, and how often while a Scan or refund is under way. */
const POLL_MS = 5_000;
const BUSY_POLL_MS = 2_000;
/** A refund is followed for up to two minutes. */
const REFUND_POLLS = 60;

export type ActionState =
  | { readonly state: "idle" }
  | { readonly state: "working"; readonly message: string }
  | { readonly state: "done"; readonly message: string }
  | { readonly state: "error"; readonly message: string };

export interface MyAgent {
  readonly summary: SummaryView | null;
  readonly activity: readonly ActivityJson[];
  /** Null while unread, or where trading accounts are not deployed. */
  readonly trading: TradingSummary | null;
  /** Why the summary could not be read, in plain words; null when it was. */
  readonly error: string | null;
  readonly refund: ActionState;
  readonly scan: ActionState;
  requestRefund(): void;
  requestScan(): void;
}

const words = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong; try again.";

/**
 * One owned agent's live state for its My Agents card (D-218). It holds an
 * owner session for the agent, made from the wallet's login and renewed when
 * it expires or the API calls it stale, and re-reads the owner-only summary
 * and the activity feed on a timer. The two owner actions run through the
 * same session, so the API rechecks ownership on chain for each.
 */
export function useMyAgent(agentId: bigint): MyAgent {
  const wallet = useWalletSession();
  const [summary, setSummary] = useState<SummaryView | null>(null);
  const [activity, setActivity] = useState<readonly ActivityJson[]>([]);
  const [trading, setTrading] = useState<TradingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refund, setRefund] = useState<ActionState>({ state: "idle" });
  const [scan, setScan] = useState<ActionState>({ state: "idle" });
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A session belongs to one wallet: a new account starts over.
  useEffect(() => {
    setSummary(null);
    setTrading(null);
    setError(null);
  }, [wallet.address, agentId]);

  const asOwner = useOwnerSession(agentId);

  const busy = (summary ? scanOpen(summary) : false) || refund.state === "working";
  useEffect(() => {
    if (!wallet.ready) return;
    let live = true;
    void (async () => {
      try {
        const [s, a, p] = await Promise.all([
          asOwner((token) => api.summary(agentId, token)),
          api.activity(agentId).catch(() => null),
          asOwner((token) => tradingApi.portfolio(agentId, token)).catch(() => null),
        ]);
        if (!live || !mounted.current) return;
        setSummary(summaryView(s));
        if (a) setActivity(a);
        setTrading(
          p ? { hasAccount: p.account !== null, valueUsdcE6: positions(p).totalUsdc } : null,
        );
        setError(null);
      } catch (err) {
        if (live && mounted.current) setError(words(err));
      }
    })();
    const timer = window.setTimeout(() => setTick((t) => t + 1), busy ? BUSY_POLL_MS : POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [agentId, asOwner, busy, tick, wallet.ready]);

  const requestRefund = useCallback(() => {
    if (refund.state === "working") return;
    setRefund({ state: "working", message: "Asking for the refund." });
    void (async () => {
      try {
        const refundId = await asOwner((token) => api.requestRefund(agentId, token));
        setRefund({
          state: "working",
          message: "Refund requested: sending the USDC to your wallet.",
        });
        for (let i = 0; i < REFUND_POLLS && mounted.current; i += 1) {
          await new Promise((r) => window.setTimeout(r, BUSY_POLL_MS));
          const outcome = refundOutcomeText(await api.refund(agentId, refundId));
          if (outcome) {
            setRefund({ state: outcome.ok ? "done" : "error", message: outcome.text });
            setTick((t) => t + 1);
            return;
          }
        }
        setRefund({
          state: "done",
          message: "The refund is still on its way; your balance updates when it lands.",
        });
      } catch (err) {
        setRefund({ state: "error", message: words(err) });
      }
    })();
  }, [agentId, asOwner, refund.state]);

  const requestScan = useCallback(() => {
    if (scan.state === "working") return;
    setScan({ state: "working", message: "Asking for a Scan." });
    void (async () => {
      try {
        await asOwner((token) => api.requestScan(agentId, token));
        setScan({
          state: "done",
          message:
            "Scan requested. Its activity entry appears here when it ends, in about a minute.",
        });
        setTick((t) => t + 1);
      } catch (err) {
        setScan({ state: "error", message: words(err) });
      }
    })();
  }, [agentId, asOwner, scan.state]);

  return { summary, activity, trading, error, refund, scan, requestRefund, requestScan };
}
