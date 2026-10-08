"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { agentNftDeployment } from "@alpha-agents/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import {
  type ArmingViewJson,
  ApiError,
  type IntentJson,
  type PortfolioJson,
  type WhyNotTradedJson,
  tradingApi,
} from "@/api/client";
import { type ContractWrite, useWalletSession } from "@/auth/session";
import { type ArmingProgress, runArm, runDisarm } from "./arming-flow";
import { chainClient } from "./chain";
import { ACCOUNT_ABI, ERC20_ABI, FACTORY_ABI } from "./custody";
import { type Rpc, checkWalletNetwork } from "./network-check";
import { type Asset, DECIMALS, parseAmount } from "./portfolio";
import { waitForReceiptOnAppNetwork } from "./receipt-watch";
import { StuckNonceError, readNonceReport, stuckNonce } from "./stuck-nonce";
import { useOwnerSession } from "./use-owner-session";
import { type WalletStep, type WalletTxProgress, runWalletSteps } from "./wallet-tx";

/** How often the page re-reads, and how often while a trade or an action is moving. */
const POLL_MS = 5_000;
const BUSY_POLL_MS = 2_000;
const MOVING = new Set(["approved", "submitted", "confirmed"]);

export type PortfolioAction =
  "open" | "deposit" | "withdraw" | "claim" | "arm" | "disarm" | "approve" | "reject";

/** The last wallet or owner action and where it is. */
export interface ActionStatus {
  readonly action: PortfolioAction;
  readonly progress: WalletTxProgress;
  /** Shown when it is confirmed: what changed. */
  readonly done: string;
}

export interface Portfolio {
  readonly portfolio: PortfolioJson | null;
  readonly arming: ArmingViewJson | null;
  readonly intents: readonly IntentJson[];
  readonly why: WhyNotTradedJson | null;
  /** Why the portfolio could not be read, in plain words. */
  readonly error: string | null;
  readonly status: ActionStatus | null;
  readonly busy: boolean;
  openAccount(): void;
  deposit(asset: Asset, amountText: string): void;
  /** `null` withdraws everything of that asset. */
  withdraw(asset: Asset, amountText: string | null): void;
  claim(asset: Asset, token: Address): void;
  arm(): void;
  disarm(): void;
  approve(intentId: string): void;
  reject(intentId: string): void;
}

const words = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong; try again.";

/** Arming's states as the shared status line shows them. */
function armingStatus(p: ArmingProgress): WalletTxProgress {
  switch (p.state) {
    case "checking":
      return { state: "checking" };
    case "signing":
      return { state: "waiting-wallet", label: "Confirm the request" };
    case "confirming":
      return { state: "confirming", ...(p.hash ? { hash: p.hash } : {}) };
    case "recording":
      return { state: "confirming", ...(p.hash ? { hash: p.hash } : {}), message: "Recording" };
    case "awaiting-first-trade":
    case "disarmed":
      return {
        state: "confirmed",
        ...(p.hash ? { hash: p.hash } : {}),
        ...(p.message ? { message: p.message } : {}),
      };
    case "rejected":
      return { state: "rejected" };
    case "error":
      return { state: "failed", message: p.message ?? "It did not go through." };
  }
}

/**
 * One agent's portfolio for its owner (P2-U7): the account, positions, caps
 * and prices from the chain through the API, the arming, the recent intents,
 * and why the agent did not trade, re-read on a timer. Every money action is
 * sent from the owner's own wallet through its provider, after the network
 * guard, and followed by its receipt on the app's network.
 */
