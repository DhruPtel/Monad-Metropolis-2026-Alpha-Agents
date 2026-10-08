"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Address, type Hex, decodeFunctionData } from "viem";
import {
  type ArmingViewJson,
  ApiError,
  type IntentJson,
  type PortfolioJson,
  type WhyNotTradedJson,
  api,
  tradingApi,
} from "@/api/client";
import { type SummaryView, summaryView } from "./my-agents";
import { type ContractWrite, useWalletSession } from "@/auth/session";
import { type ArmingProgress, runArm, runDisarm } from "./arming-flow";
import {
  ACCOUNT_ABI,
  CUSTODY_REVERT_MESSAGES,
  ERC20_ABI,
  FACTORY_ABI,
  GRANT_ABI,
  custodyRevertName,
} from "./custody";
import { type Asset, DECIMALS, parseAmount } from "./portfolio";
import { useOwnerSession } from "./use-owner-session";
import { useWalletTx } from "./use-wallet-tx";
import { type WalletStep, type WalletTxProgress, runWalletSteps } from "./wallet-tx";

/** How often the page re-reads, and how often while a trade or an action is moving. */
const POLL_MS = 5_000;
const BUSY_POLL_MS = 2_000;
/** P2-EC: the least time between two of the page's requests for fresh testnet prices (D-307). */
const FRESH_PRICES_EVERY_MS = 60_000;
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
  /** The agent's credits and funding address, for Add credits (Phase 2 tuning). */
  readonly summary: SummaryView | null;
  /** Re-reads at once. */
  refresh(): void;
  /** Why the portfolio could not be read, in plain words. */
  readonly error: string | null;
  readonly status: ActionStatus | null;
  /** True while the page re-reads faster: an action or a trade is under way. */
  readonly busy: boolean;
  /** True while a wallet or owner action is in progress: other actions wait for it. */
  readonly acting: boolean;
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
  const [portfolio, setPortfolio] = useState<PortfolioJson | null>(null);
  const [arming, setArming] = useState<ArmingViewJson | null>(null);
  const [intents, setIntents] = useState<readonly IntentJson[]>([]);
  const [why, setWhy] = useState<WhyNotTradedJson | null>(null);
  const [summary, setSummary] = useState<SummaryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ActionStatus | null>(null);
  const [tick, setTick] = useState(0);
  const running = useRef(false);
  const mounted = useRef(true);
  // P2-EC (D-307): when the page last asked testnet to re-date its feeds.
  const freshAsked = useRef(0);
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
        const s = await asOwner((t) => api.summary(agentId, t)).catch(() => null);
        if (!live || !mounted.current) return;
        setPortfolio(p);
        // Testnet's feeds are re-dated on demand: a stale price on the owner's money page asks
        // for fresh ones, at most once a minute, and the next read shows them (D-307).
        if (
          environment === "testnet" &&
          (p.prices.usdcUsd.reason !== "OK" || p.prices.monUsd.reason !== "OK") &&
          Date.now() - freshAsked.current > FRESH_PRICES_EVERY_MS
        ) {
          freshAsked.current = Date.now();
          void asOwner((t) => tradingApi.freshPrices(agentId, t))
            .catch(() => null)
            .then(() => mounted.current && setTick((n) => n + 1));
        }
        setArming(a);
        setIntents(i);
        if (w) setWhy(w);
        if (s) setSummary(summaryView(s));
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
  }, [agentId, asOwner, busy, environment, tick, wallet.ready, wallet.address]);

  const { client, checkNetwork, waitForReceipt } = useWalletTx(environment);

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
      // On testnet, fresh prices first, so the deposit's own checks pass (D-307).
      if (environment === "testnet") {
        freshAsked.current = Date.now();
        void asOwner((t) => tradingApi.freshPrices(agentId, t)).catch(() => null);
      }
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
    [agentId, asOwner, environment, portfolio, runSteps],
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
      // The grant or revoke is simulated from the wallet's address first, so a refusal names the
      // Executor's own reason before anything is signed (Phase 2 tuning), then sent from the wallet.
      send: async (call: { to: Hex; data: Hex }) => {
        const { functionName, args } = decodeFunctionData({ abi: GRANT_ABI, data: call.data });
        const request = { address: call.to, abi: GRANT_ABI, functionName, args } as never;
        if (wallet.address)
          await client.simulateContract({
            ...(request as object),
            account: wallet.address,
          } as never);
        return wallet.writeContract(request);
      },
      explainSendError: (error: unknown) => {
        const name = custodyRevertName(error);
        return name
          ? (CUSTODY_REVERT_MESSAGES[name] ?? `The Executor refused it (${name}).`)
          : undefined;
      },
      waitForReceipt: async (hash: Hex) => {
        if ((await waitForReceipt(hash)) === "reverted")
          throw new Error("the transaction reverted");
      },
    }),
    [agentId, checkNetwork, client, waitForReceipt, wallet],
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
    summary,
    refresh: useCallback(() => setTick((t) => t + 1), []),
    error,
    status,
    busy,
    acting,
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
