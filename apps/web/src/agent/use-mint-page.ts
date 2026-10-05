"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWalletSession } from "@/auth/session";
import { AGENT_NFT_ABI, agentNftDeployment } from "./agent-nft";
import { chainClient, mintedAgent } from "./chain";
import type { WalletMintRead } from "./mint-page-state";
import { type SupplySummary, readSupply, summarizeSupply } from "./supply";

/** How often the supply is re-read while the mint page is open. */
const SUPPLY_POLL_MS = 10_000;
/** How often the wallet's mint is re-read; faster while its agent awaits its reveal. */
const WALLET_POLL_MS = 15_000;
const REVEAL_POLL_MS = 3_000;

export type SupplyStatus =
  | { readonly status: "not-deployed" | "loading" }
  | { readonly status: "error"; readonly last?: SupplySummary }
  | { readonly status: "ready"; readonly supply: SupplySummary };

/**
 * AgentNFT's supply for the mint page (P1-U10), through the app's chain
 * client: the cap, the minted count and the deck per species. Re-read every
 * 10 seconds and whenever `refresh` is called (after a mint or a reveal).
 */
export function useMintSupply(environment: EnvironmentId): SupplyStatus & {
  readonly refresh: () => void;
} {
  const wallet = useWalletSession();
  const deployment = useMemo(() => agentNftDeployment(environment), [environment]);
  const client = useMemo(() => chainClient(wallet.target), [wallet.target]);
  const [state, setState] = useState<SupplyStatus>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!deployment) return;
    let live = true;
    readSupply(client, deployment).then(
      (reading) => live && setState({ status: "ready", supply: summarizeSupply(reading) }),
      () =>
        live &&
        setState((s) => ({
          status: "error",
          ...(s.status === "ready"
            ? { last: s.supply }
            : s.status === "error" && s.last
              ? { last: s.last }
              : {}),
        })),
    );
    const timer = window.setTimeout(refresh, SUPPLY_POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [client, deployment, refresh, tick]);

  if (!deployment) return { status: "not-deployed", refresh };
  return { ...state, refresh };
}

/**
 * Whether the connected wallet has minted (`hasMinted`), and its agent from
 * `AgentMinted`, through the app's chain client. A result for another wallet
 * or chain is never shown; re-read on account or chain change, on `refresh`,
 * and every few seconds while the agent waits for its reveal.
 */
export function useWalletMint(environment: EnvironmentId): {
  readonly read: WalletMintRead;
  readonly refresh: () => void;
} {
  const wallet = useWalletSession();
  const deployment = useMemo(() => agentNftDeployment(environment), [environment]);
  const client = useMemo(() => chainClient(wallet.target), [wallet.target]);
  const [result, setResult] = useState<{ key: string; read: WalletMintRead }>({
    key: "",
    read: { status: "loading" },
  });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const address = wallet.ready ? wallet.address : undefined;
  const key = `${address ?? ""}:${wallet.chainId ?? ""}`;
  const pendingReveal =
    result.key === key &&
    result.read.status === "ready" &&
    result.read.agent !== undefined &&
    result.read.agent.species === 0;

  useEffect(() => {
    if (!address || !deployment) return;
    let live = true;
    (async (): Promise<WalletMintRead> => {
      const hasMinted = await client.readContract({
        address: deployment.address,
        abi: AGENT_NFT_ABI,
        functionName: "hasMinted",
        args: [address],
      });
      if (!hasMinted) return { status: "ready", hasMinted };
      const agent = await mintedAgent(client, deployment, address);
      return { status: "ready", hasMinted, ...(agent ? { agent } : {}) };
    })().then(
      (read) => live && setResult({ key, read }),
      // A failed re-read keeps the last good answer for the same wallet.
      () =>
        live &&
        setResult((r) =>
          r.key === key && r.read.status === "ready" ? r : { key, read: { status: "error" } },
        ),
    );
    const timer = window.setTimeout(refresh, pendingReveal ? REVEAL_POLL_MS : WALLET_POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [address, client, deployment, key, pendingReveal, refresh, tick]);

  if (result.key !== key) return { read: { status: "loading" }, refresh };
  return { read: result.read, refresh };
}
