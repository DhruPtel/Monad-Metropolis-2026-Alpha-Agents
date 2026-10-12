"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { formatAmount } from "@alpha-agents/domain";
import { ContributeCreditsPanel, WalletActionStatus } from "@alpha-agents/ui";
import { useState } from "react";
import type { Address } from "viem";
import { creditsText } from "@/agent/credits-flow";
import { useAddCredits } from "@/agent/use-add-credits";
import { walletTxText } from "@/agent/wallet-tx";

const usdc = (v: bigint) => formatAmount(v, 6, { maxFractionDigits: 6 });

/**
 * "Fund this agent" on the vault page for someone who is not the owner
 * (D-242, P7-U4): one USDC transfer from the connected wallet to the agent's
 * funding address, named plainly as a contribution to its credits, followed
 * until the platform has credited it. The same flow as the owner's "Add
 * credits"; the index records the sender as the contributor.
 */
export function ContributeCreditsSection({
  agentId,
  agentName,
  environment,
  fundingAddress,
  creditsUsdcE6,
  capUsdcE6,
  onCredited,
}: {
  agentId: bigint;
  agentName: string;
  environment: EnvironmentId;
  fundingAddress: Address | null;
  creditsUsdcE6: bigint;
  capUsdcE6: bigint;
  onCredited: () => void;
}) {
  const [amountText, setAmountText] = useState("");
  const c = useAddCredits(agentId, environment, fundingAddress, onCredited);
  if (!c.available) return null;
  const s = c.status;
  const text = s ? (creditsText(s, usdc) ?? walletTxText(s)) : null;
  return (
    <ContributeCreditsPanel
      agentName={agentName}
      creditsUsdcE6={creditsUsdcE6}
      capUsdcE6={capUsdcE6}
      walletUsdcE6={c.walletUsdc}
      amountText={amountText}
      onAmountChange={setAmountText}
      onFund={(amount) => c.add(amount, amountText.trim())}
      disabled={c.busy}
      status={
        s && text ? (
          <WalletActionStatus
            state={s.state === "confirmed" && s.credited === undefined ? "confirming" : s.state}
            text={text}
            hash={s.hash ?? null}
          />
        ) : null
      }
    />
  );
}
