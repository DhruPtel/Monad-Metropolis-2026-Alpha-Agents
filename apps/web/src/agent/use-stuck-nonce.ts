"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { useEffect, useMemo, useState } from "react";
import { useWalletSession } from "@/auth/session";
import { chainClient } from "./chain";
import type { Rpc } from "./network-check";
import { type StuckNonce, readNonceReport, stuckNonce } from "./stuck-nonce";

/** How often the fork's queue is re-read for the connected wallet. */
const STUCK_POLL_MS = 5_000;

/**
 * Transactions the local fork holds for the connected wallet and will never
 * mine (stuck-nonce.ts), re-read every few seconds; null when there are none,
 * outside the local fork, or before a wallet is connected.
 */
export function useStuckNonce(environment: EnvironmentId): StuckNonce | null {
  const wallet = useWalletSession();
  const client = useMemo(() => chainClient(wallet.target), [wallet.target]);
  const address = wallet.ready ? wallet.address : undefined;
  const [result, setResult] = useState<{ address: string; stuck: StuckNonce | null } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (environment !== "local" || !address) return;
    let live = true;
    const app: Rpc = (method, params) => client.request({ method, params } as never);
    readNonceReport(app, address).then(
      (r) => live && setResult({ address, stuck: stuckNonce(r) }),
      () => live && setResult({ address, stuck: null }),
    );
    const timer = window.setTimeout(() => setTick((t) => t + 1), STUCK_POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [address, client, environment, tick]);

  if (environment !== "local" || !address || result?.address !== address) return null;
  return result.stuck;
}
