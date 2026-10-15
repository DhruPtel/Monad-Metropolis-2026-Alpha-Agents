"use client";

import { TESTNET_CHAINS } from "@alpha-agents/config";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@alpha-agents/ui";
import { useState } from "react";
import { ApiError, tradingApi } from "@/api/client";
import { useOwnerSession } from "@/agent/use-owner-session";
import { NETWORK_SITES } from "@/network-sites";

type Chain = "base-sepolia" | "arbitrum-sepolia";
const CHAINS: readonly Chain[] = ["base-sepolia", "arbitrum-sepolia"];

/**
 * CO-U1 "Bring to Base / Arbitrum" (Monad testnet site): the platform copies the owner's agent
 * to that chain with the same number, species and tier, to fund and trade there.
 */
export function BringCard({ agentId }: { agentId: bigint }) {
  const asOwner = useOwnerSession(agentId);
  const [busy, setBusy] = useState<Chain | null>(null);
  const [result, setResult] = useState<{ chain: Chain; ok: boolean; text: string } | null>(null);
  const bring = async (chain: Chain) => {
    setBusy(chain);
    setResult(null);
    const name = TESTNET_CHAINS[chain].name;
    try {
      const r = await asOwner((t) => tradingApi.bring(agentId, chain, t));
      setResult({
        chain,
        ok: true,
        text:
          r.status === "already"
            ? `Agent #${r.agentId} is already yours on ${name}.`
            : `Agent #${r.agentId} is now yours on ${name}.`,
      });
    } catch (err) {
      setResult({
        chain,
        ok: false,
        text:
          err instanceof ApiError || err instanceof Error
            ? err.message
            : `Could not bring the agent to ${name}.`,
      });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card data-testid="bring-card">
      <CardHeader>
        <CardTitle>Bring this agent to another network</CardTitle>
        <CardDescription>
          The same agent, number and species on Base Sepolia or Arbitrum Sepolia, with its own
          account to fund and trade there. Nothing moves between networks.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        {CHAINS.map((chain) => (
          <Button
            key={chain}
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void bring(chain)}
          >
            {busy === chain ? "Bringing…" : `Bring to ${TESTNET_CHAINS[chain].name.split(" ")[0]}`}
          </Button>
        ))}
        {result ? (
          <p
            role="status"
            className={result.ok ? "text-sm text-foreground" : "text-sm text-negative"}
          >
            {result.text}{" "}
            {result.ok ? (
              <a
                className="text-primary underline-offset-4 hover:underline"
                href={`${NETWORK_SITES[result.chain]}/agents/${agentId.toString()}`}
              >
                Open it there
              </a>
            ) : null}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
