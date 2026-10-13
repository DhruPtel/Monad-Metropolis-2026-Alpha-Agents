"use client";

import type { AssetRow } from "@alpha-agents/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ActivityJson,
  ApiError,
  type ArmingJson,
  type PortfolioJson,
  type PortfolioV3Json,
  type WindowJson,
  api,
  tradingApi,
} from "@/api/client";
import { useWalletSession } from "@/auth/session";
import { type SummaryView, refundOutcomeText, scanOpen, summaryView } from "./my-agents";
import { positions, v2AssetRows } from "./portfolio";
import { assetRows } from "./portfolio-v3";
import { useOwnerSession } from "./use-owner-session";
import { schedulePoll } from "./poll";

/** The trading account as the card shows it (P2-U7): open or not, and its value. */
export interface TradingSummary {
  readonly hasAccount: boolean;
  /** A-80: what the rest of the allocation bar is called on the fund set. */
  readonly restLabel?: string;
  readonly valueUsdcE6: bigint | null;
  /** USDC's share of the value; null while unknown (Phase 2 tuning). */
  readonly usdcShareBps: number | null;
  readonly mode: PortfolioJson["mode"];
  /** UI-U1: every held token valued, for the card's allocation donut; null without an account. */
  readonly makeup: readonly AssetRow[] | null;
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
  /** UI-U1: the account's performance series for the card's centerpiece; null while unread or without an account. */
  readonly windowView: WindowJson | null;
  /** UI-U1: the agent's arming, for its state on the card; null while unread or without trading. */
  readonly armingState: ArmingJson["state"] | null;
  /** Why the summary could not be read, in plain words; null when it was. */
  readonly error: string | null;
  readonly refund: ActionState;
  readonly scan: ActionState;
  requestRefund(): void;
  requestScan(): void;
  /** Re-reads at once (after credits land). */
  refresh(): void;
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
/** USDC's share of a v3 account's value, in basis points; null while the value is unknown. */
function usdcShareV3(p: PortfolioV3Json): number | null {
  if (p.navUsdcE6 === null) return null;
  const nav = BigInt(p.navUsdcE6);
  if (nav === 0n) return 0;
  const usdc = p.holdings.find((h) => h.token.toLowerCase() === p.contracts.usdc.toLowerCase());
  return usdc ? Number((BigInt(usdc.amountRaw) * 10_000n) / nav) : 0;
}

export function useMyAgent(agentId: bigint): MyAgent {
  const wallet = useWalletSession();
  const [summary, setSummary] = useState<SummaryView | null>(null);
  const [activity, setActivity] = useState<readonly ActivityJson[]>([]);
  const [trading, setTrading] = useState<TradingSummary | null>(null);
  const [windowView, setWindowView] = useState<WindowJson | null>(null);
  const [armingState, setArmingState] = useState<ArmingJson["state"] | null>(null);
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
    setWindowView(null);
    setArmingState(null);
    setError(null);
  }, [wallet.address, agentId]);

  const asOwner = useOwnerSession(agentId);

  const busy = (summary ? scanOpen(summary) : false) || refund.state === "working";
  useEffect(() => {
    if (!wallet.ready) return;
    let live = true;
    void (async () => {
      try {
        const [s, a, p, w, arm] = await Promise.all([
          asOwner((token) => api.summary(agentId, token)),
          api.activity(agentId).catch(() => null),
          asOwner((token) => tradingApi.portfolio(agentId, token)).catch(() => null),
          // UI-U1: the performance line and the arming state for the card's centerpiece.
          asOwner((token) => tradingApi.window(agentId, token)).catch(() => null),
          asOwner((token) => tradingApi.arming(agentId, token)).catch(() => null),
        ]);
        if (!live || !mounted.current) return;
        setSummary(summaryView(s));
        if (a) setActivity(a);
        setWindowView(w && w.account ? w : null);
        setArmingState(arm?.arming.state ?? null);
        setTrading(
          p === null
            ? null
            : p.custody === "v3"
              ? {
                  hasAccount: p.account !== null,
                  valueUsdcE6: p.navUsdcE6 === null ? null : BigInt(p.navUsdcE6),
                  usdcShareBps: usdcShareV3(p),
                  mode: p.mode,
                  restLabel: "Other tokens",
                  makeup: p.account === null ? null : assetRows(p),
                }
              : {
                  hasAccount: p.account !== null,
                  valueUsdcE6: positions(p).totalUsdc,
                  usdcShareBps: positions(p).usdcShareBps,
                  mode: p.mode,
                  makeup: p.account === null ? null : v2AssetRows(p),
                },
        );
        setError(null);
      } catch (err) {
        if (live && mounted.current) setError(words(err));
      }
    })();
    const cancelPoll = schedulePoll(() => setTick((t) => t + 1), busy ? BUSY_POLL_MS : POLL_MS);
    return () => {
      live = false;
      cancelPoll();
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
    setScan({ state: "working", message: "Asking for a research run." });
    void (async () => {
      try {
        await asOwner((token) => api.requestScan(agentId, token));
        setScan({
          state: "done",
          message:
            "Research requested. Its activity entry appears here when it ends, in about a minute.",
        });
        setTick((t) => t + 1);
      } catch (err) {
        setScan({ state: "error", message: words(err) });
      }
    })();
  }, [agentId, asOwner, scan.state]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return {
    summary,
    activity,
    trading,
    windowView,
    armingState,
    error,
    refund,
    scan,
    requestRefund,
    requestScan,
    refresh,
  };
}
