"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { formatAmount } from "@alpha-agents/domain";
import { AddCreditsPanel, WalletActionStatus } from "@alpha-agents/ui";
import { useState } from "react";
import type { Address } from "viem";
import { creditsText } from "@/agent/credits-flow";
import { useAddCredits } from "@/agent/use-add-credits";
import { walletTxText } from "@/agent/wallet-tx";

const usdc = (v: bigint) => formatAmount(v, 6, { maxFractionDigits: 6 });

/**
 * "Add credits" on an agent's card and its portfolio (Phase 2 tuning): the
 * owner enters an amount and the wallet sends it to the funding address in one
 * transaction; the line under it says where it is until the platform has
 * credited it. The funding address, its copy button and QR code stay in "Fund
 * your agent" for sending from elsewhere.
 */
export function AddCreditsSection({
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
    <AddCreditsPanel
      agentName={agentName}
      creditsUsdcE6={creditsUsdcE6}
      capUsdcE6={capUsdcE6}
      walletUsdcE6={c.walletUsdc}
      amountText={amountText}
      onAmountChange={setAmountText}
      onAdd={(amount) => c.add(amount, amountText.trim())}
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
