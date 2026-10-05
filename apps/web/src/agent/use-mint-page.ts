"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, type ApiAgent, type Eligibility, api } from "@/api/client";
import { useWalletSession } from "@/auth/session";
import { agentNftDeployment } from "./agent-nft";
import type { WalletMintRead } from "./mint-page-state";
import { type SupplySummary, summarizeSupply } from "./supply";

/** How often the supply is re-read from the API while the mint page is open. */
const SUPPLY_POLL_MS = 5_000;
/** How often the wallet's minted agent is re-read; faster while it awaits its reveal. */
const WALLET_POLL_MS = 10_000;
const REVEAL_POLL_MS = 3_000;

export type SupplyStatus =
  | { readonly status: "not-deployed" | "loading" }
  | { readonly status: "error"; readonly last?: SupplySummary }
  | { readonly status: "ready"; readonly supply: SupplySummary };

/**
 * AgentNFT's supply for the mint page (P1-U10), from the control API's index
 * (P1-U4): one request per refresh instead of 27 contract reads. Re-read every
 * few seconds and whenever `refresh` is called (after a mint or a reveal).
 */
export function useMintSupply(environment: EnvironmentId): SupplyStatus & {
  readonly refresh: () => void;
} {
  const deployment = useMemo(() => agentNftDeployment(environment), [environment]);
  const [state, setState] = useState<SupplyStatus>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!deployment) return;
    let live = true;
    api.supply().then(
      (reading) => live && setState({ status: "ready", supply: summarizeSupply(reading) }),
      () =>
        live &&
        setState((s) => {
          const last = s.status === "ready" ? s.supply : s.status === "error" ? s.last : undefined;
          return { status: "error", ...(last ? { last } : {}) };
        }),
    );
    const timer = window.setTimeout(refresh, SUPPLY_POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [deployment, refresh, tick]);

  if (!deployment) return { status: "not-deployed", refresh };
  return { ...state, refresh };
}

/**
 * Whether the connected wallet can mint, from the control API: its
 * eligibility (allowlisted, not yet minted, supply left), asked on login, on
 * an account or chain change and after a mint; and the agent it minted, from
 * the index, re-read every few seconds while it waits for its reveal.
 */
export function useWalletMint(environment: EnvironmentId): {
  readonly read: WalletMintRead;
  readonly refresh: () => void;
} {
  const wallet = useWalletSession();
  const deployment = useMemo(() => agentNftDeployment(environment), [environment]);
  const address = wallet.ready ? wallet.address : undefined;
  const key = `${address ?? ""}:${wallet.chainId ?? ""}`;
  const getAccessToken = wallet.getAccessToken;

  const [eligibility, setEligibility] = useState<{
    key: string;
    value: Eligibility | { error: ApiError };
  } | null>(null);
  const [agent, setAgent] = useState<{ key: string; value: ApiAgent | null } | null>(null);
  const [tick, setTick] = useState(0);
  const [agentTick, setAgentTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!address || !deployment) return;
    let live = true;
    void (async () => {
      try {
        const value = await api.eligibility(address, await getAccessToken());
        if (live) setEligibility({ key, value });
      } catch (err) {
        const error =
          err instanceof ApiError ? err : new ApiError(0, "error", "Could not check this wallet.");
        // A failed re-check keeps the last good answer for the same wallet.
        if (live) {
          setEligibility((e) =>
            e?.key === key && !("error" in e.value) ? e : { key, value: { error } },
          );
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [address, deployment, getAccessToken, key, tick]);

  const pending = agent?.key === key && agent.value !== null && agent.value.species === 0;
  useEffect(() => {
    if (!address || !deployment) return;
    let live = true;
    api.agents({ minter: address }).then(
      ([first]) => live && setAgent({ key, value: first ?? null }),
      () => live && setAgent((a) => (a?.key === key ? a : { key, value: null })),
    );
    const timer = window.setTimeout(
      () => setAgentTick((t) => t + 1),
      pending ? REVEAL_POLL_MS : WALLET_POLL_MS,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [address, deployment, key, pending, tick, agentTick]);

  if (eligibility?.key !== key || agent?.key !== key) {
    return { read: { status: "loading" }, refresh };
  }
  const e = eligibility.value;
  if ("error" in e) {
    const { status, message } = e.error;
    return {
      read: status === 503 ? { status: "unavailable", message } : { status: "error", message },
      refresh,
    };
  }
  const minted = agent.value ? { id: agent.value.id, species: agent.value.species } : undefined;
  return {
    read: {
      status: "ready",
      hasMinted: e.reason === "already_minted" || minted !== undefined,
      ...(minted ? { agent: minted } : {}),
      reason: e.reason,
      message: e.message,
    },
    refresh,
  };
}
