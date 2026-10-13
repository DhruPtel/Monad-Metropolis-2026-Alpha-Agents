"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { ApiError, type VaultResponseJson, api } from "@/api/client";
import { type ContractWrite, useWalletSession } from "@/auth/session";
import { ERC20_ABI, FACTORY_ABI, VAULT_ABI } from "./custody";
import { minAssetsOut, minSharesOut } from "./vault-v3";
import { type WalletStep, type WalletTxProgress, runWalletSteps } from "./wallet-tx";
import { useWalletTx } from "./use-wallet-tx";
import { schedulePoll } from "./poll";

/** The vault re-reads itself this often, and faster while an action runs. */
const POLL_MS = 10_000;
const BUSY_POLL_MS = 2_000;
/** A USDC exit must confirm within this long of the wallet signing it. */
const REDEEM_DEADLINE_S = 20 * 60;

export type VaultAction = "create" | "deposit" | "withdraw" | "claim" | "deposits-open";

export interface VaultActionStatus {
  readonly action: VaultAction;
  readonly progress: WalletTxProgress;
  /** What to say once confirmed. */
  readonly done: string;
}

/**
 * The agent's vault (P7-U4), read from the public route for whatever wallet is
 * connected (or for nobody), and the wallet's own actions on it: create the
 * vault (the owner), approve exactly the amount then deposit, redeem for USDC
 * or in kind, claim a credit, and the leader's deposits switch. Every action
 * runs through the shared wallet steps: the network check, the wallet's own
 * provider, the receipt on the app's network, the contract's reason on a
 * refusal.
 */
export function useVault(agentId: bigint, environment: Parameters<typeof useWalletTx>[0]) {
  const wallet = useWalletSession();
  const [data, setData] = useState<VaultResponseJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<VaultActionStatus | null>(null);
  const [tick, setTick] = useState(0);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const busy =
    status !== null && ["checking", "waiting-wallet", "confirming"].includes(status.progress.state);

  // A new wallet starts over: nothing of another wallet's position stays on screen.
  useEffect(() => {
    setData(null);
    setError(null);
    setStatus(null);
  }, [wallet.address, agentId]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const viewer = wallet.ready ? (wallet.address as Address | undefined) : undefined;
        const r = await api.vault(agentId, viewer);
        if (!live) return;
        setData(r);
        setError(null);
      } catch (err) {
        if (!live) return;
        setError(
          err instanceof ApiError || err instanceof Error
            ? err.message
            : "Could not read the vault.",
        );
      }
    })();
    const cancelPoll = schedulePoll(refresh, busy ? BUSY_POLL_MS : POLL_MS);
    return () => {
      live = false;
      cancelPoll();
    };
  }, [agentId, busy, refresh, tick, wallet.ready, wallet.address]);

  const { checkNetwork, waitForReceipt } = useWalletTx(environment);
  const runSteps = useCallback(
    (action: VaultAction, steps: WalletStep<ContractWrite>[], done: string) => {
      if (running.current) return;
      running.current = true;
      void runWalletSteps(
        {
          checkNetwork,
          send: (c) => wallet.writeContract(c),
          waitForReceipt,
          usdc: data?.vault.contracts.usdc,
        },
        steps,
        (progress) => mounted.current && setStatus({ action, progress, done }),
      ).finally(() => {
        running.current = false;
        if (mounted.current) setTick((t) => t + 1);
      });
    },
    [checkNetwork, data?.vault.contracts.usdc, waitForReceipt, wallet],
  );

  const v = data?.vault ?? null;
  const me = wallet.address as Address | undefined;

  const createVault = useCallback(() => {
    if (!v) return;
    runSteps(
      "create",
      [
        {
          label: `Create the vault for Agent #${agentId.toString()}`,
          call: {
            address: v.contracts.accountFactory,
            abi: FACTORY_ABI,
            functionName: "createVault",
            args: [agentId],
          } satisfies ContractWrite,
        },
      ],
      "The vault is created. Stake first, then open deposits.",
    );
  }, [agentId, runSteps, v]);

  const deposit = useCallback(
    (assets: bigint, amountText: string) => {
      if (!v?.vault) return;
      const vault = v.vault;
      runSteps(
        "deposit",
        [
          {
            label: `Approve ${amountText} USDC for the vault`,
            call: {
              address: v.contracts.usdc,
              abi: ERC20_ABI,
              functionName: "approve",
              args: [vault, assets],
            } satisfies ContractWrite,
          },
          {
            label: `Deposit ${amountText} USDC into the vault`,
            call: {
              address: vault,
              abi: VAULT_ABI,
              functionName: "deposit",
              args: [assets, minSharesOut(v, assets)],
            } satisfies ContractWrite,
          },
        ],
        `Deposited ${amountText} USDC. Your shares are locked for the lockup from now.`,
      );
    },
    [runSteps, v],
  );

  const withdraw = useCallback(
    (shares: bigint, method: "usdc" | "in_kind", sharesText: string) => {
      if (!v?.vault || !me) return;
      const vault = v.vault;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + REDEEM_DEADLINE_S);
      runSteps(
        "withdraw",
        [
          method === "usdc"
            ? {
                label: `Redeem ${sharesText} shares for USDC`,
                call: {
                  address: vault,
                  abi: VAULT_ABI,
                  functionName: "redeem",
                  args: [shares, me, minAssetsOut(v, shares), deadline],
                } satisfies ContractWrite,
              }
            : {
                label: `Redeem ${sharesText} shares in kind`,
                call: {
                  address: vault,
                  abi: VAULT_ABI,
                  functionName: "redeemInKind",
                  args: [shares, me],
                } satisfies ContractWrite,
              },
        ],
        method === "usdc"
          ? `Redeemed ${sharesText} shares: the USDC is in your wallet.`
          : `Redeemed ${sharesText} shares in kind: every token is in your wallet.`,
      );
    },
    [me, runSteps, v],
  );

  const claim = useCallback(
    (token: Address, symbol: string) => {
      if (!v?.vault || !me) return;
      runSteps(
        "claim",
        [
          {
            label: `Claim your ${symbol} from the vault`,
            call: {
              address: v.vault,
              abi: VAULT_ABI,
              functionName: "claim",
              args: [token, me],
            } satisfies ContractWrite,
          },
        ],
        `Claimed: your ${symbol} is in your wallet.`,
      );
    },
    [me, runSteps, v],
  );

  const setDepositsOpen = useCallback(
    (open: boolean) => {
      if (!v?.vault) return;
      runSteps(
        "deposits-open",
        [
          {
            label: open ? "Open the vault to deposits" : "Close the vault to deposits",
            call: {
              address: v.vault,
              abi: VAULT_ABI,
              functionName: "setDepositsOpen",
              args: [open],
            } satisfies ContractWrite,
          },
        ],
        open ? "Deposits are open." : "Deposits are closed.",
      );
    },
    [runSteps, v],
  );

  return {
    data,
    error,
    status,
    busy,
    refresh,
    createVault,
    deposit,
    withdraw,
    claim,
    setDepositsOpen,
    lastHash: status?.progress.hash as Hex | undefined,
  };
}
