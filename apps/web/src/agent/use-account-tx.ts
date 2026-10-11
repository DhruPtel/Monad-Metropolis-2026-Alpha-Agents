"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Address, BaseError, ContractFunctionRevertedError, encodeFunctionData } from "viem";
import { useWalletSession } from "@/auth/session";
import { PERSONAL_ACCOUNT_ABI } from "./custody";
import { useWalletTx } from "./use-wallet-tx";
import { type WalletTxProgress, runWalletSteps, walletTxText } from "./wallet-tx";

/** The owner's own calls on the v3 account (F-U12): the screened-lane opt-in and the unpause. */
export type AccountCall =
  | { readonly functionName: "setScreenedOptIn"; readonly args: readonly [boolean] }
  | { readonly functionName: "unpause"; readonly args: readonly [] };

/** The owner-facing reason for a refused account call: only the agent's owner may make it. */
export function accountFailure(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
  return name === "NotOwner"
    ? "Only the agent's current owner can do this, from the wallet that holds the agent."
    : null;
}

export interface AccountTx {
  readonly progress: WalletTxProgress | null;
  /** The progress in the owner's words; the given text once confirmed. */
  readonly text: string | null;
  readonly busy: boolean;
  /** Sends one call from the connected wallet: the network guard, a simulation from the owner, the send, the receipt. */
  send(
    label: string,
    account: Address,
    call: AccountCall,
    confirmedText: string,
  ): Promise<WalletTxProgress | null>;
}

/**
 * One owner transaction on the agent's v3 PersonalAccount from the connected
 * wallet through its own provider (F-U12): the network guard, the call
 * simulated from the owner's address so a refusal names its reason, the send,
 * and the receipt on the app's network. Every outcome is reported as text.
 */
export function useAccountTx(environment: EnvironmentId): AccountTx {
  const wallet = useWalletSession();
  const { client, checkNetwork, waitForReceipt } = useWalletTx(environment);
  const [progress, setProgress] = useState<WalletTxProgress | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const send = useCallback(
    async (label: string, account: Address, call: AccountCall, confirmedText: string) => {
      const owner = wallet.address;
      if (running.current || !owner) return null;
      running.current = true;
      setConfirmed(confirmedText);
      const request = {
        address: account,
        abi: PERSONAL_ACCOUNT_ABI,
        functionName: call.functionName,
        args: call.args,
      } as const;
      const data = encodeFunctionData(request as never);
      try {
        return await runWalletSteps(
          {
            checkNetwork,
            send: async () => {
              try {
                await client.simulateContract({ ...request, account: owner } as never);
              } catch (err) {
                const why = accountFailure(err);
                if (why) throw new Error(why, { cause: err });
                throw err;
              }
              return wallet.writeContract(request as never);
            },
            waitForReceipt,
          },
          [{ label, call: { to: account, data } }],
          (p) => mounted.current && setProgress(p),
        );
      } finally {
        running.current = false;
      }
    },
    [checkNetwork, client, waitForReceipt, wallet],
  );

  const text = progress
    ? progress.state === "confirmed" && confirmed
      ? confirmed
      : walletTxText(progress)
    : null;
  const busy = progress !== null && !["confirmed", "rejected", "failed"].includes(progress.state);
  return { progress, text, busy, send };
}
