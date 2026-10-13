"use client";

import { useEffect, useState } from "react";
import { ApiError, type ReportJson, type ReportsJson, tradingApi } from "@/api/client";
import { useWalletSession } from "@/auth/session";
import { useOwnerSession } from "./use-owner-session";

const message = (err: unknown, fallback: string) =>
  err instanceof ApiError || err instanceof Error ? err.message : fallback;

/** RP-U1: the agent's report list and links, for its owner; re-read every minute. */
export function useReports(agentId: bigint) {
  const wallet = useWalletSession();
  const asOwner = useOwnerSession(agentId);
  const [reports, setReports] = useState<ReportsJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!wallet.ready || !wallet.address) return;
    let live = true;
    const read = async () => {
      try {
        const r = await asOwner((t) => tradingApi.reports(agentId, t));
        if (live) {
          setReports(r);
          setError(null);
        }
      } catch (err) {
        if (live) setError(message(err, "Could not read the reports."));
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 60_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [agentId, asOwner, wallet.ready, wallet.address]);
  return { reports, error };
}

/** RP-U1: one cycle's report, for its owner. */
export function useReport(agentId: bigint, cycleId: string) {
  const wallet = useWalletSession();
  const asOwner = useOwnerSession(agentId);
  const [report, setReport] = useState<ReportJson["report"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!wallet.ready || !wallet.address) return;
    let live = true;
    void (async () => {
      try {
        const r = await asOwner((t) => tradingApi.report(agentId, cycleId, t));
        if (live) setReport(r.report);
      } catch (err) {
        if (live) setError(message(err, "Could not read the report."));
      }
    })();
    return () => {
      live = false;
    };
  }, [agentId, cycleId, asOwner, wallet.ready, wallet.address]);
  return { report, error, wallet };
}
