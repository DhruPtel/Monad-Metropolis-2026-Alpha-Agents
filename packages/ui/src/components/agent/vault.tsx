import { type AccountMode, formatAmount, readableDuration } from "@alpha-agents/domain";
import { Landmark, Lock, LockOpen, Users } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { AddressDisplay } from "../address-display";
import { AmountDisplay } from "../amount-display";
import { StatusPill } from "../status-pill";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ChoiceGroup } from "../ui/choice-group";
import { Field, Input } from "../ui/input";
import { creditSplit, parseUsdc } from "./credits";

/**
 * The agent's vault (P7-U4, FINAL_PLAN 4.7): the vault at a glance, a holder's
 * position with the lockup in plain words, the deposit and withdrawal forms
 * (USDC or in kind), "Fund this agent" for people who are not the owner
 * (D-242), and the card that creates a vault. Presentational: the web app
 * reads the chain and the API, decides what blocks an action, and passes the
 * words in. Every amount is a base-unit string.
 */

const usdc = (e6: string | bigint) =>
  formatAmount(BigInt(e6), 6, { minFractionDigits: 2, maxFractionDigits: 2 });
const shares = (e18: string | bigint) =>
  formatAmount(BigInt(e18), 18, { minFractionDigits: 0, maxFractionDigits: 2 });
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
/** "2026-10-12 12:00 UTC" from unix seconds. */
export function whenUtc(seconds: number): string {
  const iso = new Date(seconds * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** The lockup in plain words: "1 day", "36 hours", "7 days". */
export function lockupWords(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  return readableDuration(seconds);
}

/** How a holder's lock stands now, in plain words. */
export function lockWords(unlockAt: number, now: number): string {
  if (unlockAt <= now) return "Free to withdraw";
  return `Locked until ${whenUtc(unlockAt)} (${readableDuration(unlockAt - now)} left)`;
}

export interface VaultPanelView {
  readonly vault: string;
  readonly mode: AccountMode | null;
  readonly inHandover: boolean;
  /** Unix seconds; 0 while the vault is not winding down. */
  readonly windDownAt: number;
  /** The leader's switch. */
  readonly depositsOpen: boolean;
  /** A tightener's switch. */
  readonly depositsClosed: boolean;
  readonly navUsdcE6: string | null;
  readonly totalSupply: string;
  /** The value of one share, 1e18 = 1 USDC; null while unreadable. */
  readonly perUnitE18: string | null;
  readonly lockupSeconds: number;
  readonly leaderStakeBps: number;
  readonly leaderMinBps: number;
  readonly feeBps: number;
  readonly principalUsdcE6: string;
  readonly vaultCapUsdcE6: string;
  readonly allowlistEnabled: boolean;
  readonly depositsEnabled: boolean;
  readonly handoverPeriodSeconds: number;
  /** Unix seconds of the reading's block. */
  readonly asOf: number;
}

/** What the vault's deposits are doing now, in one phrase. */
export function depositsWords(v: VaultPanelView): string {
  if (v.inHandover) return "Closed during the handover";
  if (v.windDownAt !== 0) return "Closed: the vault is winding down";
  if (v.mode === "PAUSED") return "Closed while paused";
  if (v.depositsClosed) return "Closed by a tightener";
  if (!v.depositsOpen) return "Not open yet: the leader opens them after staking";
  if (v.allowlistEnabled || !v.depositsEnabled) return "Open to allowlisted wallets (beta)";
  return "Open";
}

function Notice({
  tone,
  title,
  children,
  testId,
}: {
  tone: "warning" | "negative" | "neutral";
  title: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className={cn(
        "flex flex-col gap-1 rounded-md border p-3 text-sm",
        tone === "warning" && "border-warning/40 bg-warning/10",
        tone === "negative" && "border-negative/40 bg-negative/10",
        tone === "neutral" && "border-border bg-surface",
      )}
    >
      <span className="font-semibold">{title}</span>
      <span className="text-foreground-muted">{children}</span>
    </div>
  );
}

/** The vault at a glance: value, share value, mode, deposits, the lockup, the leader's stake, the cap, the fee, and the beta label. */
function VaultPanel({ v, className }: { v: VaultPanelView; className?: string }) {
  const tile = (label: string, value: ReactNode, testId?: string) => (
    <div className="flex flex-col gap-1 rounded-md border border-border p-3" data-testid={testId}>
      <span className="text-xs text-foreground-muted">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
  const cap = BigInt(v.vaultCapUsdcE6);
  const principal = BigInt(v.principalUsdcE6);
  const room = cap > principal ? cap - principal : 0n;
  return (
    <section
      aria-label="Vault overview"
      className={cn("flex flex-col gap-4", className)}
      data-testid="vault-panel"
      data-mode={v.mode ?? "unknown"}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Landmark aria-hidden className="size-4 text-detail" />
          <span className="text-sm text-foreground-muted">Vault</span>
          <AddressDisplay address={v.vault} label="Vault address" />
        </div>
        <Badge tone="warning">Unaudited beta: allowlisted wallets, small caps</Badge>
      </div>
      {v.inHandover ? (
        <Notice tone="warning" title="The agent changed hands" testId="vault-notice-handover">
          The vault takes no deposits and makes no trades until the new owner stakes at least{" "}
          {pct(v.leaderMinBps)} and accepts management, within{" "}
          {lockupWords(v.handoverPeriodSeconds)} of the sale. Everyone may withdraw at any time.
        </Notice>
      ) : null}
      {v.windDownAt !== 0 ? (
        <Notice tone="warning" title="Winding down" testId="vault-notice-wind-down">
          The leader closed this vault on {whenUtc(v.windDownAt)}. It takes no deposits and only
          reduces positions. Withdraw whenever you like; nothing is locked.
        </Notice>
      ) : null}
      {v.mode === "PAUSED" && !v.inHandover ? (
        <Notice tone="negative" title="Paused" testId="vault-notice-paused">
          A circuit breaker or a tightener paused this vault: no deposits and no trades. Withdrawals
          always work.
        </Notice>
      ) : null}
      {v.mode === "REDUCE_ONLY" && !v.inHandover ? (
        <Notice tone="neutral" title="Reduce only" testId="vault-notice-reduce-only">
          The agent may only sell positions for now. Deposits and withdrawals are not affected.
        </Notice>
      ) : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div
          className="col-span-2 flex flex-col gap-1 rounded-md border border-border p-3"
          data-testid="vault-value"
        >
          <span className="text-xs text-foreground-muted">Total value</span>
          {v.navUsdcE6 === null ? (
            <span className="text-sm text-foreground-muted">
              Unknown while a held token has no usable price
            </span>
          ) : (
            <AmountDisplay
              value={BigInt(v.navUsdcE6)}
              decimals={6}
              minFractionDigits={2}
              symbol="USDC"
              className="text-xl"
            />
          )}
          <span className="text-xs text-foreground-muted">
            as of <span className="numeric">{whenUtc(v.asOf)}</span>
          </span>
        </div>
        {tile(
          "One share is worth",
          v.perUnitE18 === null ? (
            <span className="text-foreground-muted">Unknown</span>
          ) : (
            <span className="numeric">
              {formatAmount(BigInt(v.perUnitE18), 18, {
                minFractionDigits: 4,
                maxFractionDigits: 4,
              })}{" "}
              USDC
            </span>
          ),
          "vault-share-value",
        )}
        {tile(
          "Mode",
          v.mode ? <StatusPill kind="account_mode" value={v.mode} /> : "Unknown",
          "vault-mode",
        )}
        {tile("Deposits", depositsWords(v), "vault-deposits")}
        {tile(
          "Lockup",
          <span>
            <span className="numeric">{lockupWords(v.lockupSeconds)}</span>: every deposit locks all
            of that wallet&apos;s shares for this long, from that deposit
          </span>,
          "vault-lockup",
        )}
        {tile(
          "Leader's stake",
          <span className="numeric">
            {pct(v.leaderStakeBps)} of the vault (at least {pct(v.leaderMinBps)} required)
          </span>,
          "vault-leader-stake",
        )}
        {tile(
          "Room under the cap",
          <span className="numeric">
            {usdc(room)} of {usdc(cap)} USDC
          </span>,
          "vault-cap",
        )}
        {tile("Shares", <span className="numeric">{shares(v.totalSupply)}</span>, "vault-supply")}
        {tile(
          "Exit fee",
          v.feeBps === 0 ? (
            "None"
          ) : (
            <span className="numeric">{pct(v.feeBps)} of gains, paid to the leader on exit</span>
          ),
          "vault-fee",
        )}
      </div>
    </section>
  );
}

export interface TokenAmountView {
  readonly token?: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly amountRaw: string;
}

/** A holder's position: shares, value, the lock in plain words, the in-kind slices, the claimable credits. */
function VaultPositionCard({
  shares: held,
  valueUsdcE6,
  unlockAt,
  now,
  inKind,
  claimables,
  isLeader,
  busy = false,
  onClaim,
  actions,
  status,
  className,
}: {
  shares: string;
  valueUsdcE6: string | null;
  unlockAt: number;
  /** Unix seconds now. */
  now: number;
  inKind: readonly TokenAmountView[] | null;
  claimables: readonly TokenAmountView[];
  isLeader: boolean;
  busy?: boolean;
  onClaim?: (token: string) => void;
  /** The deposit and withdraw buttons. */
  actions?: ReactNode;
  status?: ReactNode;
  className?: string;
}) {
  const none = BigInt(held) === 0n;
  const locked = unlockAt > now && !none;
  return (
    <section
      aria-label="Your position"
      className={cn("flex flex-col gap-3", className)}
      data-testid="vault-position"
      data-state={none ? "none" : locked ? "locked" : "free"}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">Your position</h3>
        {isLeader ? <Badge tone="detail">Leader: your deposits are the stake</Badge> : null}
      </div>
      {none ? (
        <p className="text-sm text-foreground-muted">You hold no shares of this vault.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1 rounded-md border border-border p-3">
            <span className="text-xs text-foreground-muted">Worth now, in USDC</span>
            {valueUsdcE6 === null ? (
              <span className="text-sm text-foreground-muted">
                Unknown while a price is unusable
              </span>
            ) : (
              <AmountDisplay
                value={BigInt(valueUsdcE6)}
                decimals={6}
                minFractionDigits={2}
                symbol="USDC"
              />
            )}
            <span className="text-xs text-foreground-muted numeric">{shares(held)} shares</span>
          </div>
          <div
            className="flex flex-col gap-1 rounded-md border border-border p-3"
            data-testid="vault-lock"
          >
            <span className="text-xs text-foreground-muted">Lock</span>
            <span className="flex items-center gap-1 text-sm">
              {locked ? (
                <Lock aria-hidden className="size-4 text-warning" />
              ) : (
                <LockOpen aria-hidden className="size-4 text-positive" />
              )}
              <span className="numeric">{lockWords(unlockAt, now)}</span>
            </span>
          </div>
          {inKind && inKind.length > 0 ? (
            <div
              className="col-span-2 flex flex-col gap-1 rounded-md border border-border p-3"
              data-testid="vault-in-kind"
            >
              <span className="text-xs text-foreground-muted">
                In kind, your shares are worth this much of each token the vault holds
              </span>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {inKind.map((a) => (
                  <li key={a.symbol} className="numeric">
                    {formatAmount(BigInt(a.amountRaw), a.decimals, { maxFractionDigits: 6 })}{" "}
                    {a.symbol}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
      {claimables.length > 0 ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-3"
          data-testid="vault-claimables"
        >
          <span className="text-sm font-semibold">Credits to claim</span>
          <p className="text-xs text-foreground-muted">
            A token that could not be sent at your exit was kept for you. Claim it to your wallet.
          </p>
          <ul className="flex flex-col gap-2">
            {claimables.map((a) => (
              <li
                key={a.symbol}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span className="numeric">
                  {formatAmount(BigInt(a.amountRaw), a.decimals, { maxFractionDigits: 6 })}{" "}
                  {a.symbol}
                </span>
                {onClaim && a.token ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => onClaim(a.token as string)}
                  >
                    Claim {a.symbol}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      {status}
    </section>
  );
}

/** The deposit form: USDC in, shares out, the lock restated before a top-up. The page passes the blocker and the preview. */
function VaultDepositForm({
  amountText,
  onAmountChange,
  onDeposit,
  walletUsdcE6,
  maxUsdcE6,
  lockupSeconds,
  isLeader,
  spreadBps,
  block,
  topUpWarning,
  previewShares,
  lockUntil,
  disabled = false,
  status,
  className,
}: {
  amountText: string;
  onAmountChange: (text: string) => void;
  onDeposit: (amountUsdcE6: bigint) => void;
  walletUsdcE6: string;
  /** The most this wallet can deposit now: the vault's room and the wallet's USDC. */
  maxUsdcE6: string;
  lockupSeconds: number;
  isLeader: boolean;
  spreadBps: number;
  /** Why nothing can be deposited now, or null. */
  block: string | null;
  /** The warning before a top-up extends the lock, or null when the wallet holds no shares. */
  topUpWarning: string | null;
  /** The shares this amount would mint, or null. */
  previewShares: string | null;
  /** When the shares unlock if deposited now, unix seconds. */
  lockUntil: number;
  disabled?: boolean;
  status?: ReactNode;
  className?: string;
}) {
  const amount = parseUsdc(amountText);
  const max = BigInt(maxUsdcE6);
  const wallet = BigInt(walletUsdcE6);
  const error =
    amountText.trim() === ""
      ? undefined
      : amount === null || amount === 0n
        ? "Enter an amount of USDC greater than zero, with at most 6 decimals."
        : amount > wallet
          ? "Your wallet does not hold that much USDC."
          : amount > max
            ? `The vault can take at most ${usdc(max)} USDC from you now.`
            : undefined;
  const ready = block === null && amount !== null && amount > 0n && error === undefined;
  return (
    <section
      aria-label="Deposit into the vault"
      className={cn("flex flex-col gap-3", className)}
      data-testid="vault-deposit-form"
    >
      <h3 className="text-base font-semibold">{isLeader ? "Stake as the leader" : "Deposit"}</h3>
      <p className="text-sm text-foreground-muted">
        {isLeader
          ? `USDC from your wallet into your agent's vault, as the leader's stake. The stake must stay at least ${pct(500)} of the vault for others to deposit.`
          : `USDC from your wallet into the vault. Shares are priced at the vault's value plus a ${pct(spreadBps)} spread, and every deposit locks all of your shares for ${lockupWords(lockupSeconds)}.`}{" "}
        Your wallet approves exactly this amount, then deposits it.
      </p>
      {block ? (
        <p role="alert" className="text-sm text-warning" data-testid="vault-deposit-block">
          {block}
        </p>
      ) : null}
      {topUpWarning && !block ? (
        <p role="status" className="text-sm text-warning" data-testid="vault-top-up-warning">
          {topUpWarning}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Amount in USDC" className="min-w-40 flex-1" {...(error ? { error } : {})}>
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              placeholder="0.00"
              value={amountText}
              disabled={disabled || block !== null}
              onChange={(e) => onAmountChange(e.target.value)}
            />
          )}
        </Field>
        <Button
          variant="secondary"
          disabled={disabled || block !== null || max === 0n}
          onClick={() =>
            onAmountChange(
              formatAmount(max < wallet ? max : wallet, 6, { maxFractionDigits: 6 }).replace(
                /,/g,
                "",
              ),
            )
          }
        >
          Max
        </Button>
        <Button
          disabled={disabled || !ready}
          onClick={() => amount !== null && onDeposit(amount)}
          data-testid="vault-deposit-submit"
        >
          {isLeader ? "Stake" : "Deposit"}
        </Button>
      </div>
      <p className="text-xs text-foreground-muted">
        In your wallet: <span className="numeric">{usdc(wallet)}</span> USDC
        {previewShares !== null && ready ? (
          <>
            {" "}
            · you would receive about <span className="numeric">{shares(previewShares)}</span>{" "}
            shares, locked until <span className="numeric">{whenUtc(lockUntil)}</span>
          </>
        ) : null}
      </p>
      {status}
    </section>
  );
}

export type WithdrawMethod = "usdc" | "in_kind";

/** The withdrawal form: shares to redeem, paid in USDC or in kind. The page passes the blocker and the previews. */
function VaultWithdrawForm({
  method,
  onMethodChange,
  sharesText,
  onSharesChange,
  freeShares,
  heldShares,
  previewUsdcE6,
  previewInKind,
  usdcAvailableE6,
  block,
  spreadBps,
  onWithdraw,
  disabled = false,
  status,
  className,
}: {
  method: WithdrawMethod;
  onMethodChange: (m: WithdrawMethod) => void;
  sharesText: string;
  onSharesChange: (text: string) => void;
  freeShares: string;
  heldShares: string;
  /** What the entered shares pay on the USDC path, less the spread; null while unknown. */
  previewUsdcE6: string | null;
  /** What the entered shares pay in kind; null while unknown. */
  previewInKind: readonly TokenAmountView[] | null;
  /** How much USDC the vault can pay out now above its floor; null while unknown. */
  usdcAvailableE6: string | null;
  /** Why nothing can be withdrawn now, or null. */
  block: string | null;
  spreadBps: number;
  onWithdraw: (shares: bigint, method: WithdrawMethod) => void;
  disabled?: boolean;
  status?: ReactNode;
  className?: string;
}) {
  const parsed = parseShares(sharesText);
  const free = BigInt(freeShares);
  const usdcShort =
    method === "usdc" &&
    previewUsdcE6 !== null &&
    usdcAvailableE6 !== null &&
    BigInt(previewUsdcE6) > BigInt(usdcAvailableE6);
  const error =
    sharesText.trim() === ""
      ? undefined
      : parsed === null || parsed === 0n
        ? "Enter a number of shares greater than zero, with at most 18 decimals."
        : parsed > free
          ? `You can redeem at most ${shares(free)} shares now.`
          : usdcShort
            ? "The vault cannot pay that much USDC right now. Redeem in kind instead: it always works."
            : undefined;
  const ready = block === null && parsed !== null && parsed > 0n && error === undefined;
  return (
    <section
      aria-label="Withdraw from the vault"
      className={cn("flex flex-col gap-3", className)}
      data-testid="vault-withdraw-form"
      data-method={method}
    >
      <h3 className="text-base font-semibold">Withdraw</h3>
      <p className="text-sm text-foreground-muted">
        Redeem shares for your part of the vault. Nobody can stop a withdrawal: not the leader, not
        the platform, not a pause.
      </p>
      {block ? (
        <p role="alert" className="text-sm text-warning" data-testid="vault-withdraw-block">
          {block}
        </p>
      ) : null}
      <ChoiceGroup<WithdrawMethod>
        legend="Paid as"
        value={method}
        onValueChange={onMethodChange}
        disabled={disabled || block !== null}
        options={[
          {
            value: "usdc",
            title: "USDC",
            description: `The vault pays from its USDC, less a ${pct(spreadBps)} spread. Refused when its USDC cannot cover it.`,
            detail:
              usdcAvailableE6 === null ? undefined : (
                <span className="numeric">{usdc(usdcAvailableE6)} USDC available now</span>
              ),
          },
          {
            value: "in_kind",
            title: "In kind",
            description:
              "Your share of every token the vault holds, sent as those tokens. Works even with every other contract down.",
            note: "Always works",
          },
        ]}
      />
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Shares to redeem" className="min-w-40 flex-1" {...(error ? { error } : {})}>
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              placeholder="0"
              value={sharesText}
              disabled={disabled || block !== null}
              onChange={(e) => onSharesChange(e.target.value)}
            />
          )}
        </Field>
        <Button
          variant="secondary"
          disabled={disabled || block !== null || free === 0n}
          onClick={() =>
            onSharesChange(formatAmount(free, 18, { maxFractionDigits: 18 }).replace(/,/g, ""))
          }
        >
          All
        </Button>
        <Button
          disabled={disabled || !ready}
          onClick={() => parsed !== null && onWithdraw(parsed, method)}
          data-testid="vault-withdraw-submit"
        >
          {method === "usdc" ? "Withdraw USDC" : "Redeem in kind"}
        </Button>
      </div>
      <p className="text-xs text-foreground-muted" data-testid="vault-withdraw-preview">
        You hold <span className="numeric">{shares(heldShares)}</span> shares,{" "}
        <span className="numeric">{shares(free)}</span> free to redeem now.
        {ready && method === "usdc" && previewUsdcE6 !== null ? (
          <>
            {" "}
            You would receive about <span className="numeric">{usdc(previewUsdcE6)}</span> USDC.
          </>
        ) : null}
        {ready && method === "in_kind" && previewInKind ? (
          <>
            {" "}
            You would receive about{" "}
            {previewInKind.map((a, i) => (
              <span key={a.symbol} className="numeric">
                {i > 0 ? ", " : ""}
                {formatAmount(BigInt(a.amountRaw), a.decimals, { maxFractionDigits: 6 })} {a.symbol}
              </span>
            ))}
            .
          </>
        ) : null}
      </p>
      {status}
    </section>
  );
}

/** Parses whole or decimal shares, at most 18 decimals; null otherwise. */
export function parseShares(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t)) return null;
  const [whole = "0", frac = ""] = t.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0") || "0");
}

/** "Fund this agent" for someone who is not the owner (D-242): a contribution to the agent's credits, in plain words (the owner's own panel is my-agent's FundAgentPanel). */
function ContributeCreditsPanel({
  agentName,
  creditsUsdcE6,
  capUsdcE6,
  walletUsdcE6,
  amountText,
  onAmountChange,
  onFund,
  disabled = false,
  status,
  className,
}: {
  agentName: string;
  creditsUsdcE6: bigint;
  capUsdcE6: bigint;
  walletUsdcE6: bigint | null;
  amountText: string;
  onAmountChange: (text: string) => void;
  onFund: (amountUsdcE6: bigint) => void;
  disabled?: boolean;
  status?: ReactNode;
  className?: string;
}) {
  const amount = parseUsdc(amountText);
  const split = creditSplit(amount ?? 0n, creditsUsdcE6, capUsdcE6);
  const overWallet = amount !== null && walletUsdcE6 !== null && amount > walletUsdcE6;
  const error =
    amountText.trim() === ""
      ? undefined
      : amount === null || amount === 0n
        ? "Enter an amount of USDC greater than zero, with at most 6 decimals."
        : overWallet
          ? "Your wallet does not hold that much USDC."
          : undefined;
  return (
    <section
      aria-label="Fund this agent"
      className={cn("flex flex-col gap-3", className)}
      data-testid="fund-agent"
    >
      <div className="flex items-center gap-2">
        <Users aria-hidden className="size-4 text-detail" />
        <h3 className="text-base font-semibold">Fund this agent</h3>
      </div>
      <p className="text-sm text-foreground-muted">
        This is a contribution to {agentName}&apos;s credits, which pay for its research and trading
        work. It is not a deposit into the vault and buys no shares. Credits stay with the agent
        while it is active; when its owner retires it, what is left goes back to every contributor
        in proportion to what they sent, after a 7-day cooldown. A sale of the agent returns
        nothing: the credits stay with it.
      </p>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="flex flex-col gap-1 rounded-md border border-border p-3">
          <span className="text-xs text-foreground-muted">Credits now</span>
          <span className="numeric">{usdc(creditsUsdcE6)} USDC</span>
        </div>
        <div className="flex flex-col gap-1 rounded-md border border-border p-3">
          <span className="text-xs text-foreground-muted">Room under the cap</span>
          <span className="numeric">{usdc(split.room)} USDC</span>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Amount in USDC" className="min-w-40 flex-1" {...(error ? { error } : {})}>
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              placeholder="0.00"
              value={amountText}
              disabled={disabled}
              onChange={(e) => onAmountChange(e.target.value)}
            />
          )}
        </Field>
        <Button
          disabled={disabled || amount === null || amount === 0n || overWallet}
          onClick={() => amount !== null && onFund(amount)}
          data-testid="fund-agent-submit"
        >
          Send USDC
        </Button>
      </div>
      <p className="text-xs text-foreground-muted">
        In your wallet:{" "}
        <span className="numeric">{walletUsdcE6 === null ? "…" : usdc(walletUsdcE6)}</span> USDC
        {amount !== null && amount > 0n && !overWallet ? (
          <>
            {" "}
            · <span className="numeric">{usdc(split.credited)}</span> would be credited
            {split.held > 0n ? (
              <>
                {" "}
                and <span className="numeric">{usdc(split.held)}</span> held above the cap (never
                lost, returned with the next refund)
              </>
            ) : null}
          </>
        ) : null}
      </p>
      {status}
    </section>
  );
}

/** Before a vault exists: the owner creates one; anyone else sees that there is none yet. */
function VaultCreateCard({
  agentName,
  predictedVault,
  isOwner,
  lockupSeconds,
  leaderMinBps,
  vaultCapUsdcE6,
  onCreate,
  disabled = false,
  status,
  className,
}: {
  agentName: string;
  predictedVault: string;
  isOwner: boolean;
  lockupSeconds: number;
  leaderMinBps: number;
  vaultCapUsdcE6: string;
  onCreate?: () => void;
  disabled?: boolean;
  status?: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label="Create a vault"
      className={cn("flex flex-col gap-3", className)}
      data-testid="vault-create"
      data-role={isOwner ? "owner" : "visitor"}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">
          {isOwner ? `Create a vault for ${agentName}` : `${agentName} has no vault yet`}
        </h3>
        <Badge tone="warning">Unaudited beta</Badge>
      </div>
      <p className="text-sm text-foreground-muted">
        {isOwner
          ? `A vault lets other wallets put USDC behind your agent. It trades the vault within the same hard limits as your own account, through the same Executor. You stake first and must keep at least ${pct(leaderMinBps)} of the vault; deposits lock for ${lockupWords(lockupSeconds)}; anyone can leave at any time, in USDC or in kind. The vault holds at most ${usdc(vaultCapUsdcE6)} USDC during the beta.`
          : "Its owner has not created a vault yet. Once there is one, allowlisted wallets can deposit here. You can still fund the agent's credits below."}
      </p>
      <p className="text-xs text-foreground-muted">
        Its address will be <AddressDisplay address={predictedVault} label="Vault address" />
      </p>
      {isOwner ? (
        <div>
          <Button disabled={disabled} onClick={onCreate} data-testid="vault-create-submit">
            Create the vault
          </Button>
        </div>
      ) : null}
      {status}
    </section>
  );
}

export {
  ContributeCreditsPanel,
  VaultCreateCard,
  VaultDepositForm,
  VaultPanel,
  VaultPositionCard,
  VaultWithdrawForm,
};
