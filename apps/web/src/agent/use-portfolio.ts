"use client";

import type { ManagedAccount } from "@alpha-agents/domain";

import type { EnvironmentId } from "@alpha-agents/config";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Address, type Hex, decodeFunctionData } from "viem";
import {
  type ActivationReadJson,
  type AnyPortfolioJson,
  type ArmingViewJson,
  ApiError,
  type IntentJson,
  type WhyNotTradedJson,
  type WindowJson,
  api,
  tradingApi,
  type PlanCardJson,
} from "@/api/client";
import { type TurnOnProgress, runTurnOn } from "./activation-flow";
import { type SummaryView, summaryView } from "./my-agents";
import { type ContractWrite, useWalletSession } from "@/auth/session";
import { runArm, runDisarm } from "./arming-flow";
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
  | "open"
  | "deposit"
  | "withdraw"
  | "claim"
  | "withdraw-legacy"
  | "claim-legacy"
  | "arm"
  | "turn-on"
  | "disarm"
  | "approve"
  | "reject"
  | "approve-plan"
  | "reject-plan";

/** The last wallet or owner action and where it is. */
export interface ActionStatus {
  readonly action: PortfolioAction;
  readonly progress: WalletTxProgress;
  /** Shown when it is confirmed: what changed. */
  readonly done: string;
}

/** A token the v3 forms name: its address, symbol and decimals (A-80). */
export interface TokenRef {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
}

export interface Portfolio {
  /** The v2 account, or the account on the fund agent's set where it is deployed (A-80). */
  readonly portfolio: AnyPortfolioJson | null;
  readonly arming: ArmingViewJson | null;
  readonly intents: readonly IntentJson[];
  readonly why: WhyNotTradedJson | null;
  /** F-U9: the plan card, read with the owner session; null before it loads or off the trading set. */
  readonly planCard: PlanCardJson | null;
  /** F-U10: the activation sweep and the checks before one; null before it loads or where the orchestrator is not reachable. */
  readonly activation: ActivationReadJson | null;
  /** The agent's credits and funding address, for Add credits (Phase 2 tuning). */
  readonly summary: SummaryView | null;
  /** UI-U1: the account's performance series for the hero; null before it loads or without an account. */
  readonly windowView: WindowJson | null;
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
  /** A-80, the fund set: deposit any depositable token (an exact approval, then the deposit). */
  depositToken(token: TokenRef, amountText: string): void;
  /** `null` withdraws all of that token. */
  withdrawToken(token: TokenRef, amountText: string | null): void;
  /** Every held token to the wallet in one transaction (CustodyCoreV3.withdrawAll). */
  withdrawEverything(): void;
  claimToken(token: TokenRef): void;
  /** The older v2 account: everything it holds to the wallet in one transaction. */
  withdrawLegacyAll(): void;
  claimLegacy(asset: Asset): void;
  /** Step 0 (2026-10-12, A-90): with an account, the owner's choice of the one the agent manages. */
  arm(account?: ManagedAccount): void;
  /** F-U10: registers the grant when needed, then starts the activation sweep. */
  turnOn(account?: ManagedAccount): void;
  disarm(): void;
  approve(intentId: string): void;
  reject(intentId: string): void;
  approveProposal(proposalId: string): void;
  rejectProposal(proposalId: string): void;
}

const words = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong; try again.";

