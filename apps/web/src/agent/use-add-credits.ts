"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { addressEntry } from "@alpha-agents/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Address, getAddress } from "viem";
import { api } from "@/api/client";
import { type ContractWrite, useWalletSession } from "@/auth/session";
import { type CreditsProgress, runAddCredits } from "./credits-flow";
import { ERC20_ABI } from "./custody";
import { useWalletTx } from "./use-wallet-tx";

/**
 * Add credits from the app (Phase 2 tuning): the connected wallet's USDC
 * balance from the app's RPC, and one USDC transfer from that wallet to the
 * agent's funding address, followed until the platform has credited it.
 */
export function useAddCredits(
  agentId: bigint,
  environment: EnvironmentId,
  fundingAddress: Address | null,
  onCredited: () => void,
) {
  const wallet = useWalletSession();
  const { client, checkNetwork, waitForReceipt } = useWalletTx(environment);
  const usdc = useMemo(() => {
    const e = addressEntry(environment, "usdc");
    return e.status === "verified" ? (e.address as Address) : null;
  }, [environment]);
  const [walletUsdc, setWalletUsdc] = useState<bigint | null>(null);
  const [status, setStatus] = useState<CreditsProgress | null>(null);
  const [tick, setTick] = useState(0);
  const running = useRef(false);
  const mounted = useRef(true);
  const onCreditedRef = useRef(onCredited);
  onCreditedRef.current = onCredited;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const who = wallet.address;
    if (!usdc || !who) return;
    let live = true;
    void client
      .readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [who] })
      .then((v) => live && setWalletUsdc(v))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, usdc, wallet.address, tick]);

  const add = useCallback(
    (amount: bigint, amountText: string) => {
      if (running.current || !usdc || !fundingAddress) return;
      running.current = true;
      const step = {
        label: `Send ${amountText} USDC to the funding address`,
        call: {
          address: usdc,
          abi: ERC20_ABI,
          functionName: "transfer",
          // Checksummed from lowercase: whatever casing the API sent, viem gets a valid address.
          args: [getAddress(fundingAddress.toLowerCase()), amount],
        } satisfies ContractWrite,
      };
      void runAddCredits(
        {
          checkNetwork,
          send: (c) => wallet.writeContract(c),
          waitForReceipt,
          readCredits: async () => {
            const c = await api.credits(agentId);
            return { credits: BigInt(c.creditsUsdcE6), held: BigInt(c.heldUsdcE6) };
          },
        },
        step,
        amount,
        (p) => {
          if (!mounted.current) return;
          setStatus(p);
          if (p.state === "confirmed" && p.credited !== undefined) onCreditedRef.current();
        },
      ).finally(() => {
        running.current = false;
        if (mounted.current) setTick((t) => t + 1);
      });
    },
    [agentId, checkNetwork, fundingAddress, usdc, waitForReceipt, wallet],
  );

  const busy =
    status !== null &&
    (status.state === "checking" ||
      status.state === "waiting-wallet" ||
      status.state === "confirming");
  return { walletUsdc, status, busy, add, available: usdc !== null && fundingAddress !== null };
}
