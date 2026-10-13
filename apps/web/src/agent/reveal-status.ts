"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { useEffect, useMemo, useState } from "react";
import { parseAbi } from "viem";
import { useWalletSession } from "@/auth/session";
import { agentNftDeployment } from "./agent-nft";
import { chainClient } from "./chain";
import { schedulePoll } from "./poll";

/**
 * UI-FAST: where an unrevealed agent's draw stands onchain, so the reveal
 * moment says what it is really waiting for instead of counting down. AgentNFT
 * reveals in batches: requestReveal asks Pyth Entropy for a number (anyone may
 * call it and pay the fee; the platform's keeper does), Entropy calls back
 * with it, and reveal applies it to the batch. The contract adds no delay of
 * its own; the keeper waits a short window first so agents minted together
 * share one fee (services/orchestrator/src/keeper.ts: 10 s local, 60 s elsewhere).
 */
export const KEEPER_BATCH_WINDOW_SECONDS: Readonly<Record<EnvironmentId, number>> = {
  local: 10,
  base: 10,
  testnet: 60,
  beta: 60,
  canary: 60,
};

/** AgentNFT's reveal state, as its public getters return it. */
export interface RevealChainState {
  readonly nextToReveal: number;
  readonly totalMinted: number;
  readonly sequence: bigint;
  readonly requestedAt: number;
  readonly batchLast: number;
  readonly seedReady: boolean;
}

const REVEAL_ABI = parseAbi([
  "function nextToReveal() view returns (uint16)",
  "function totalMinted() view returns (uint16)",
  "function pendingReveal() view returns (uint64 sequence, uint64 requestedAt, uint16 batchLast, bool seedReady)",
]);

const clock = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(11, 19);

/** The status in words, for one agent; null once the chain has revealed it. */
export function revealStatusWords(
  agentId: bigint,
  s: RevealChainState,
  environment: EnvironmentId,
): string | null {
  const id = Number(agentId);
  if (id < s.nextToReveal) return null;
  if (s.sequence === 0n)
    return `The draw has not been requested yet: the reveal keeper asks Pyth Entropy for randomness about ${KEEPER_BATCH_WINDOW_SECONDS[environment]} seconds after the first unrevealed mint, so agents minted together share one fee.`;
  if (id > s.batchLast)
    return `A draw for agents up to #${s.batchLast} is under way; this agent joins the next request once it finishes.`;
  if (!s.seedReady)
    return `Randomness was requested from Pyth Entropy at ${clock(s.requestedAt)} UTC (request ${s.sequence.toString()}); waiting for the number to arrive, usually within seconds.`;
  return "The random number has arrived; the keeper is applying the draw now.";
}

/**
 * The reveal status for an unrevealed agent, read from AgentNFT every few
 * seconds while `agentId` is set; null when there is nothing to say.
 */
export function useRevealStatus(environment: EnvironmentId, agentId: bigint | null): string | null {
  const wallet = useWalletSession();
  const client = useMemo(() => chainClient(wallet.target), [wallet.target]);
  const deployment = useMemo(() => agentNftDeployment(environment), [environment]);
  const [words, setWords] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (agentId === null || !deployment) {
      setWords(null);
      return;
    }
    let live = true;
    const read = (functionName: "nextToReveal" | "totalMinted") =>
      client.readContract({ address: deployment.address, abi: REVEAL_ABI, functionName });
    void Promise.all([
      read("nextToReveal"),
      read("totalMinted"),
      client.readContract({
        address: deployment.address,
        abi: REVEAL_ABI,
        functionName: "pendingReveal",
      }),
    ]).then(
      ([next, minted, [sequence, requestedAt, batchLast, seedReady]]) => {
        if (!live) return;
        setWords(
          revealStatusWords(
            agentId,
            {
              nextToReveal: Number(next),
              totalMinted: Number(minted),
              sequence,
              requestedAt: Number(requestedAt),
              batchLast: Number(batchLast),
              seedReady,
            },
            environment,
          ),
        );
      },
      () => live && setWords("Could not read the draw's status from the chain; trying again."),
    );
    const cancel = schedulePoll(() => setTick((t) => t + 1), 3_000);
    return () => {
      live = false;
      cancel();
    };
  }, [agentId, client, deployment, environment, tick]);

  return words;
}
