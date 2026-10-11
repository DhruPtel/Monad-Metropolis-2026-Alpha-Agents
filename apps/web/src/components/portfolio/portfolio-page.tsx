"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { formatAmount } from "@alpha-agents/domain";
import {
  ActivationChecks,
  ActivationPanel,
  ApprovalCard,
  AssetMakeupTable,
  FundOverview,
  OlderAccountCard,
  type ApprovalView,
  ArmingCard,
  Button,
  CapsPanel,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  GasNotice,
  GoalSummary,
  Input,
  PortfolioOverview,
  PositionsPanel,
  RecentTrades,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  WalletActionStatus,
  WhyNotTraded,
  NoChangeNotice,
  PlanCard,
} from "@alpha-agents/ui";
import { ArrowLeft, PlugZap, Wallet } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import type {
  AnyPortfolioJson,
  IntentJson,
  PlanCardJson,
  PortfolioJson,
  PortfolioV3Json,
} from "@/api/client";
import { latestDecided, planCardView } from "@/agent/plan-card";
import { ActivationTerminal } from "./activation-terminal";
import { useWalletSession } from "@/auth/session";
import {
  type Asset,
  DECIMALS,
  LOW_GAS_WEI,
  capRoom,
  claimables,
  depositCheck,
  parseAmount,
  positions,
  priceAgeSeconds,
  priceUsable,
  withdrawCheck,
} from "@/agent/portfolio";
import {
  type ActionStatus,
  type PortfolioAction,
  type TokenRef,
  usePortfolio,
} from "@/agent/use-portfolio";
import {
  assetRows,
  capRoomV3,
  claimablesV3,
  depositCheckV3,
  depositTokens,
  legacyLines,
  overviewV3,
  withdrawCheckV3,
  withdrawable,
} from "@/agent/portfolio-v3";
import { walletTxText } from "@/agent/wallet-tx";
import { AddCreditsSection } from "@/components/credits/add-credits-section";
import { AgentHoldings } from "@/components/holdings/agent-holdings";
import type { Address } from "viem";

/**
 * The portfolio page (P2-U7, FINAL_PLAN 4.10): the owner manages the agent's
 * trading money from their own wallet. Open the account, deposit, see
 * positions, arm the agent, approve or reject its proposals, watch its trades
 * settle, read why it did not trade, and withdraw at any time. Every value is
 * read through the owner session; every money action is the owner's own
 * wallet transaction.
 */

const toUnits = (raw: string, asset: Asset) =>
  formatAmount(BigInt(raw), DECIMALS[asset], { maxFractionDigits: DECIMALS[asset] });

function StatusFor({
  status,
  actions,
}: {
  status: ActionStatus | null;
  actions: readonly PortfolioAction[];
}) {
  if (!status || !actions.includes(status.action)) return null;
  const p = status.progress;
  const text = p.state === "confirmed" ? status.done || "Done." : walletTxText(p);
  return <WalletActionStatus state={p.state} text={text} hash={p.hash ?? null} />;
}

function positionsView(p: PortfolioJson) {
  const pos = positions(p);
  const usable = priceUsable(p);
  const priceE18 = BigInt(p.prices.monUsd.priceE18);
  return {
    ...pos,
    mode: p.mode ?? "NORMAL",
    drawdownBps: p.breaker?.drawdownBps ?? null,
    peak7d: p.peak7dE18
      ? formatAmount(BigInt(p.peak7dE18), 18, { maxFractionDigits: 4, minFractionDigits: 4 })
      : null,
    price: {
      monUsd: usable
        ? formatAmount(priceE18, 18, { maxFractionDigits: 4, minFractionDigits: 4 })
        : null,
      ageSeconds: priceAgeSeconds(p),
      usable,
      reason: p.prices.monUsd.reason,
    },
  };
}

function capsView(p: AnyPortfolioJson) {
  return {
    personalCapUsdc: BigInt(p.caps.personalUsdcE6),
    principalUsdc: BigInt(p.caps.principalUsdcE6),
    platformCapUsdc: BigInt(p.caps.platformUsdcE6),
    platformTotalUsdc: BigInt(p.caps.platformTotalUsdcE6),
    roomUsdc: capRoom(p).room,
    allowlisted: !p.allowlist.enabled || p.allowlist.listed,
  };
}

