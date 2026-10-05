"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Address, type Hex, parseEventLogs } from "viem";
import { api } from "@/api/client";
import { useWalletSession } from "@/auth/session";
import { AGENT_NFT_ABI, type MintClaim, agentNftDeployment } from "./agent-nft";
import { type AgentView, chainClient } from "./chain";
import { type MintProgress, runMint } from "./mint-flow";
import { type Rpc, checkWalletNetwork } from "./network-check";
import { waitForReceiptOnAppNetwork } from "./receipt-watch";

/** How often the wallet's agents are re-read from the API while the page is open. */
const OWNERSHIP_POLL_MS = 5_000;
/** How often an unrevealed agent is checked for its reveal in the index. */
const REVEAL_POLL_MS = 2_000;

export type AgentsStatus = "no-wallet" | "not-deployed" | "loading" | "ready" | "error";

export interface OwnedAgents {
  readonly status: AgentsStatus;
  readonly agents: readonly AgentView[];
  readonly refresh: () => void;
}

/**
 * The connected wallet's agents, from the control API's index (P1-U4). Re-read
 * on every account or chain change and every few seconds, so an agent that
 * leaves the wallet disappears, and its owner controls with it. Owner-only
 * actions recheck the chain through an owner session; viewing does not.
 */
export function useOwnedAgents(environment: EnvironmentId): OwnedAgents {
  const wallet = useWalletSession();
  const deployment = useMemo(() => agentNftDeployment(environment), [environment]);
  const [result, setResult] = useState<{ key: string; status: AgentsStatus; agents: AgentView[] }>({
    key: "",
    status: "loading",
    agents: [],
  });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const address = wallet.ready ? wallet.address : undefined;
  const key = `${address ?? ""}:${wallet.chainId ?? ""}`;

  useEffect(() => {
    if (!address || !deployment) return;
    let live = true;
    api.agents({ owner: address }).then(
      (agents) => live && setResult({ key, status: "ready", agents }),
      () =>
        live && setResult((r) => ({ key, status: "error", agents: r.key === key ? r.agents : [] })),
    );
    const timer = window.setTimeout(refresh, OWNERSHIP_POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [address, deployment, key, refresh, tick]);

  if (!address) return { status: "no-wallet", agents: [], refresh };
  if (!deployment) return { status: "not-deployed", agents: [], refresh };
  // A result for another wallet or chain is never shown.
  if (result.key !== key) return { status: "loading", agents: [], refresh };
  return { status: result.status, agents: result.agents, refresh };
}

export interface Mint {
  readonly progress: MintProgress;
  readonly mint: () => void;
  readonly reset: () => void;
}

/**
 * The mint flow (mint-flow.ts) wired to the wallet, the control API's claim
 * endpoint and the chain. The wallet sends the mint straight to the chain; the
 * receipt is read from the app's RPC; the reveal is watched in the index.
 */
export function useMint(environment: EnvironmentId, onChange: () => void): Mint {
  const wallet = useWalletSession();
  const deployment = useMemo(() => agentNftDeployment(environment), [environment]);
  const client = useMemo(() => chainClient(wallet.target), [wallet.target]);
  const [progress, setProgress] = useState<MintProgress>({ state: "idle" });
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const mint = useCallback(() => {
    const address = wallet.address;
    if (running.current || !wallet.ready || !address || !deployment) return;
    running.current = true;
    const appRpc: Rpc = (method, params) => client.request({ method, params } as never);
    void runMint(
      {
        wallet: address,
        checkNetwork: () =>
          checkWalletNetwork({
            wallet: wallet.walletRequest,
            app: appRpc,
            target: wallet.target,
            referenceBlock: deployment.referenceBlock,
            contract: deployment.address,
          }),
        requestClaim: async (forWallet: Address) =>
          api.claim(forWallet, await wallet.getAccessToken()),
        sendMint: (claim: MintClaim) =>
          wallet.writeContract({
            address: deployment.address,
            abi: AGENT_NFT_ABI,
            functionName: "mintWithClaim",
            args: [BigInt(claim.deadline), claim.nonce, claim.signature],
          }),
        waitForMint: async (hash: Hex) => {
          // Waits on the app's RPC, and names a send to another network (L-53).
          await waitForReceiptOnAppNetwork({
            hash,
            app: appRpc,
            wallet: wallet.walletRequest,
            appNetwork: wallet.target.name,
          });
          const receipt = await client.getTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error("the mint transaction reverted");
          const [minted] = parseEventLogs({
            abi: AGENT_NFT_ABI,
            logs: receipt.logs,
            eventName: "AgentMinted",
          });
          if (!minted) throw new Error("the mint emitted no AgentMinted event");
          onChangeRef.current();
          return minted.args.agentId;
        },
        waitForReveal: async (agentId: bigint) => {
          for (;;) {
            if (!mounted.current) throw new Error("left the page");
            const view = await api.agent(agentId).catch(() => null);
            if (view && view.species !== 0) {
              onChangeRef.current();
              return view.species;
            }
            await new Promise((resolve) => window.setTimeout(resolve, REVEAL_POLL_MS));
          }
        },
      },
      (p) => mounted.current && setProgress(p),
    )
      .catch(() => undefined)
      .finally(() => {
        running.current = false;
      });
  }, [client, deployment, wallet]);

  const reset = useCallback(() => {
    if (!running.current) setProgress({ state: "idle" });
  }, []);
  return { progress, mint, reset };
}