/** Arming's states (and turning trading on, F-U10) as the shared status line shows them. */
function armingStatus(p: TurnOnProgress): WalletTxProgress {
  switch (p.state) {
    case "starting":
      return { state: "confirming", message: "Starting the activation sweep" };
    case "started":
      return { state: "confirmed" };
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
  const [portfolio, setPortfolio] = useState<AnyPortfolioJson | null>(null);
  const [arming, setArming] = useState<ArmingViewJson | null>(null);
  const [intents, setIntents] = useState<readonly IntentJson[]>([]);
  const [why, setWhy] = useState<WhyNotTradedJson | null>(null);
  const [planCard, setPlanCard] = useState<PlanCardJson | null>(null);
  const [activation, setActivation] = useState<ActivationReadJson | null>(null);
  const [summary, setSummary] = useState<SummaryView | null>(null);
  const [windowView, setWindowView] = useState<WindowJson | null>(null);
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
    setActivation(null);
    setWindowView(null);
    setError(null);
    if (!running.current) setStatus(null);
  }, [wallet.address, agentId]);

  const acting =
    status !== null && ["checking", "waiting-wallet", "confirming"].includes(status.progress.state);
  // F-U10: while the sweep runs the page re-reads every 2 seconds, so the steps show live.
  const sweeping = activation?.activation?.status === "running";
  const busy = acting || sweeping || intents.some((i) => MOVING.has(i.status));

  useEffect(() => {
    if (!wallet.ready || !wallet.address) return;
    let live = true;
    void (async () => {
      try {
        const [p, a, i, w, pc, act, win] = await Promise.all([
          asOwner((t) => tradingApi.portfolio(agentId, t)),
          asOwner((t) => tradingApi.arming(agentId, t)),
          asOwner((t) => tradingApi.intents(agentId, t)),
          tradingApi.whyNotTraded(agentId).catch(() => null),
          asOwner((t) => tradingApi.planCard(agentId, t)).catch(() => null),
          asOwner((t) => tradingApi.activation(agentId, t)).catch(() => null),
          // UI-U1: the performance line for the hero.
          asOwner((t) => tradingApi.window(agentId, t)).catch(() => null),
        ]);
        const s = await asOwner((t) => api.summary(agentId, t)).catch(() => null);
        if (!live || !mounted.current) return;
        setPortfolio(p);
        // Testnet's feeds are re-dated on demand: a stale price on the owner's money page asks
        // for fresh ones, at most once a minute, and the next read shows them (D-307).
        const stale =
          p.custody === "v3"
            ? p.usdcPeg.reason !== "OK" || p.tokens.some((t) => t.price.reason !== "OK")
            : p.prices.usdcUsd.reason !== "OK" || p.prices.monUsd.reason !== "OK";
        if (
          environment === "testnet" &&
          stale &&
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
        setPlanCard(pc);
        setActivation(act);
        setWindowView(win && win.account ? win : null);
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
        {
          checkNetwork,
          send: (c) => wallet.writeContract(c),
          waitForReceipt,
          usdc: portfolio?.contracts.usdc,
        },
        steps,
        (progress) => mounted.current && setStatus({ action, progress, done }),
      ).finally(() => {
        running.current = false;
        if (mounted.current) setTick((t) => t + 1);
      });
    },
    [checkNetwork, portfolio?.contracts.usdc, waitForReceipt, wallet],
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
      portfolio.custody === "v3"
        ? "Your trading account is open on the fund set. Deposit USDC or a registered token to fund it."
        : "Your trading account is open. Deposit USDC to fund it.",
    );
  }, [agentId, portfolio, runSteps]);

  const deposit = useCallback(
    (asset: Asset, amountText: string) => {
      const amount = parseAmount(amountText, DECIMALS[asset]);
      if (portfolio?.custody !== "v2" || !portfolio.account || amount === null) return;
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
      if (portfolio?.custody !== "v2" || !portfolio.account || !wallet.address) return;
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

  // A-80: the account on the fund agent's set takes any depositable token and gives back any held one.
  const v3 = portfolio?.custody === "v3" ? portfolio : null;

  const depositToken = useCallback(
    (token: TokenRef, amountText: string) => {
      const amount = parseAmount(amountText, token.decimals);
      if (!v3?.account || amount === null) return;
      if (environment === "testnet") {
        freshAsked.current = Date.now();
        void asOwner((t) => tradingApi.freshPrices(agentId, t)).catch(() => null);
      }
      // Exact approvals only: the account may take this deposit and nothing more.
      runSteps(
        "deposit",
        [
          {
            label: `Approve exactly ${amountText} ${token.symbol}`,
            call: {
              address: token.address,
              abi: ERC20_ABI,
              functionName: "approve",
              args: [v3.account, amount],
            },
          },
          {
            label: `Deposit ${amountText} ${token.symbol}`,
            call: {
              address: v3.account,
              abi: ACCOUNT_ABI,
              functionName: "deposit",
              args: [token.address, amount],
            },
          },
        ],
        `Deposited ${amountText} ${token.symbol}.`,
      );
    },
    [agentId, asOwner, environment, runSteps, v3],
  );

  const withdrawToken = useCallback(
    (token: TokenRef, amountText: string | null) => {
      if (!v3?.account || !wallet.address) return;
      const held = v3.holdings.find((h) => h.token.toLowerCase() === token.address.toLowerCase());
      const free = held ? BigInt(held.freeRaw) : 0n;
      const amount = amountText === null ? free : parseAmount(amountText, token.decimals);
      if (amount === null || amount === 0n) return;
      const shown = amountText ?? "all";
      runSteps(
        "withdraw",
        [
          {
            label: `Withdraw ${shown} ${token.symbol} to your wallet`,
            call: {
              address: v3.account,
              abi: ACCOUNT_ABI,
              functionName: "withdraw",
              args: [token.address, amount, wallet.address],
            },
          },
        ],
        `Withdrew ${shown === "all" ? "all the" : shown} ${token.symbol} to your wallet.`,
      );
    },
    [runSteps, v3, wallet.address],
  );

  const withdrawEverything = useCallback(() => {
    if (!v3?.account || !wallet.address) return;
    runSteps(
      "withdraw",
      [
        {
          label: "Withdraw every token to your wallet",
          call: {
            address: v3.account,
            abi: ACCOUNT_ABI,
            functionName: "withdrawAll",
            args: [wallet.address],
          },
        },
      ],
      "Withdrew everything to your wallet.",
    );
  }, [runSteps, v3, wallet.address]);

  const claimToken = useCallback(
    (token: TokenRef) => {
      if (!v3?.account || !wallet.address) return;
      runSteps(
        "claim",
        [
          {
            label: `Claim the ${token.symbol} held for you`,
            call: {
              address: v3.account,
              abi: ACCOUNT_ABI,
              functionName: "claim",
              args: [token.address, wallet.address],
            },
          },
        ],
        `Claimed the ${token.symbol} to your wallet.`,
      );
    },
    [runSteps, v3, wallet.address],
  );

  // The older v2 account (A-80): everything it still holds goes to the wallet in one transaction.
  const withdrawLegacyAll = useCallback(() => {
    if (!v3?.legacy || !wallet.address) return;
    runSteps(
      "withdraw-legacy",
      [
        {
          label: "Withdraw everything in the older account to your wallet",
          call: {
            address: v3.legacy.account,
            abi: ACCOUNT_ABI,
            functionName: "withdrawAll",
            args: [wallet.address],
          },
        },
      ],
      "The older account is emptied into your wallet. Deposit into the new account below.",
    );
  }, [runSteps, v3, wallet.address]);

  const claimLegacy = useCallback(
    (asset: Asset) => {
      if (!v3?.legacy || !wallet.address) return;
      const token = asset === "USDC" ? v3.contracts.usdc : v3.contracts.wmon;
      runSteps(
        "claim-legacy",
        [
          {
            label: `Claim the ${asset} the older account holds for you`,
            call: {
              address: v3.legacy.account,
              abi: ACCOUNT_ABI,
              functionName: "claim",
              args: [token, wallet.address],
            },
          },
        ],
        `Claimed the ${asset} to your wallet.`,
      );
    },
    [runSteps, v3, wallet.address],
  );

  const armingDeps = useCallback(
    (token: string) => ({
      checkNetwork,
      // Step 0 (2026-10-12, A-90): the account the agent manages travels with the grant's read and record.
      getArming: (account?: ManagedAccount) =>
        tradingApi.raw(agentId, "arming", "GET", token, account ? { query: { account } } : {}),
      confirmArming: (account?: ManagedAccount) =>
        tradingApi.raw(agentId, "arming", "POST", token, account ? { body: { account } } : {}),
      disarm: () => tradingApi.raw(agentId, "disarm", "POST", token),
      startActivation: () => tradingApi.raw(agentId, "activation", "POST", token),
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
    (action: "arm" | "turn-on" | "disarm", account?: ManagedAccount) => {
      if (running.current) return;
      running.current = true;
      const done =
        action === "arm"
          ? "Your trading permission is on chain. Approve the agent's first proposed trade to arm it."
          : action === "turn-on"
            ? "The activation sweep has started. Watch its steps here; nothing is traded until you approve the plan."
            : "Disarmed. Every proposal waits for your approval again.";
      const report = (p: TurnOnProgress) =>
        mounted.current && setStatus({ action, progress: armingStatus(p), done });
      const armingState = arming?.arming.state ?? "unarmed";
      void (async () => {
        try {
          await asOwner(async (token) => {
            const deps = armingDeps(token);
            await (action === "arm"
              ? runArm(deps, report, account)
              : action === "turn-on"
                ? runTurnOn(deps, armingState, report, account)
                : runDisarm(deps, report));
          });
        } catch (err) {
          report({ state: "error", message: words(err) });
        } finally {
          running.current = false;
          if (mounted.current) setTick((t) => t + 1);
        }
      })();
    },
    [arming?.arming.state, armingDeps, asOwner],
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

  // F-U9: the owner decides a proposed portfolio; an approval sets the plan the runner follows.
  const decidePlan = useCallback(
    (action: "approve-plan" | "reject-plan", proposalId: string) => {
      if (running.current) return;
      running.current = true;
      const set = (progress: WalletTxProgress, done = "") =>
        mounted.current && setStatus({ action, progress, done });
      set({ state: "checking" });
      void (async () => {
        try {
          if (action === "approve-plan") {
            await asOwner((t) => tradingApi.approveProposal(agentId, proposalId, t));
            set(
              { state: "confirmed" },
              "Approved: this is now the agent's plan. The runner moves toward it one capped leg at a time.",
            );
          } else {
            await asOwner((t) => tradingApi.rejectProposal(agentId, proposalId, t));
            set({ state: "confirmed" }, "Declined. The plan stays as it is.");
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
    planCard,
    activation,
    approveProposal: (proposalId: string) => decidePlan("approve-plan", proposalId),
    rejectProposal: (proposalId: string) => decidePlan("reject-plan", proposalId),
    summary,
    windowView,
    refresh: useCallback(() => setTick((t) => t + 1), []),
    error,
    status,
    busy,
    acting,
    openAccount,
    deposit,
    withdraw,
    claim,
    depositToken,
    withdrawToken,
    withdrawEverything,
    claimToken,
    withdrawLegacyAll,
    claimLegacy,
    arm: useCallback((account?: ManagedAccount) => runArming("arm", account), [runArming]),
    turnOn: useCallback((account?: ManagedAccount) => runArming("turn-on", account), [runArming]),
    disarm: useCallback(() => runArming("disarm"), [runArming]),
    approve: useCallback((id: string) => decide("approve", id), [decide]),
    reject: useCallback((id: string) => decide("reject", id), [decide]),
  };
}
