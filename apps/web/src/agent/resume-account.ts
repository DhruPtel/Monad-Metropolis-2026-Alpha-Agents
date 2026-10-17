import { shortenAddress } from "@alpha-agents/domain";
import type { SentinelJson } from "@/api/client";

/**
 * Resume account (2026-10-17): the words around the owner's unpause() after the
 * sentinel tightened the trading account. Pure, tested without a browser: why the
 * account was tightened (from the sentinel's own record), who may resume it, and
 * what each step of the wallet action says.
 */
export interface PausedBy {
  /** The day the sentinel tightened the account, YYYY-MM-DD. */
  readonly at: string;
  /** The breach in plain words, lower case, no full stop: "the WMON price feed failed". */
  readonly why: string;
}

type SentinelAction = SentinelJson["actions"][number];

const TIGHTENING = new Set(["REDUCE_ONLY", "PAUSE"]);

/** The sentinel's newest tightening of the account that went through, or null. */
export function pausedBySentinel(actions: readonly SentinelAction[]): PausedBy | null {
  const newest = actions
    .filter((a) => TIGHTENING.has(a.action) && a.status === "done")
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!newest) return null;
  return { at: newest.at.slice(0, 10), why: breachWords(newest) };
}

function breachWords(a: SentinelAction): string {
  const tokens = (a.detail as { tokens?: { symbol?: string }[] } | undefined)?.tokens;
  const symbol = tokens?.[0]?.symbol ?? a.reason.split(":")[0]?.trim() ?? "";
  switch (a.code) {
    case "STALE_FEED":
      return `the ${symbol || "held token's"} price feed failed`;
    case "RESCREEN_FAILED":
      return `${symbol || "a held token"} failed its safety re-screen`;
    case "LIQUIDITY_DROP":
      return `${symbol || "a held token"}'s liquidity fell`;
    case "DRAWDOWN_12":
      return "the account fell 12% or more from its 7-day peak";
    case "DRAWDOWN_22":
      return "the account fell 22% or more from its 7-day peak";
    default:
      return a.text || a.reason || "a safety condition fired";
  }
}

/** What the tightened account cannot do until the owner resumes it. */
function modeEffect(mode: string): string {
  return mode === "PAUSED"
    ? "Trading and deposits are blocked until you resume; withdrawals still work."
    : "Buys are blocked until you resume; sells and withdrawals still work.";
}

/**
 * "Paused on 2026-10-15 by the safety monitor: the WMON price feed failed. Buys are
 * blocked until you resume; sells and withdrawals still work."
 */
export function resumeReason(mode: string, paused: PausedBy | null): string {
  const head = paused
    ? `Paused on ${paused.at} by the safety monitor: ${paused.why}.`
    : `The account is ${mode.toLowerCase().replace(/_/g, " ")}.`;
  return `${head} ${modeEffect(mode)}`;
}

/** Why the connected wallet cannot resume the account, or null when it can. */
export function resumeBlocker(i: {
  readonly connected: string | null;
  /** The account's owner, when the page knows it; null leaves ownership to the owner session. */
  readonly owner: string | null;
}): string | null {
  if (!i.connected) return "Connect the wallet that owns this agent to resume its account.";
  if (i.owner && i.owner.toLowerCase() !== i.connected.toLowerCase())
    return `Only the owner wallet (${shortenAddress(i.owner)}) can resume this account; ${shortenAddress(i.connected)} is connected.`;
  return null;
}

/** The wallet action's line per step; other states keep the shared wallet text. */
export function resumeStatusText(state: string, shared: string): string {
  switch (state) {
    case "waiting-wallet":
      return "Confirm in your wallet.";
    case "confirming":
      return "Waiting for the network.";
    case "confirmed":
      return "The account is back to normal. You can turn on automatic trading.";
    default:
      return shared;
  }
}
