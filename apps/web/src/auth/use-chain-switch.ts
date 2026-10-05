"use client";

import type { AppChain } from "@alpha-agents/config";
import { type SwitchStatus, toast } from "@alpha-agents/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { type WalletRequest, phaseText, switchWalletChain } from "./switch-chain";

export interface ChainSwitch {
  /** True while the wallet is being asked. */
  readonly busy: boolean;
  /** Progress, or why the last switch did not happen; cleared once on the target chain. */
  readonly status: SwitchStatus | undefined;
  readonly run: () => void;
}

/**
 * Runs switchWalletChain for a provider and keeps its outcome for the shell
 * (P1-U11): waiting in the wallet, declined, or failed with the reason. A
 * switch that worked shows a toast. Shared by the Privy and mock wallets.
 */
export function useChainSwitch(
  request: WalletRequest | undefined,
  target: AppChain,
  onTarget: boolean,
): ChainSwitch {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<SwitchStatus>();
  const running = useRef(false);

  // Once the wallet is on the target chain, however it got there, the last
  // outcome no longer applies.
  useEffect(() => {
    if (onTarget) setStatus(undefined);
  }, [onTarget]);

  const run = useCallback(() => {
    if (running.current) return;
    if (!request) {
      setStatus({ tone: "negative", text: "Your wallet is not connected. Connect it first." });
      return;
    }
    running.current = true;
    setBusy(true);
    void switchWalletChain({
      request,
      target,
      onPhase: (phase) => setStatus({ tone: "muted", text: phaseText(phase, target) }),
    })
      .then((result) => {
        if (result.outcome === "switched") {
          setStatus(undefined);
          toast.success(`Switched to ${target.name}`);
        } else {
          setStatus({ tone: "negative", text: result.message });
        }
      })
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  }, [request, target]);

  return { busy, status, run };
}
