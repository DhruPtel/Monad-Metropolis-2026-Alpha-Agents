"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import type { ActivityRowView } from "@alpha-agents/ui";
import { useEffect, useState } from "react";
import { type MoneyEventJson, api, tradingApi } from "@/api/client";
import { useWalletSession } from "@/auth/session";
import { activityRows } from "./activity-feed";
import { schedulePoll } from "./poll";
import { reportHref } from "./report-view";
import { txHref } from "./trading-view";
import { useOwnerSession } from "./use-owner-session";

/** How often the Activity panel reads again. */
const ACTIVITY_POLL_MS = 30_000;

/**
 * 2026-10-13: the shared Activity panel's data. Deposits, withdrawals and
 * credit top-ups for anyone; the trades, research runs and approved plans when
 * the connected wallet owns the agent (null otherwise, and the panel says so).
 */
export function useActivity(agentId: bigint, environment: EnvironmentId) {
  const wallet = useWalletSession();
  const asOwner = useOwnerSession(agentId);
  const [rows, setRows] = useState<ActivityRowView[] | null>(null);
  const [owner, setOwner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    let cancel: (() => void) | null = null;
    void (async () => {
      const money = await api
        .moneyEvents(agentId)
        .then((r) => r.events)
        .catch((err: unknown) => {
          if (live) setError(err instanceof Error ? err.message : "Could not read the deposits.");
          return [] as readonly MoneyEventJson[];
        });
      const asOwnerOrNull = <T>(read: (token: string) => Promise<T>) =>
        wallet.ready ? asOwner(read).catch(() => null) : Promise.resolve(null);
      const [intents, research, card] = await Promise.all([
        asOwnerOrNull((t) => tradingApi.intents(agentId, t)),
        asOwnerOrNull((t) => tradingApi.research(agentId, t)),
        asOwnerOrNull((t) => tradingApi.planCard(agentId, t)),
      ]);
      if (!live) return;
      setOwner(intents !== null);
      setRows(
        activityRows({
          money,
          intents,
          cycles: research?.cycles ?? null,
          proposals: card ? [...(card.pending ? [card.pending] : []), ...card.recent] : null,
          txFor: (hash) => txHref(environment, hash),
          reportFor: (cycleId) => reportHref(agentId, cycleId),
        }),
      );
      cancel = schedulePoll(() => setTick((n) => n + 1), ACTIVITY_POLL_MS);
    })();
    return () => {
      live = false;
      cancel?.();
    };
  }, [agentId, asOwner, environment, tick, wallet.ready, wallet.address]);
  return {
    rows,
    error,
    note: owner
      ? null
      : "The agent's trades, research runs and plan approvals show here for its owner.",
  };
}
