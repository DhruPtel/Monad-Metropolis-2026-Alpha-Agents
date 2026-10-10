"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { formatAmount } from "@alpha-agents/domain";
import {
  ApprovalCard,
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
} from "@alpha-agents/ui";
import { ArrowLeft, PlugZap, Wallet } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { IntentJson, PortfolioJson } from "@/api/client";
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
import { type ActionStatus, type PortfolioAction, usePortfolio } from "@/agent/use-portfolio";
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

function capsView(p: PortfolioJson) {
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
  p: PortfolioJson,
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

  const header = (
    <div className="flex flex-col gap-2">
      <Link href="/agents" className="flex items-center gap-1 text-sm text-foreground-muted">
        <ArrowLeft aria-hidden className="size-4" /> My Agents
      </Link>
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
  const credits = claimables(p);

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
              A PersonalAccount on {network} holds {name}&apos;s trading money. Your wallet creates
              it; only you can withdraw from it, at any time.
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
              <PortfolioOverview positions={positionsView(p)} />
              <PositionsPanel positions={positionsView(p)} showValue={false} />
              {credits.length > 0 ? (
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
              <DepositForm p={p} busy={acting} status={pf.status} onDeposit={pf.deposit} />
              <CapsPanel caps={capsView(p)} />
              <WithdrawForm p={p} busy={acting} status={pf.status} onWithdraw={pf.withdraw} />
            </CardContent>
          </Card>
        </div>
      )}
      {pf.summary ? (
        <Card data-testid="portfolio-credits">
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
            actions={
              <>
                {armingState === "unarmed" || pf.arming?.arming.renewalDue ? (
                  <Button disabled={acting || !pf.arming?.grantCall} onClick={pf.arm}>
                    {armingState === "unarmed" ? "Arm" : "Renew"}
                  </Button>
                ) : null}
                {armingState !== "unarmed" ? (
                  <Button variant="danger" disabled={acting} onClick={pf.disarm}>
                    Disarm
                  </Button>
                ) : null}
              </>
            }
            status={<StatusFor status={pf.status} actions={["arm", "disarm"]} />}
          />
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
          <section aria-label="Trades" className="flex flex-col gap-3">
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
          <WhyNotTraded
            reasons={(pf.why?.reasons ?? []).filter((r) => r.code !== "NOT_ARMED")}
            armingEnded={
              armingState === "unarmed"
                ? (pf.why?.armingEnded?.message ??
                  "The agent is not armed, so each trade it proposes waits for your approval.")
                : null
            }
          />
        </>
      ) : null}
    </div>
  );
}
