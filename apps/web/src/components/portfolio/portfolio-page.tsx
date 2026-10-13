"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import {
  type ManagedAccount,
  formatAmount,
  CHAIN_NAMES,
  chainOfEnvironment,
} from "@alpha-agents/domain";
import {
  ActivationChecks,
  ActivationPanel,
  AmountDisplay,
  ApprovalCard,
  type ApprovalView,
  ArmingCard,
  type AssetRow,
  Button,
  CapsPanel,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  GasNotice,
  GoalSummary,
  Input,
  ManagedAccountChoice,
  NoChangeNotice,
  OlderAccountCard,
  PageLoading,
  PlanCard,
  PortfolioHero,
  RecentTrades,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SetupFlow,
  WalletActionStatus,
  WhyNotTraded,
  AccountValueChart,
  BalancesTable,
  Card,
  CardContent,
  PositionsTable,
  ScoreTiles,
  StatTileRow,
  TabbedPanel,
  monthReturnBps,
} from "@alpha-agents/ui";
import { ArrowDownToLine, ArrowLeft, ArrowUpFromLine, PlugZap, Plus, Wallet } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import type { Address } from "viem";
import type {
  AnyPortfolioJson,
  IntentJson,
  PlanCardJson,
  PortfolioJson,
  PortfolioV3Json,
} from "@/api/client";
import { tradingStateWords } from "@/agent/my-agents";
import { latestDecided, planCardView } from "@/agent/plan-card";
import { setupSteps } from "@/agent/setup-flow";
import { ActivationTerminal } from "./activation-terminal";
import { reportHref } from "@/agent/report-view";
import { useReports } from "@/agent/use-reports";
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
  v2AssetRows,
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

/**
 * The portfolio page (P2-U7, FINAL_PLAN 4.10; redesigned in UI-U1): the owner
 * manages the agent's trading money from their own wallet. A visual hero
 * (the total value, the allocation, the performance line and the mode),
 * automatic trading right under it with every unmet check linked to its
 * action, the guided setup flow, positions as tiles, deposit and withdraw in
 * small dialogs, the plan, the trades and why the agent did not trade. Every
 * value is read through the owner session; every money action is the owner's
 * own wallet transaction.
 */

const toUnits = (raw: string, asset: Asset) =>
  formatAmount(BigInt(raw), DECIMALS[asset], { maxFractionDigits: DECIMALS[asset] });
const usdc2 = (e6: bigint | string) =>
  formatAmount(BigInt(e6), 6, { maxFractionDigits: 2, minFractionDigits: 2 });