function approvalView(
  i: IntentJson,
  p: AnyPortfolioJson,
  chainName: string,
  arms: boolean,
): ApprovalView {
  const token = (a: Asset) => (a === "USDC" ? p.contracts.usdc : p.contracts.wmon);
  return {
    intentId: i.intentId,
    account: p.account ?? p.predictedAccount,
    chainName,
    chainId: p.chainId,
    sell: { asset: i.sell.asset, token: token(i.sell.asset), amount: BigInt(i.sell.amountRaw) },
    buy: { asset: i.buy, token: token(i.buy) },
    expectedOut: i.expectedOut ? BigInt(i.expectedOut.amountRaw) : null,
    minOut: i.minAmountOut ? BigInt(i.minAmountOut.amountRaw) : null,
    expiresAt: i.expiresAt,
    reason: i.reason,
    arms,
  };
}

/**
 * The agent's plan (F-U9): the proposal waiting for the owner with its
 * reasons, or the latest decided one, and why the plan did not change.
 */
function PlanSection({
  card,
  busy,
  onApprove,
  onReject,
  status,
}: {
  card: PlanCardJson;
  busy: boolean;
  onApprove: (proposalId: string) => void;
  onReject: (proposalId: string) => void;
  status: ReactNode;
}) {
  const pending = card.pending;
  const shown = pending ?? latestDecided(card);
  const noChange = card.noChange;
  const showNoChange = noChange !== null && (!shown || noChange.createdAt > shown.createdAt);
  return (
    <section aria-label="Plan" className="flex flex-col gap-3" data-testid="plan-section" id="plan">
      <h2 className="text-lg font-semibold">The agent&apos;s plan</h2>
      {shown ? (
        <PlanCard
          view={planCardView(card, shown)}
          actions={
            pending ? (
              <>
                <Button disabled={busy} onClick={() => onApprove(pending.proposalId)}>
                  Approve this plan
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => onReject(pending.proposalId)}
                >
                  Decline
                </Button>
              </>
            ) : undefined
          }
          status={pending ? status : undefined}
        />
      ) : null}
      {!pending && shown ? status : null}
      {showNoChange ? (
        <NoChangeNotice
          reasonCode={noChange.reasonCode ?? "NO_CHANGE"}
          explanation={noChange.explanation ?? noChange.rationale.portfolioView}
          at={noChange.createdAt}
        />
      ) : null}
      {!shown && !showNoChange ? (
        <p className="text-sm text-foreground-muted" data-testid="plan-none">
          No portfolio proposal yet: the agent&apos;s next research cycle may make one.
        </p>
      ) : null}
    </section>
  );
}

