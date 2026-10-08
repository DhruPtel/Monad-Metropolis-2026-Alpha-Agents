"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Address, type Hex, parseEventLogs } from "viem";
import { type ApiAgent, api } from "@/api/client";
import { useWalletSession } from "@/auth/session";
import { AGENT_NFT_ABI, type MintClaim, agentNftDeployment } from "./agent-nft";
import { chainClient } from "./chain";
import { type MintProgress, runMint } from "./mint-flow";
import {
  type OwnedAgentView,
  type OwnedAgentsRead,
  ownedAgentsWithChain,
  viemAgentNftReader,
} from "./owned-agents";
import { type Rpc, checkWalletNetwork } from "./network-check";
import { waitForReceiptOnAppNetwork } from "./receipt-watch";
import { StuckNonceError, readNonceReport, stuckNonce } from "./stuck-nonce";

/** How often the wallet's agents are re-read from the API while the page is open. */
const OWNERSHIP_POLL_MS = 5_000;
/** How often an unrevealed agent is checked for its reveal in the index. */
const REVEAL_POLL_MS = 2_000;

export type AgentsStatus = "no-wallet" | "not-deployed" | "loading" | "ready" | "error";

export interface OwnedAgents {
  readonly status: AgentsStatus;
  readonly agents: readonly OwnedAgentView[];
  /**
   * AgentNFT's record that this wallet has minted (P2-EC), read from the chain:
   * a wallet that minted is never offered the mint, even while the index lags.
   */
  readonly hasMinted: boolean;
  readonly refresh: () => void;
}

/**
 * The connected wallet's agents, from the control API's index (P1-U4),
 * completed from the chain where the index lags (P2-EC, owned-agents.ts): an
 * agent minted or revealed after the index's watermark shows as pending, and
 * drops the mark when the index catches up. Re-read on every account or chain
 * change and every few seconds, so an agent that leaves the wallet disappears,
 * and its owner controls with it. If the chain cannot be read, the index alone
 * is shown, as before. Owner-only actions recheck the chain through an owner
 * session; viewing does not.
 */
export function useOwnedAgents(environment: EnvironmentId): OwnedAgents {
  const wallet = useWalletSession();
  const deployment = useMemo(() => agentNftDeployment(environment), [environment]);
  const client = useMemo(() => chainClient(wallet.target), [wallet.target]);
  const [result, setResult] = useState<{
    key: string;
    status: AgentsStatus;
    agents: readonly OwnedAgentView[];
    hasMinted: boolean;
  }>({ key: "", status: "loading", agents: [], hasMinted: false });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const address = wallet.ready ? wallet.address : undefined;
  const key = `${address ?? ""}:${wallet.chainId ?? ""}`;

  useEffect(() => {
    if (!address || !deployment) return;
    let live = true;
    void (async () => {
      let indexed: ApiAgent[];
      try {
        indexed = await api.agents({ owner: address });
      } catch {
        if (live)
          setResult((r) => ({
            key,
            status: "error",
            agents: r.key === key ? r.agents : [],
            hasMinted: r.key === key ? r.hasMinted : false,
          }));
        return;
      }
      let read: OwnedAgentsRead;
      try {
        const supply = await api.supply();
        read = await ownedAgentsWithChain(
          address,
          indexed,
          supply.totalMinted,
          viemAgentNftReader(client, deployment.address),
        );
      } catch {
        // The chain could not be read: the index alone, as before P2-EC.
        read = {
          agents: indexed.map((a) => ({
            ...a,
            pending: a.species === 0 ? "reveal" : null,
            indexed: true,
          })),
          hasMinted: indexed.length > 0,
          indexLagging: false,
        };
      }
      if (live) setResult({ key, status: "ready", agents: read.agents, hasMinted: read.hasMinted });
    })();
    const timer = window.setTimeout(refresh, OWNERSHIP_POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [address, client, deployment, key, refresh, tick]);

  if (!address) return { status: "no-wallet", agents: [], hasMinted: false, refresh };
  if (!deployment) return { status: "not-deployed", agents: [], hasMinted: false, refresh };
  // A result for another wallet or chain is never shown.
  if (result.key !== key) return { status: "loading", agents: [], hasMinted: false, refresh };
  return { status: result.status, agents: result.agents, hasMinted: result.hasMinted, refresh };
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
  // Another wallet's mint is never shown: a new account starts from idle.
  const owner = wallet.address;
  useEffect(() => {
    if (!running.current) setProgress({ state: "idle" });
  }, [owner]);

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
            // On the local fork, a nonce ahead of the fork's is named at once (P2-U1 step 0).
            ...(environment === "local"
              ? {
                  stuckCheck: async () => {
                    const gap = stuckNonce(await readNonceReport(appRpc, address, hash));
                    return gap ? new StuckNonceError(gap) : null;
                  },
                }
              : {}),
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
            // The chain first (P2-EC): the index can lag minutes behind the reveal.
            const onChain = await viemAgentNftReader(client, deployment.address)
              .agent(agentId)
              .then((a) => a.species)
              .catch(() => 0);
            if (onChain !== 0) {
              onChangeRef.current();
              return onChain;
            }
            // The minter's list answers 200, empty until the index has the mint; the
            // single-agent route answers 404 until then, which the browser logs as an error.
            const listed = await api.agents({ minter: address }).catch(() => []);
            const view = listed.find((a) => a.id === agentId);
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
  }, [client, deployment, environment, wallet]);

  const reset = useCallback(() => {
    if (!running.current) setProgress({ state: "idle" });
  }, []);
  return { progress, mint, reset };
}