/** UX-U1: the top tiles' percent, signed on request. */
const pct = (bps: number, signed = false) =>
  `${signed && bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;

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

/** The blocks that stand on every deposit, whatever the amount: named on the page before the dialog opens. */
const STANDING_BLOCKS: readonly string[] = [
  "NOT_ALLOWLISTED",
  "PAUSED",
  "DEPOSITS_CLOSED",
  "USDC_DEPEGGED",
  "USDC_PRICE_UNAVAILABLE",
  "HELD_PRICE_UNAVAILABLE",
];
function standingBlock(p: AnyPortfolioJson, token?: Address, asset: Asset = "USDC"): string | null {
  if (p.custody === "v3") {
    const first = token ?? depositTokens(p)[0]?.address ?? p.contracts.usdc;
    const b = depositCheckV3(p, first, 1n);
    return b.block && STANDING_BLOCKS.includes(b.block) ? b.message : null;
  }
  const b = depositCheck(p, asset, 1n);
  return b.block && STANDING_BLOCKS.includes(b.block) ? b.message : null;
}

/** The prices' state in one line, for the hero. */
function pricesNote(p: AnyPortfolioJson): string {
  if (p.custody === "v3") {
    const { prices } = overviewV3(p);
    const oldest =
      prices.oldestAgeSeconds === null
        ? ""
        : `; the oldest price is ${prices.oldestAgeSeconds}s old`;
    return `${prices.priced} of ${prices.held} held tokens priced${oldest}.`;
  }
  const pv = positionsView(p);
  return pv.price.usable
    ? `WMON at ${pv.price.monUsd} USD. Fresh, ${pv.price.ageSeconds}s old.`
    : `The WMON price is not usable (${pv.price.reason}), ${pv.price.ageSeconds}s old: its value and the total are unknown until a fresh one arrives.`;
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

/** UI-U1: a form's amount clears the moment its action is confirmed, so no stale value or error outlives a success. */
function useClearOnSuccess(
  status: ActionStatus | null,
  action: PortfolioAction,
  clear: () => void,
) {
  const confirmed = status?.action === action && status.progress.state === "confirmed";
  useEffect(() => {
    if (confirmed) clear();
  }, [confirmed, clear]);
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
  useClearOnSuccess(status, "deposit", () => setText(""));
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
  const standing = standingBlock(p, undefined, asset);
  return (
    <section aria-label="Deposit" className="flex flex-col gap-3" data-testid="deposit-form">
      {standing ? (
        <p role="alert" className="text-sm text-warning" data-testid="deposit-form-block">
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
  useClearOnSuccess(status, "withdraw", () => setText(""));
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
  useClearOnSuccess(status, "deposit", () => setText(""));
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
  const standing = token ? standingBlock(p, token.address) : null;
  return (
    <section
      aria-label="Deposit"
      className="flex flex-col gap-3"
      data-testid="deposit-form"
      data-custody="v3"
    >
      {standing ? (
        <p role="alert" className="text-sm text-warning" data-testid="deposit-form-block">
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
  useClearOnSuccess(status, "withdraw", () => setText(""));
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
      {held.length === 0 ? (
        <p className="text-sm text-foreground-muted" data-testid="withdraw-empty">
          Nothing is held yet. Deposit first; withdrawals come back here at any time.
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

/** A tile in the page's bottom grid: credits, limits, gas, the goal. */
function Tile({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & Record<string, unknown>) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 ${className ?? ""}`}
      {...rest}
    >
      {children}
    </div>
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
  // RP-U1: where the activation's and the plan's research reports are.
  const reportLinks = useReports(agentId).reports?.links ?? null;
  const pf = usePortfolio(agentId, environment);
  const name = `Agent #${agentId.toString()}`;
  const network = wallet.target.name;
  const p = pf.portfolio;
  const acting = pf.acting;
  // F-U10: the moment the panel's elapsed times count to, ticking while the sweep runs.
  const activation = pf.activation?.available ? pf.activation.activation : null;
  const sweeping = activation?.status === "running";
  const [now, setNow] = useState(() => new Date().toISOString());
  // Step 0 (2026-10-12, A-90): with a vault, turning trading on first asks which account the
  // agent manages, in a small dialog; the choice travels with the grant.
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [choice, setChoice] = useState<ManagedAccount>("vault");
  const [choiceFor, setChoiceFor] = useState<"arm" | "turn-on">("turn-on");
  // UI-U1: deposit, withdraw and add credits live in small dialogs opened by compact buttons.
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [creditsOpen, setCreditsOpen] = useState(false);
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
        <Link href={`/agents/${agentId.toString()}/vault`} data-testid="vault-link">
          Vault
        </Link>
        <Link href={`/agents/${agentId.toString()}/skills`} data-testid="skills-link">
          Skills
        </Link>
        <Link href={`/agents/${agentId.toString()}/settings`} data-testid="settings-link">
          Settings
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
          <PageLoading label="Reading the portfolio" />
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
  const accounts = pf.arming?.accounts ?? null;
  // The choice is asked only when there is one to make: the agent has a vault and is not armed.
  const askAccount = armingState === "unarmed" && accounts?.vault !== null && accounts !== null;
  const openChoice = (action: "arm" | "turn-on") => {
    setChoice(accounts?.chosen ?? accounts?.managed ?? "vault");
    setChoiceFor(action);
    setChoiceOpen(true);
  };
  const sweepButton = canSweep ? (
    <Button
      disabled={acting || blocked || (armingState === "unarmed" && !pf.arming?.grantCall)}
      onClick={() => (askAccount ? openChoice("turn-on") : pf.turnOn())}
      data-testid="turn-on"
    >
      {armingState === "unarmed"
        ? "Turn on automatic trading"
        : activation
          ? "Run the sweep again"
          : "Start the activation sweep"}
    </Button>
  ) : null;
  // UI-U1: the trading permission item carries the button that registers it; otherwise the
  // button sits with the card's actions, as before.
  const grantRow =
    read !== null &&
    canSweep &&
    activation === null &&
    read.checks.some((c) => c.code === "GRANT" && !c.ok);

  // UI-U1: the hero's rows, total and series.
  const heroRows: readonly AssetRow[] = v3 ? overviewV3(v3).rows : v2 ? v2AssetRows(v2) : [];
  const heroTotal = v3
    ? v3.navUsdcE6
    : v2
      ? (positionsView(v2).totalUsdc?.toString() ?? null)
      : null;
  const tileRows: readonly AssetRow[] = v3 ? assetRows(v3) : v2 ? v2AssetRows(v2) : [];
  const stateWords = tradingStateWords(armingState);
  const standing = p.account ? standingBlock(p) : null;
  const goalHref = `/agents/${agentId.toString()}/goal`;
  // UX-U1: the top tiles' figures: the month's return on the value per unit, the net deposits
  // (the fund set's principal) and what the account earned over them.
  const monthBps = pf.windowView ? monthReturnBps(pf.windowView.series) : null;
  const principalE6 = v3 ? BigInt(v3.caps.principalUsdcE6) : null;
  const earnedE6 =
    principalE6 !== null && heroTotal !== null ? BigInt(heroTotal) - principalE6 : null;
  const steps = setupSteps(
    {
      allowlisted,
      hasAccount: p.account !== null,
      valueUsdcE6: heroTotal === null ? null : BigInt(heroTotal),
      goalConfigured: pf.summary?.goal ? pf.summary.goal.configured : null,
      armingState,
      custody: p.custody,
    },
    {
      open: (
        <Button size="sm" disabled={!allowlisted || acting} onClick={pf.openAccount}>
          Open trading account
        </Button>
      ),
      deposit: (
        <Button size="sm" onClick={() => setDepositOpen(true)}>
          <ArrowDownToLine aria-hidden /> Deposit
        </Button>
      ),
      goal: (
        <Button asChild size="sm">
          <Link href={goalHref}>Set goal</Link>
        </Button>
      ),
      turnOn: (
        <Button asChild size="sm" variant="secondary">
          <a href="#automatic-trading">Go to automatic trading</a>
        </Button>
      ),
    },
  );
  const setupDone = steps.every((s) => s.state === "done");
  const addCreditsButton = (
    <Button size="sm" variant="secondary" onClick={() => setCreditsOpen(true)}>
      <Plus aria-hidden /> Add credits
    </Button>
  );

  return (
    <div className="flex flex-col gap-6" data-testid="portfolio">
      {header}
      {pf.error ? (
        <p role="alert" className="text-sm text-warning">
          {pf.error} The values below are from the last read.
        </p>
      ) : null}
      {setupDone ? null : <SetupFlow steps={steps} />}
      {!p.account ? (
        <section
          aria-label="Before you open the account"
          className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4"
          data-testid="open-account"
        >
          <p className="text-sm text-foreground-muted">
            {v3
              ? `A trading account on the fund agent's set holds ${name}'s trading money on ${network}: USDC and any registered token the agent buys. Your wallet creates it; only you can withdraw from it, at any time.`
              : `A PersonalAccount on ${network} holds ${name}'s trading money. Your wallet creates it; only you can withdraw from it, at any time.`}
          </p>
          {allowlisted ? null : (
            <p role="alert" className="text-sm text-warning" data-testid="allowlist-block">
              This wallet is not yet allowed to deposit during the beta, so the account could not
              take deposits. Ask the platform to add it, then open the account.
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <CapsPanel caps={capsView(p)} />
            <GasNotice
              monWei={BigInt(p.wallet.monWei)}
              lowBelowWei={LOW_GAS_WEI}
              network={network}
            />
          </div>
          <StatusFor status={pf.status} actions={["open"]} />
        </section>
      ) : (
        <>
          <StatTileRow
            tiles={[
              {
                label: "Total value",
                value: heroTotal === null ? null : `${usdc2(heroTotal)} USDC`,
                note: pf.windowView?.asOf?.live
                  ? "Read live from the chain"
                  : "From the latest reading",
                testId: "tile-total-value",
              },
              {
                label: "Past month",
                value: monthBps === null ? null : pct(monthBps, true),
                tone:
                  monthBps === null
                    ? "neutral"
                    : monthBps > 0
                      ? "positive"
                      : monthBps < 0
                        ? "negative"
                        : "neutral",
                note:
                  monthBps === null
                    ? "Needs two readings over the last 30 days"
                    : "On the value per unit",
                testId: "tile-month-return",
              },
              {
                label: "Your deposits",
                value: principalE6 === null ? null : `${usdc2(principalE6)} USDC`,
                note: principalE6 === null ? "Known on the fund agent's set" : "Net of withdrawals",
                testId: "tile-deposits",
              },
              {
                label: "All-time earned",
                value:
                  earnedE6 === null
                    ? null
                    : `${earnedE6 >= 0n ? "+" : "-"}${usdc2(earnedE6 < 0n ? -earnedE6 : earnedE6)} USDC`,
                tone:
                  earnedE6 === null
                    ? "neutral"
                    : earnedE6 > 0n
                      ? "positive"
                      : earnedE6 < 0n
                        ? "negative"
                        : "neutral",
                note: "Value less your deposits",
                testId: "tile-earned",
              },
            ]}
          />
          <PortfolioHero
            totalValueUsdcE6={heroTotal}
            rows={heroRows}
            series={pf.windowView?.series ?? []}
            mode={p.mode ?? "NORMAL"}
            {...(stateWords ? { state: stateWords } : {})}
            custody={p.custody}
            note={pricesNote(p)}
            actions={
              <>
                <Button onClick={() => setDepositOpen(true)} data-testid="open-deposit">
                  <ArrowDownToLine aria-hidden /> Deposit
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setWithdrawOpen(true)}
                  data-testid="open-withdraw"
                >
                  <ArrowUpFromLine aria-hidden /> Withdraw
                </Button>
                {/* UX-U1: the goal is set from the top of the page, beside the hero's actions. */}
                <Button asChild size="sm" variant="secondary" data-testid="hero-set-goal">
                  <Link href={goalHref}>
                    {pf.summary?.goal?.configured ? "Change goal" : "Set goal"}
                  </Link>
                </Button>
                <Button asChild size="sm" variant="secondary" data-testid="hero-automatic-trading">
                  <a href="#automatic-trading">Automatic trading</a>
                </Button>
                {standing ? (
                  <p
                    role="alert"
                    className="w-full text-sm text-warning"
                    data-testid="deposit-block"
                  >
                    {standing}
                  </p>
                ) : null}
              </>
            }
          />
          {/* UX-U1: the vault-style layout: the left panel of tabs, the right chart, then the ledger. */}
          <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
            <TabbedPanel
              testId="portfolio-about"
              tabs={[
                {
                  id: "about",
                  label: "About",
                  content: (
                    <div className="flex flex-col gap-3 text-sm">
                      <p className="text-foreground-muted">
                        {name} on {network}:{" "}
                        {v3 ? "a trading account on the fund agent's set" : "a PersonalAccount"},
                        traded by the agent within its hard limits; only you can withdraw.
                      </p>
                      {pf.summary?.goal ? (
                        <GoalSummary
                          state={pf.summary.goal.state}
                          aggressiveness={pf.summary.goal.aggressiveness}
                          action={
                            <Button asChild size="sm" variant="secondary">
                              <Link href={goalHref}>
                                {pf.summary.goal.configured ? "Change goal" : "Set goal"}
                              </Link>
                            </Button>
                          }
                        />
                      ) : null}
                      {pf.planCard ? (
                        <p>
                          Its strategy is the plan in force:{" "}
                          <a href="#plan" className="underline">
                            read the plan
                          </a>
                          .
                        </p>
                      ) : (
                        <p className="text-foreground-muted">
                          Its strategy comes from the activation sweep: the plan appears below once
                          it runs.
                        </p>
                      )}
                    </div>
                  ),
                },
                {
                  id: "agent",
                  label: "Agent performance",
                  content: pf.windowView ? (
                    <ScoreTiles scores={pf.windowView.scores} hundred={pf.windowView.hundred} />
                  ) : (
                    <p className="text-sm text-foreground-muted">
                      The scores appear with the first readings.
                    </p>
                  ),
                },
                {
                  id: "yours",
                  label: "Your performance",
                  content: (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                      <dt className="text-foreground-muted">Your deposits</dt>
                      <dd className="numeric">
                        {principalE6 === null ? "–" : `${usdc2(principalE6)} USDC`}
                      </dd>
                      <dt className="text-foreground-muted">Worth now</dt>
                      <dd className="numeric">
                        {heroTotal === null ? "–" : `${usdc2(heroTotal)} USDC`}
                      </dd>
                      <dt className="text-foreground-muted">Earned</dt>
                      <dd
                        className={`numeric ${earnedE6 !== null && earnedE6 > 0n ? "text-positive" : earnedE6 !== null && earnedE6 < 0n ? "text-negative" : ""}`}
                      >
                        {earnedE6 === null
                          ? "–"
                          : `${earnedE6 >= 0n ? "+" : "-"}${usdc2(earnedE6 < 0n ? -earnedE6 : earnedE6)} USDC`}
                      </dd>
                      <dt className="text-foreground-muted">Since</dt>
                      <dd className="numeric">
                        {pf.windowView?.history.from
                          ? pf.windowView.history.from.slice(0, 10)
                          : "the first reading"}
                      </dd>
                    </dl>
                  ),
                },
              ]}
            />
            <Card data-testid="portfolio-chart">
              <CardContent className="pt-6">
                <AccountValueChart
                  series={pf.windowView?.series ?? []}
                  principalUsdcE6={principalE6 === null ? null : principalE6.toString()}
                  emptyAction={
                    <Button size="sm" variant="secondary" onClick={() => setDepositOpen(true)}>
                      Deposit
                    </Button>
                  }
                />
              </CardContent>
            </Card>
          </div>
          <TabbedPanel
            testId="portfolio-ledger"
            defaultTab="positions"
            tabs={[
              {
                id: "balances",
                label: "Balances",
                content: (
                  <BalancesTable
                    rows={tileRows}
                    chain={CHAIN_NAMES[chainOfEnvironment(environment)]}
                  />
                ),
              },
              {
                id: "positions",
                label: "Positions",
                content: (
                  <section
                    aria-label="Positions"
                    className="flex flex-col gap-3"
                    data-testid="positions"
                    data-custody={p.custody}
                    id="positions"
                  >
                    <PositionsTable
                      rows={tileRows}
                      chain={CHAIN_NAMES[chainOfEnvironment(environment)]}
                    />
                    {creditsV3.length > 0 ? (
                      <section
                        aria-label="Claimable credits"
                        className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
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
                    {v2 && credits.length > 0 ? (
                      <section
                        aria-label="Claimable credits"
                        className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
                        data-testid="claimable"
                      >
                        <h3 className="text-base font-semibold">Held for you to claim</h3>
                        <p className="text-sm text-foreground-muted">
                          A transfer out of the account failed, so these tokens are held for you.
                          Claim them to your wallet.
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
                  </section>
                ),
              },
              {
                id: "trades",
                label: "Trade history",
                content: (
                  <section aria-label="Trades" className="flex flex-col gap-3" id="trades">
                    <RecentTrades
                      trades={pf.intents.map((i) => ({
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
                ),
              },
              {
                id: "flows",
                label: "Deposits and withdrawals",
                content: (
                  <div className="flex flex-col gap-2 text-sm">
                    <p>
                      Net deposits so far:{" "}
                      <span className="numeric">
                        {principalE6 === null ? "–" : `${usdc2(principalE6)} USDC`}
                      </span>
                      ; the account is worth{" "}
                      <span className="numeric">
                        {heroTotal === null ? "–" : `${usdc2(heroTotal)} USDC`}
                      </span>
                      .
                    </p>
                    <p className="text-foreground-muted">
                      The list of each deposit and withdrawal, with its date and transaction, comes
                      with the next unit.
                    </p>
                  </div>
                ),
              },
            ]}
          />
          <div id="automatic-trading" className="flex flex-col gap-4">
            <ArmingCard
              agentName={name}
              arming={{
                state: armingState,
                validUntilDate: pf.arming?.arming.validUntilDate ?? null,
                renewalDue: pf.arming?.arming.renewalDue ?? false,
                endedMessage: pf.arming?.arming.ended?.message ?? null,
                fundingAddress: pf.arming?.fundingAddress ?? null,
                managed: accounts?.vault ? accounts.managed : null,
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
                  {read && !activation && !grantRow ? sweepButton : null}
                  {!read && armingState === "unarmed" ? (
                    <Button
                      disabled={acting || !pf.arming?.grantCall}
                      onClick={() => (askAccount ? openChoice("arm") : pf.arm())}
                    >
                      Arm
                    </Button>
                  ) : null}
                  {armingState !== "unarmed" && pf.arming?.arming.renewalDue ? (
                    <Button disabled={acting || !pf.arming?.grantCall} onClick={() => pf.arm()}>
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
                  notes={{
                    GRANT:
                      "The trading permission is not on chain yet. Your wallet registers it when you press Turn on automatic trading.",
                  }}
                  actions={{
                    GOAL: (
                      <Button asChild size="sm" variant="secondary">
                        <Link href={goalHref}>Set goal</Link>
                      </Button>
                    ),
                    TRADING_BALANCE: (
                      <Button size="sm" variant="secondary" onClick={() => setDepositOpen(true)}>
                        Deposit
                      </Button>
                    ),
                    CREDITS: addCreditsButton,
                    GRANT: grantRow ? sweepButton : null,
                  }}
                />
              ) : null}
            </ArmingCard>
            {activation ? (
              <ActivationPanel
                view={activation}
                now={now}
                actions={
                  activation.outcome.action === "approve" ? (
                    <>
                      <Button asChild size="sm">
                        <a href="#plan">Read the plan</a>
                      </Button>
                      {reportLinks?.activation ? (
                        <Button
                          asChild
                          size="sm"
                          variant="secondary"
                          data-testid="activation-report"
                        >
                          <Link href={reportHref(agentId, reportLinks.activation)}>
                            Read the research report
                          </Link>
                        </Button>
                      ) : null}
                    </>
                  ) : activation.status !== "running" && reportLinks?.activation ? (
                    <>
                      <Button asChild size="sm" variant="secondary" data-testid="activation-report">
                        <Link href={reportHref(agentId, reportLinks.activation)}>
                          Read the research report
                        </Link>
                      </Button>
                      {activation.outcome.action === "retry" ? sweepButton : null}
                      {activation.outcome.action === "add_credits" ? addCreditsButton : null}
                    </>
                  ) : activation.outcome.action === "add_credits" ? (
                    <>
                      {sweepButton}
                      {addCreditsButton}
                    </>
                  ) : activation.outcome.action === "retry" ? (
                    sweepButton
                  ) : undefined
                }
                status={<StatusFor status={pf.status} actions={["arm", "turn-on", "disarm"]} />}
                terminal={
                  activation.status === "running" ? (
                    <ActivationTerminal agentId={agentId} live environment={environment} />
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
          </div>
          {reportLinks?.plan ? (
            <p className="text-sm" data-testid="plan-report">
              <Link
                href={reportHref(agentId, reportLinks.plan)}
                className="text-primary underline-offset-4 hover:underline"
              >
                Read the research report behind this plan
              </Link>
            </p>
          ) : null}
          {pf.planCard ? (
            <PlanSection
              card={pf.planCard}
              busy={acting}
              onApprove={pf.approveProposal}
              onReject={pf.rejectProposal}
              status={<StatusFor status={pf.status} actions={["approve-plan", "reject-plan"]} />}
            />
          ) : null}
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
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        {pf.summary ? (
          <Tile data-testid="portfolio-credits" id="credits">
            <span className="text-xs tracking-wide text-foreground-muted uppercase">Credits</span>
            <div className="flex flex-wrap items-baseline gap-2">
              <AmountDisplay
                value={pf.summary.credits}
                decimals={6}
                maxFractionDigits={4}
                symbol="USDC"
                className="text-2xl font-semibold"
              />
              <span className="text-xs text-foreground-muted">
                of {usdc2(pf.summary.creditCap)} during the beta
              </span>
            </div>
            <p className="text-xs text-foreground-muted">
              Credits pay for the agent&apos;s research: the activation sweep and every research
              cycle draw on them, never on the trading account.
            </p>
            <div className="mt-auto flex flex-wrap gap-2">{addCreditsButton}</div>
          </Tile>
        ) : null}
        {pf.summary?.goal ? (
          <Tile aria-label="Goal">
            <span className="text-xs tracking-wide text-foreground-muted uppercase">Goal</span>
            <GoalSummary
              state={pf.summary.goal.state}
              aggressiveness={pf.summary.goal.aggressiveness}
              action={
                <Button asChild size="sm" variant="secondary">
                  <Link href={goalHref}>
                    {pf.summary.goal.configured ? "Change goal" : "Set goal"}
                  </Link>
                </Button>
              }
            />
          </Tile>
        ) : null}
        {p.account ? (
          <>
            <Tile>
              <CapsPanel caps={capsView(p)} />
            </Tile>
            <Tile>
              <GasNotice
                monWei={BigInt(p.wallet.monWei)}
                lowBelowWei={LOW_GAS_WEI}
                network={network}
              />
            </Tile>
          </>
        ) : null}
      </div>
      {olderAccount}
      <AgentHoldings agentId={agentId} environment={environment} card />

      <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
        <DialogContent aria-describedby="deposit-description">
          <DialogHeader>
            <DialogTitle>Deposit into the trading account</DialogTitle>
            <DialogDescription id="deposit-description">
              {v3
                ? "From your wallet: USDC or any registered core token with a price. Your wallet approves exactly this amount, then deposits it."
                : "From your wallet into the trading account. Your wallet approves exactly this amount, then deposits it."}
            </DialogDescription>
          </DialogHeader>
          {v3 ? (
            <DepositFormV3 p={v3} busy={acting} status={pf.status} onDeposit={pf.depositToken} />
          ) : v2 ? (
            <DepositForm p={v2} busy={acting} status={pf.status} onDeposit={pf.deposit} />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <DialogContent aria-describedby="withdraw-description">
          <DialogHeader>
            <DialogTitle>Withdraw to your wallet</DialogTitle>
            <DialogDescription id="withdraw-description">
              At any time and in every mode, even paused or reduce-only. Withdrawals read no price
              and need nothing from the platform.
            </DialogDescription>
          </DialogHeader>
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
        </DialogContent>
      </Dialog>
      {pf.summary ? (
        <Dialog open={creditsOpen} onOpenChange={setCreditsOpen}>
          <DialogContent aria-describedby="credits-description">
            <DialogHeader>
              <DialogTitle>Add credits to {name}</DialogTitle>
              <DialogDescription id="credits-description">
                Your wallet sends USDC to {name}&apos;s funding address in one transaction, and it
                becomes credits with no other step.
              </DialogDescription>
            </DialogHeader>
            <AddCreditsSection
              agentId={agentId}
              agentName={name}
              environment={environment}
              fundingAddress={(pf.summary.funding?.fundingAddress as Address | undefined) ?? null}
              creditsUsdcE6={pf.summary.credits}
              capUsdcE6={pf.summary.creditCap}
              onCredited={pf.refresh}
            />
          </DialogContent>
        </Dialog>
      ) : null}
      <Dialog open={choiceOpen} onOpenChange={setChoiceOpen}>
        <DialogContent aria-describedby="managed-account-description">
          <DialogHeader>
            <DialogTitle>Which account should the agent manage?</DialogTitle>
            <DialogDescription id="managed-account-description">
              This agent has a vault and a personal account. The trading permission your wallet
              registers next serves the one you choose.
            </DialogDescription>
          </DialogHeader>
          <ManagedAccountChoice
            value={choice}
            onValueChange={setChoice}
            vault={accounts?.vault ? { address: accounts.vault } : null}
            personal={accounts?.personal ? { address: accounts.personal } : null}
            disabled={acting}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => setChoiceOpen(false)}>
              Cancel
            </Button>
            <Button
              data-testid="confirm-managed-account"
              disabled={acting}
              onClick={() => {
                setChoiceOpen(false);
                if (choiceFor === "arm") pf.arm(choice);
                else pf.turnOn(choice);
              }}
            >
              {choiceFor === "arm" ? "Arm" : "Turn on automatic trading"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