/** Deposit: the asset, the amount with a Max, every block named before anything is sent. */
function DepositForm({
  p,
  busy,
  status,
  onDeposit,
}: {
  p: PortfolioJson;
  busy: boolean;
  status: ActionStatus | null;
  onDeposit: (asset: Asset, amount: string) => void;
}) {
  const [asset, setAsset] = useState<Asset>("USDC");
  const [text, setText] = useState("");
  const amount = parseAmount(text, DECIMALS[asset]);
  const check = text === "" ? null : amount === null ? null : depositCheck(p, asset, amount);
  const walletHeld = asset === "USDC" ? p.wallet.usdcE6 : p.wallet.wmonWei;
  const room = capRoom(p).room;
  const max =
    asset === "USDC" ? (BigInt(walletHeld) < room ? BigInt(walletHeld) : room) : BigInt(walletHeld);
  const error =
    text !== "" && amount === null
      ? `Enter a number with at most ${DECIMALS[asset]} decimals.`
      : (check?.message ?? undefined);
  const blockedBefore = depositCheck(p, asset, 1n);
  const standing =
    blockedBefore.block &&
    [
      "NOT_ALLOWLISTED",
      "PAUSED",
      "DEPOSITS_CLOSED",
      "USDC_DEPEGGED",
      "USDC_PRICE_UNAVAILABLE",
    ].includes(blockedBefore.block)
      ? blockedBefore.message
      : null;
  return (
    <section aria-label="Deposit" className="flex flex-col gap-3" data-testid="deposit-form">
      <h3 className="text-base font-semibold">Deposit</h3>
      <p className="text-sm text-foreground-muted">
        From your wallet into the trading account. Your wallet approves exactly this amount, then
        deposits it.
      </p>
      {standing ? (
        <p role="alert" className="text-sm text-warning" data-testid="deposit-block">
          {standing}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Asset" className="w-32">
          {(control) => (
            <Select value={asset} onValueChange={(v) => setAsset(v as Asset)}>
              <SelectTrigger {...control}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="USDC">USDC</SelectItem>
                <SelectItem value="WMON" disabled={!priceUsable(p)}>
                  WMON
                </SelectItem>
              </SelectContent>
            </Select>
          )}
        </Field>
        <Field label="Amount" className="min-w-40 flex-1" {...(error ? { error } : {})}>
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              placeholder="0.00"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
        </Field>
        <Button
          variant="secondary"
          disabled={busy || max === 0n}
          onClick={() =>
            setText(
              formatAmount(max, DECIMALS[asset], { maxFractionDigits: DECIMALS[asset] }).replace(
                /,/g,
                "",
              ),
            )
          }
        >
          Max
        </Button>
        <Button
          disabled={busy || !check?.ok || amount === null}
          onClick={() => amount !== null && onDeposit(asset, text.trim())}
        >
          Deposit
        </Button>
      </div>
      <p className="text-xs text-foreground-muted">
        In your wallet: <span className="numeric">{toUnits(walletHeld, asset)}</span> {asset}
      </p>
      <StatusFor status={status} actions={["deposit"]} />
    </section>
  );
}

/** Withdraw: always available, in every mode, with no price and no platform needed. */
function WithdrawForm({
  p,
  busy,
  status,
  onWithdraw,
}: {
  p: PortfolioJson;
  busy: boolean;
  status: ActionStatus | null;
  onWithdraw: (asset: Asset, amount: string | null) => void;
}) {
  const [asset, setAsset] = useState<Asset>("USDC");
  const [text, setText] = useState("");
  const amount = parseAmount(text, DECIMALS[asset]);
  const held = asset === "USDC" ? p.balances.usdcE6 : p.balances.wmonWei;
  const error =
    text === ""
      ? undefined
      : amount === null
        ? `Enter a number with at most ${DECIMALS[asset]} decimals.`
        : (withdrawCheck(p, asset, amount) ?? undefined);
  return (
    <section aria-label="Withdraw" className="flex flex-col gap-3" data-testid="withdraw-form">
      <h3 className="text-base font-semibold">Withdraw</h3>
      <p className="text-sm text-foreground-muted">
        To your wallet, at any time and in every mode, even paused or reduce-only. Withdrawals read
        no price and need nothing from the platform.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Asset" className="w-32">
          {(control) => (
            <Select value={asset} onValueChange={(v) => setAsset(v as Asset)}>
              <SelectTrigger {...control}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="USDC">USDC</SelectItem>
                <SelectItem value="WMON">WMON</SelectItem>
              </SelectContent>
            </Select>
          )}
        </Field>
        <Field label="Amount" className="min-w-40 flex-1" {...(error ? { error } : {})}>
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              placeholder="0.00"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
        </Field>
        <Button
          variant="secondary"
          disabled={busy || BigInt(held) === 0n}
          onClick={() => onWithdraw(asset, null)}
        >
          Withdraw all
        </Button>
        <Button
          disabled={busy || amount === null || error !== undefined}
          onClick={() => onWithdraw(asset, text.trim())}
        >
          Withdraw
        </Button>
      </div>
      <p className="text-xs text-foreground-muted">
        In the account: <span className="numeric">{toUnits(held, asset)}</span> {asset}
      </p>
      <StatusFor status={status} actions={["withdraw"]} />
    </section>
  );
}

/** A token amount in its own units, with as many decimals as the token has. */
const tokenUnits = (raw: string | bigint, decimals: number) =>
  formatAmount(BigInt(raw), decimals, { maxFractionDigits: Math.min(decimals, 8) });

/** Deposit on the fund set (A-80): any depositable token, with every block named before anything is sent. */
function DepositFormV3({
  p,
  busy,
  status,
  onDeposit,
}: {
  p: PortfolioV3Json;
  busy: boolean;
  status: ActionStatus | null;
  onDeposit: (token: TokenRef, amount: string) => void;
}) {
  const tokens = depositTokens(p);
  const [address, setAddress] = useState<string>(tokens[0]?.address ?? p.contracts.usdc);
  const [text, setText] = useState("");
  const token = tokens.find((t) => t.address.toLowerCase() === address.toLowerCase()) ?? tokens[0];
  const decimals = token?.decimals ?? 6;
  const amount = parseAmount(text, decimals);
  const check =
    token && text !== "" && amount !== null ? depositCheckV3(p, token.address, amount) : null;
  const walletHeld = BigInt(token?.walletRaw ?? "0");
  const room = capRoomV3(p).room;
  const isCash = token ? token.address.toLowerCase() === p.contracts.usdc.toLowerCase() : true;
  const max = isCash ? (walletHeld < room ? walletHeld : room) : walletHeld;
  const error =
    text !== "" && amount === null
      ? `Enter a number with at most ${decimals} decimals.`
      : (check?.message ?? undefined);
  const blockedBefore = token ? depositCheckV3(p, token.address, 1n) : null;
  const standing =
    blockedBefore?.block &&
    [
      "NOT_ALLOWLISTED",
      "PAUSED",
      "DEPOSITS_CLOSED",
      "USDC_DEPEGGED",
      "USDC_PRICE_UNAVAILABLE",
      "HELD_PRICE_UNAVAILABLE",
    ].includes(blockedBefore.block)
      ? blockedBefore.message
      : null;
  return (
    <section
      aria-label="Deposit"
      className="flex flex-col gap-3"
      data-testid="deposit-form"
      data-custody="v3"
    >
      <h3 className="text-base font-semibold">Deposit</h3>
      <p className="text-sm text-foreground-muted">
        From your wallet into the trading account: USDC or any registered core token with a price.
        Your wallet approves exactly this amount, then deposits it.
      </p>
      {standing ? (
        <p role="alert" className="text-sm text-warning" data-testid="deposit-block">
          {standing}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Token" className="w-36">
          {(control) => (
            <Select value={address} onValueChange={setAddress}>
              <SelectTrigger {...control}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {tokens.map((t) => (
                  <SelectItem
                    key={t.address}
                    value={t.address}
                    disabled={
                      t.address.toLowerCase() !== p.contracts.usdc.toLowerCase() &&
                      t.price.reason !== "OK"
                    }
                  >
                    {t.symbol}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        <Field label="Amount" className="min-w-40 flex-1" {...(error ? { error } : {})}>
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              placeholder="0.00"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
        </Field>
        <Button
          variant="secondary"
          disabled={busy || max === 0n}
          onClick={() => setText(tokenUnits(max, decimals).replace(/,/g, ""))}
        >
          Max
        </Button>
        <Button
          disabled={busy || !token || !check?.ok || amount === null}
          onClick={() => token && amount !== null && onDeposit(token, text.trim())}
        >
          Deposit
        </Button>
      </div>
      <p className="text-xs text-foreground-muted">
        In your wallet: <span className="numeric">{tokenUnits(walletHeld, decimals)}</span>{" "}
        {token?.symbol ?? "USDC"}
      </p>
      <StatusFor status={status} actions={["deposit"]} />
    </section>
  );
}

/** Withdraw on the fund set (A-80): any held token, or everything at once, in every mode. */
function WithdrawFormV3({
  p,
  busy,
  status,
  onWithdraw,
  onWithdrawEverything,
}: {
  p: PortfolioV3Json;
  busy: boolean;
  status: ActionStatus | null;
  onWithdraw: (token: TokenRef, amount: string | null) => void;
  onWithdrawEverything: () => void;
}) {
  const held = withdrawable(p);
  const [address, setAddress] = useState<string>(held[0]?.token ?? p.contracts.usdc);
  const [text, setText] = useState("");
  const token = held.find((h) => h.token.toLowerCase() === address.toLowerCase()) ?? held[0];
  const decimals = token?.decimals ?? 6;
  const amount = parseAmount(text, decimals);
  const free = BigInt(token?.freeRaw ?? "0");
  const error =
    text === ""
      ? undefined
      : amount === null
        ? `Enter a number with at most ${decimals} decimals.`
        : token
          ? (withdrawCheckV3(p, token.token, amount) ?? undefined)
          : "Nothing is held.";
  const ref = (h: NonNullable<typeof token>): TokenRef => ({
    address: h.token,
    symbol: h.symbol,
    decimals: h.decimals,
  });
  return (
    <section
      aria-label="Withdraw"
      className="flex flex-col gap-3"
      data-testid="withdraw-form"
      data-custody="v3"
    >
      <h3 className="text-base font-semibold">Withdraw</h3>
      <p className="text-sm text-foreground-muted">
        To your wallet, at any time and in every mode, even paused or reduce-only. Withdrawals read
        no price and need nothing from the platform.
      </p>
      {held.length === 0 ? (
        <p className="text-sm text-foreground-muted" data-testid="withdraw-empty">
          Nothing is held yet.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Token" className="w-36">
            {(control) => (
              <Select value={address} onValueChange={setAddress}>
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {held.map((h) => (
                    <SelectItem key={h.token} value={h.token}>
                      {h.symbol}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label="Amount" className="min-w-40 flex-1" {...(error ? { error } : {})}>
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                placeholder="0.00"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            )}
          </Field>
          <Button
            variant="secondary"
            disabled={busy || !token || free === 0n}
            onClick={() => token && onWithdraw(ref(token), null)}
          >
            Withdraw all {token?.symbol ?? ""}
          </Button>
          <Button
            disabled={busy || !token || amount === null || error !== undefined}
            onClick={() => token && onWithdraw(ref(token), text.trim())}
          >
            Withdraw
          </Button>
        </div>
      )}
      {token ? (
        <p className="text-xs text-foreground-muted">
          Free in the account: <span className="numeric">{tokenUnits(free, decimals)}</span>{" "}
          {token.symbol}
          {BigInt(token.amountRaw) > free ? " (the rest is spoken for by a trade in flight)" : ""}
        </p>
      ) : null}
      {held.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={onWithdrawEverything}
            data-testid="withdraw-everything"
          >
            Withdraw every token
          </Button>
          <span className="text-xs text-foreground-muted">
            One wallet transaction for all of it.
          </span>
        </div>
      ) : null}
      <StatusFor status={status} actions={["withdraw"]} />
    </section>
  );
}

export function PortfolioPage({
  environment,
  agentId,
}: {
  environment: EnvironmentId;
  agentId: bigint;
}) {
  const wallet = useWalletSession();
  const pf = usePortfolio(agentId, environment);
  const name = `Agent #${agentId.toString()}`;
  const network = wallet.target.name;
  const p = pf.portfolio;
  const acting = pf.acting;
  // F-U10: the moment the panel's elapsed times count to, ticking while the sweep runs.
  const activation = pf.activation?.available ? pf.activation.activation : null;
  const sweeping = activation?.status === "running";
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    setNow(new Date().toISOString());
    if (!sweeping) return;
    const timer = window.setInterval(() => setNow(new Date().toISOString()), 1_000);
    return () => window.clearInterval(timer);
  }, [sweeping, activation?.activationId]);
  // F-U11: the window's links name a section (#plan, #trades, #why) that exists only once the
  // portfolio has loaded, after the browser's own jump; scroll to it then.
  const loaded = p !== null;
  useEffect(() => {
    if (!loaded) return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(hash)?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loaded]);

  const header = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-foreground-muted">
        <Link href="/agents" className="flex items-center gap-1">
          <ArrowLeft aria-hidden className="size-4" /> My Agents
        </Link>
        <Link href={`/agents/${agentId.toString()}/window`} data-testid="window-link">
          Performance window
        </Link>
        <Link href={`/agents/${agentId.toString()}/research`} data-testid="research-link">
          Research
        </Link>
      </div>
      <h1 className="text-2xl font-semibold">{name}: portfolio</h1>
      <p className="max-w-2xl text-sm text-foreground-muted">
        {name}&apos;s trading account on {network}. Only you can withdraw from it; the agent can
        only trade it within its hard limits.
      </p>
    </div>
  );

  if (!wallet.ready && wallet.state !== "wrong-chain")
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState
          icon={Wallet}
          title="Connect your wallet"
          description="The portfolio appears once you connect the wallet that owns this agent."
          action={
            <Button onClick={wallet.connect}>
              <Wallet aria-hidden /> Connect wallet
            </Button>
          }
        />
      </div>
    );
  if (wallet.state === "wrong-chain")
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState
          icon={PlugZap}
          title={`Switch to ${network}`}
          description="Your wallet is on another network. Switch it to manage this agent's money."
          action={<Button onClick={wallet.switchChain}>Switch network</Button>}
        />
      </div>
    );
  if (!p)
    return (
      <div className="flex flex-col gap-6">
        {header}
        {pf.error ? (
          <EmptyState icon={PlugZap} title="Could not read this portfolio" description={pf.error} />
        ) : (
          <div aria-busy="true" aria-label="Loading the portfolio" className="flex flex-col gap-4">
            <Skeleton className="h-48 w-full" />
          </div>
        )}
      </div>
    );

  const allowlisted = !p.allowlist.enabled || p.allowlist.listed;
  const armingState = pf.arming?.arming.state ?? "unarmed";
  const waiting = pf.intents.filter((i) => i.status === "awaiting_approval");
  // A-80: on the fund agent's set every section uses the PersonalAccountV3; the v2 account is older.
  const v3 = p.custody === "v3" ? p : null;
  const v2 = p.custody === "v2" ? p : null;
  const credits = v2 ? claimables(v2) : [];
  const creditsV3 = v3 ? claimablesV3(v3) : [];
  const legacy = v3 ? legacyLines(v3) : null;
  const olderAccount =
    v3?.legacy && legacy ? (
      <OlderAccountCard
        account={v3.legacy.account}
        lines={legacy}
        mode={v3.legacy.mode}
        busy={acting}
        onWithdrawAll={pf.withdrawLegacyAll}
        onClaim={(symbol) => pf.claimLegacy(symbol as Asset)}
        status={<StatusFor status={pf.status} actions={["withdraw-legacy", "claim-legacy"]} />}
      />
    ) : null;
  // F-U10: a sweep may start when none is under way or waiting for the owner, and none is in force.
  const read = pf.activation?.available ? pf.activation : null;
  const canSweep =
    read !== null &&
    (activation === null || !["running", "plan_ready", "active"].includes(activation.status));
  const blocked = read?.checks.some((c) => !c.ok && c.blocking) ?? false;
  const sweepButton = canSweep ? (
    <Button
      disabled={acting || blocked || (armingState === "unarmed" && !pf.arming?.grantCall)}
      onClick={pf.turnOn}
      data-testid="turn-on"
    >
      {armingState === "unarmed"
        ? "Turn on automatic trading"
        : activation
          ? "Run the sweep again"
          : "Start the activation sweep"}
    </Button>
  ) : null;

  return (
    <div className="flex flex-col gap-6" data-testid="portfolio">
      {header}
      {pf.summary?.goal ? (
        <GoalSummary
          state={pf.summary.goal.state}
          aggressiveness={pf.summary.goal.aggressiveness}
          action={
            <Button asChild size="sm" variant="ghost">
              <Link href={`/agents/${agentId.toString()}/goal`}>
                {pf.summary.goal.configured ? "Change goal" : "Set goal"}
              </Link>
            </Button>
          }
        />
      ) : null}
      {pf.error ? (
        <p role="alert" className="text-sm text-warning">
          {pf.error} The values below are from the last read.
        </p>
      ) : null}
      {!p.account ? (
        <Card data-testid="open-account">
          <CardHeader>
            <CardTitle>Open a trading account</CardTitle>
            <CardDescription>
              {v3
                ? `A trading account on the fund agent's set holds ${name}'s trading money on ${network}: USDC and any registered token the agent buys. Your wallet creates it; only you can withdraw from it, at any time.`
                : `A PersonalAccount on ${network} holds ${name}'s trading money. Your wallet creates it; only you can withdraw from it, at any time.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {allowlisted ? null : (
              <p role="alert" className="text-sm text-warning" data-testid="allowlist-block">
                This wallet is not on the beta deposit allowlist yet, so the account could not take
                deposits. Ask the platform to add it before you open the account.
              </p>
            )}
            <CapsPanel caps={capsView(p)} />
            <GasNotice
              monWei={BigInt(p.wallet.monWei)}
              lowBelowWei={LOW_GAS_WEI}
              network={network}
            />
            <div className="flex flex-wrap gap-2">
              <Button disabled={!allowlisted || acting} onClick={pf.openAccount}>
                Open trading account
              </Button>
            </div>
            <StatusFor status={pf.status} actions={["open"]} />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card>
            <CardContent className="flex flex-col gap-6 pt-6">
              {v3 ? (
                <>
                  <FundOverview {...overviewV3(v3)} />
                  <section
                    aria-label="Positions"
                    className="flex flex-col gap-3"
                    data-testid="positions"
                    data-custody="v3"
                  >
                    <AssetMakeupTable
                      rows={assetRows(v3)}
                      totalValueUsdcE6={v3.navUsdcE6}
                      asOf={null}
                    />
                  </section>
                  {creditsV3.length > 0 ? (
                    <section
                      aria-label="Claimable credits"
                      className="flex flex-col gap-2"
                      data-testid="claimable"
                    >
                      <h3 className="text-base font-semibold">Held for you to claim</h3>
                      <p className="text-sm text-foreground-muted">
                        A transfer out of the account failed, so these tokens are held for you.
                        Claim them to your wallet.
                      </p>
                      {creditsV3.map((c) => (
                        <div key={c.symbol} className="flex flex-wrap items-center gap-3">
                          <span className="numeric text-sm">
                            {tokenUnits(c.amount, c.decimals)} {c.symbol}
                          </span>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={acting}
                            onClick={() =>
                              pf.claimToken({
                                address: c.token,
                                symbol: c.symbol,
                                decimals: c.decimals,
                              })
                            }
                          >
                            Claim {c.symbol}
                          </Button>
                        </div>
                      ))}
                      <StatusFor status={pf.status} actions={["claim"]} />
                    </section>
                  ) : null}
                </>
              ) : v2 ? (
                <>
                  <PortfolioOverview positions={positionsView(v2)} />
                  <PositionsPanel positions={positionsView(v2)} showValue={false} />
                </>
              ) : null}
              {v2 && credits.length > 0 ? (
                <section
                  aria-label="Claimable credits"
                  className="flex flex-col gap-2"
                  data-testid="claimable"
                >
                  <h3 className="text-base font-semibold">Held for you to claim</h3>
                  <p className="text-sm text-foreground-muted">
                    A transfer out of the account failed, so these tokens are held for you. Claim
                    them to your wallet.
                  </p>
                  {credits.map((c) => (
                    <div key={c.asset} className="flex flex-wrap items-center gap-3">
                      <span className="numeric text-sm">
                        {formatAmount(c.amount, DECIMALS[c.asset], { maxFractionDigits: 6 })}{" "}
                        {c.asset}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={acting}
                        onClick={() => pf.claim(c.asset, c.token)}
                      >
                        Claim {c.asset}
                      </Button>
                    </div>
                  ))}
                  <StatusFor status={pf.status} actions={["claim"]} />
                </section>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col gap-6 pt-6">
              <GasNotice
                monWei={BigInt(p.wallet.monWei)}
                lowBelowWei={LOW_GAS_WEI}
                network={network}
              />
              {v3 ? (
                <DepositFormV3
                  p={v3}
                  busy={acting}
                  status={pf.status}
                  onDeposit={pf.depositToken}
                />
              ) : v2 ? (
                <DepositForm p={v2} busy={acting} status={pf.status} onDeposit={pf.deposit} />
              ) : null}
              <CapsPanel caps={capsView(p)} />
              {v3 ? (
                <WithdrawFormV3
                  p={v3}
                  busy={acting}
                  status={pf.status}
                  onWithdraw={pf.withdrawToken}
                  onWithdrawEverything={pf.withdrawEverything}
                />
              ) : v2 ? (
                <WithdrawForm p={v2} busy={acting} status={pf.status} onWithdraw={pf.withdraw} />
              ) : null}
            </CardContent>
          </Card>
        </div>
      )}
      {olderAccount}
      {pf.summary ? (
        <Card data-testid="portfolio-credits" id="credits">
          <CardContent className="pt-6">
            <AddCreditsSection
              agentId={agentId}
              agentName={name}
              environment={environment}
              fundingAddress={(pf.summary.funding?.fundingAddress as Address | undefined) ?? null}
              creditsUsdcE6={pf.summary.credits}
              capUsdcE6={pf.summary.creditCap}
              onCredited={pf.refresh}
            />
          </CardContent>
        </Card>
      ) : null}
      <AgentHoldings agentId={agentId} environment={environment} card />
      {p.account ? (
        <>
          <ArmingCard
            agentName={name}
            arming={{
              state: armingState,
              validUntilDate: pf.arming?.arming.validUntilDate ?? null,
              renewalDue: pf.arming?.arming.renewalDue ?? false,
              endedMessage: pf.arming?.arming.ended?.message ?? null,
              fundingAddress: pf.arming?.fundingAddress ?? null,
            }}
            {...(read && armingState === "unarmed"
              ? {
                  intro:
                    "Every trade the agent proposes waits for your approval until you turn on automatic trading: your wallet registers its trading permission, the agent runs one activation sweep to build its first plan, and approving that plan arms it.",
                }
              : {})}
            actions={
              <>
                {/* F-U10: with the orchestrator reachable, turning trading on runs the sweep (D-291);
                    without it, the P2-U6 arming alone, as before. */}
                {read && !activation ? sweepButton : null}
                {!read && armingState === "unarmed" ? (
                  <Button disabled={acting || !pf.arming?.grantCall} onClick={pf.arm}>
                    Arm
                  </Button>
                ) : null}
                {armingState !== "unarmed" && pf.arming?.arming.renewalDue ? (
                  <Button disabled={acting || !pf.arming?.grantCall} onClick={pf.arm}>
                    Renew
                  </Button>
                ) : null}
                {armingState !== "unarmed" ? (
                  <Button variant="danger" disabled={acting} onClick={pf.disarm}>
                    Disarm
                  </Button>
                ) : null}
              </>
            }
            status={
              activation ? null : (
                <StatusFor status={pf.status} actions={["arm", "turn-on", "disarm"]} />
              )
            }
          >
            {read && canSweep ? (
              <ActivationChecks
                checks={read.checks}
                ceilingUsdcE6={read.ceilingUsdcE6}
                tierLabel={read.tier.label}
              />
            ) : null}
          </ArmingCard>
          {activation ? (
            <ActivationPanel
              view={activation}
              now={now}
              actions={
                activation.outcome.action === "approve" ? (
                  <Button asChild size="sm">
                    <a href="#plan">Read the plan</a>
                  </Button>
                ) : activation.outcome.action === "add_credits" ? (
                  <>
                    {sweepButton}
                    <Button asChild size="sm" variant="secondary">
                      <a href="#credits">Add credits</a>
                    </Button>
                  </>
                ) : activation.outcome.action === "retry" ? (
                  sweepButton
                ) : undefined
              }
              status={<StatusFor status={pf.status} actions={["arm", "turn-on", "disarm"]} />}
              terminal={
                activation.status === "running" ? (
                  <ActivationTerminal agentId={agentId} live />
                ) : undefined
              }
            />
          ) : null}
          {waiting.length > 0 ? (
            <div className="flex flex-col gap-4">
              {waiting.slice(0, 3).map((i) => (
                <ApprovalCard
                  key={i.intentId}
                  approval={approvalView(i, p, network, armingState === "awaiting_first_trade")}
                  actions={
                    armingState === "unarmed" ? (
                      <>
                        <span className="text-sm text-foreground-muted">
                          Arm the agent first; approving needs its trading permission.
                        </span>
                        <Button
                          variant="secondary"
                          disabled={acting}
                          onClick={() => pf.reject(i.intentId)}
                        >
                          Reject
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button disabled={acting} onClick={() => pf.approve(i.intentId)}>
                          {armingState === "awaiting_first_trade" ? "Approve and arm" : "Approve"}
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={acting}
                          onClick={() => pf.reject(i.intentId)}
                        >
                          Reject
                        </Button>
                      </>
                    )
                  }
                />
              ))}
              <StatusFor status={pf.status} actions={["approve", "reject"]} />
            </div>
          ) : (
            <StatusFor status={pf.status} actions={["approve", "reject"]} />
          )}
          {pf.planCard ? (
            <PlanSection
              card={pf.planCard}
              busy={acting}
              onApprove={pf.approveProposal}
              onReject={pf.rejectProposal}
              status={<StatusFor status={pf.status} actions={["approve-plan", "reject-plan"]} />}
            />
          ) : null}
          <section aria-label="Trades" className="flex flex-col gap-3" id="trades">
            <h2 className="text-lg font-semibold">Recent trades</h2>
            <RecentTrades
              trades={pf.intents.slice(0, 10).map((i) => ({
                intentId: i.intentId,
                status: i.status,
                sell: { asset: i.sell.asset, amount: BigInt(i.sell.amountRaw) },
                buy: i.buy,
                amountOut: i.amountOut ? BigInt(i.amountOut.amountRaw) : null,
                txHash: i.txHash,
                approvedBy: i.approvedBy,
                createdAt: i.createdAt,
                settledAt: i.settledAt,
              }))}
            />
          </section>
          <div id="why" className="flex flex-col">
            <WhyNotTraded
              reasons={(pf.why?.reasons ?? []).filter((r) => r.code !== "NOT_ARMED")}
              armingEnded={
                armingState === "unarmed"
                  ? (pf.why?.armingEnded?.message ??
                    "The agent is not armed, so each trade it proposes waits for your approval.")
                  : null
              }
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