export function usePortfolio(agentId: bigint, environment: EnvironmentId): Portfolio {
  const wallet = useWalletSession();
  const asOwner = useOwnerSession(agentId);
  const deployment = useMemo(() => agentNftDeployment(environment), [environment]);
  const client = useMemo(() => chainClient(wallet.target), [wallet.target]);
  const [portfolio, setPortfolio] = useState<PortfolioJson | null>(null);
  const [arming, setArming] = useState<ArmingViewJson | null>(null);
  const [intents, setIntents] = useState<readonly IntentJson[]>([]);
  const [why, setWhy] = useState<WhyNotTradedJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ActionStatus | null>(null);
  const [tick, setTick] = useState(0);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Another wallet's data is never shown: a new account starts over.
  useEffect(() => {
    setPortfolio(null);
    setArming(null);
    setIntents([]);
    setError(null);
    if (!running.current) setStatus(null);
  }, [wallet.address, agentId]);

  const acting =
    status !== null && ["checking", "waiting-wallet", "confirming"].includes(status.progress.state);
  const busy = acting || intents.some((i) => MOVING.has(i.status));

  useEffect(() => {
    if (!wallet.ready || !wallet.address) return;
    let live = true;
    void (async () => {
      try {
        const [p, a, i, w] = await Promise.all([
          asOwner((t) => tradingApi.portfolio(agentId, t)),
          asOwner((t) => tradingApi.arming(agentId, t)),
          asOwner((t) => tradingApi.intents(agentId, t)),
          tradingApi.whyNotTraded(agentId).catch(() => null),
        ]);
        if (!live || !mounted.current) return;
        setPortfolio(p);
        setArming(a);
        setIntents(i);
        if (w) setWhy(w);
        setError(null);
      } catch (err) {
        if (live && mounted.current) setError(words(err));
      }
    })();
    const timer = window.setTimeout(() => setTick((t) => t + 1), busy ? BUSY_POLL_MS : POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [agentId, asOwner, busy, tick, wallet.ready, wallet.address]);

  const appRpc: Rpc = useCallback(
    (method, params) => client.request({ method, params } as never),
    [client],
  );

  const checkNetwork = useCallback(() => {
    if (!deployment)
      return Promise.resolve({
        ok: false as const,
        reason: "no-contract-in-app" as const,
        message: "AgentNFT is not deployed in this environment.",
      });
    return checkWalletNetwork({
      wallet: wallet.walletRequest,
      app: appRpc,
      target: wallet.target,
      referenceBlock: deployment.referenceBlock,
      contract: deployment.address,
    });
  }, [appRpc, deployment, wallet]);

  /** Waits on the app's RPC, names a send to another network (L-53), and reads the receipt's status. */
  const waitForReceipt = useCallback(
    async (hash: Hex): Promise<"success" | "reverted"> => {
      const address = wallet.address;
      await waitForReceiptOnAppNetwork({
        hash,
        app: appRpc,
        wallet: wallet.walletRequest,
        appNetwork: wallet.target.name,
        ...(environment === "local" && address
          ? {
              stuckCheck: async () => {
                const gap = stuckNonce(await readNonceReport(appRpc, address, hash));
                return gap ? new StuckNonceError(gap) : null;
              },
            }
          : {}),
      });
      const receipt = await client.getTransactionReceipt({ hash });
      return receipt.status === "success" ? "success" : "reverted";
    },
    [appRpc, client, environment, wallet],
  );

  const runSteps = useCallback(
    (action: PortfolioAction, steps: WalletStep<ContractWrite>[], done: string) => {
      if (running.current) return;
      running.current = true;
      void runWalletSteps(
        { checkNetwork, send: (c) => wallet.writeContract(c), waitForReceipt },
        steps,
        (progress) => mounted.current && setStatus({ action, progress, done }),
      ).finally(() => {
        running.current = false;
        if (mounted.current) setTick((t) => t + 1);
      });
    },
    [checkNetwork, waitForReceipt, wallet],
  );

  const openAccount = useCallback(() => {
    if (!portfolio) return;
    runSteps(
      "open",
      [
        {
          label: "Open the trading account",
          call: {
            address: portfolio.contracts.accountFactory,
            abi: FACTORY_ABI,
            functionName: "createPersonalAccount",
            args: [agentId],
          },
        },
      ],
      "Your trading account is open. Deposit USDC to fund it.",
    );
  }, [agentId, portfolio, runSteps]);

  const deposit = useCallback(
    (asset: Asset, amountText: string) => {
      const amount = parseAmount(amountText, DECIMALS[asset]);
      if (!portfolio?.account || amount === null) return;
      const token = asset === "USDC" ? portfolio.contracts.usdc : portfolio.contracts.wmon;
      // Exact approvals only: the account may take this deposit and nothing more.
      runSteps(
        "deposit",
        [
          {
            label: `Approve exactly ${amountText} ${asset}`,
            call: {
              address: token,
              abi: ERC20_ABI,
              functionName: "approve",
              args: [portfolio.account, amount],
            },
          },
          {
            label: `Deposit ${amountText} ${asset}`,
            call: {
              address: portfolio.account,
              abi: ACCOUNT_ABI,
              functionName: "deposit",
              args: [token, amount],
            },
          },
        ],
        `Deposited ${amountText} ${asset}.`,
      );
    },
    [portfolio, runSteps],
  );

  const withdraw = useCallback(
    (asset: Asset, amountText: string | null) => {
      if (!portfolio?.account || !wallet.address) return;
      const token = asset === "USDC" ? portfolio.contracts.usdc : portfolio.contracts.wmon;
      const held = BigInt(
        asset === "USDC" ? portfolio.balances.usdcE6 : portfolio.balances.wmonWei,
      );
      const amount = amountText === null ? held : parseAmount(amountText, DECIMALS[asset]);
      if (amount === null || amount === 0n) return;
      const shown = amountText ?? "all";
      runSteps(
        "withdraw",
        [
          {
            label: `Withdraw ${shown} ${asset} to your wallet`,
            call: {
              address: portfolio.account,
              abi: ACCOUNT_ABI,
              functionName: "withdraw",
              args: [token, amount, wallet.address],
            },
          },
        ],
        `Withdrew ${shown === "all" ? "all the" : shown} ${asset} to your wallet.`,
      );
    },
    [portfolio, runSteps, wallet.address],
  );

  const claim = useCallback(
    (asset: Asset, token: Address) => {
      if (!portfolio?.account || !wallet.address) return;
      runSteps(
        "claim",
        [
          {
            label: `Claim the ${asset} held for you`,
            call: {
              address: portfolio.account,
              abi: ACCOUNT_ABI,
              functionName: "claim",
              args: [token, wallet.address],
            },
          },
        ],
        `Claimed the ${asset} to your wallet.`,
      );
    },
    [portfolio, runSteps, wallet.address],
  );

  const armingDeps = useCallback(
    (token: string) => ({
      checkNetwork,
      getArming: () => tradingApi.raw(agentId, "arming", "GET", token),
      confirmArming: () => tradingApi.raw(agentId, "arming", "POST", token),
      disarm: () => tradingApi.raw(agentId, "disarm", "POST", token),
      send: async (call: { to: Hex; data: Hex }) =>
        (await wallet.walletRequest("eth_sendTransaction", [
          { from: wallet.address, to: call.to, data: call.data, value: "0x0" },
        ])) as Hex,
      waitForReceipt: async (hash: Hex) => {
        if ((await waitForReceipt(hash)) === "reverted")
          throw new Error("the transaction reverted");
      },
    }),
    [agentId, checkNetwork, waitForReceipt, wallet],
  );

  const runArming = useCallback(
    (action: "arm" | "disarm") => {
      if (running.current) return;
      running.current = true;
      const done =
        action === "arm"
          ? "Your trading permission is on chain. Approve the agent's first proposed trade to arm it."
          : "Disarmed. Every proposal waits for your approval again.";
      const report = (p: ArmingProgress) =>
        mounted.current && setStatus({ action, progress: armingStatus(p), done });
      void (async () => {
        try {
          await asOwner(async (token) => {
            const deps = armingDeps(token);
            await (action === "arm" ? runArm(deps, report) : runDisarm(deps, report));
          });
        } catch (err) {
          report({ state: "error", message: words(err) });
        } finally {
          running.current = false;
          if (mounted.current) setTick((t) => t + 1);
        }
      })();
    },
    [armingDeps, asOwner],
  );

  const decide = useCallback(
    (action: "approve" | "reject", intentId: string) => {
      if (running.current) return;
      running.current = true;
      const set = (progress: WalletTxProgress, done = "") =>
        mounted.current && setStatus({ action, progress, done });
      set({ state: "checking" });
      void (async () => {
        try {
          if (action === "approve") {
            const armed = await asOwner((t) => tradingApi.approve(agentId, intentId, t));
            set(
              { state: "confirmed" },
              armed
                ? "Approved: the agent is armed. The trade is checked again and sent within seconds."
                : "Approved. The trade is checked again and sent within seconds.",
            );
          } else {
            await asOwner((t) => tradingApi.reject(agentId, intentId, t));
            set({ state: "confirmed" }, "Rejected. Nothing was sent.");
          }
        } catch (err) {
          set({ state: "failed", message: words(err) });
        } finally {
          running.current = false;
          if (mounted.current) setTick((t) => t + 1);
        }
      })();
    },
    [agentId, asOwner],
  );

  return {
    portfolio,
    arming,
    intents,
    why,
    error,
    status,
    busy,
    openAccount,
    deposit,
    withdraw,
    claim,
    arm: useCallback(() => runArming("arm"), [runArming]),
    disarm: useCallback(() => runArming("disarm"), [runArming]),
    approve: useCallback((id: string) => decide("approve", id), [decide]),
    reject: useCallback((id: string) => decide("reject", id), [decide]),
  };
}
