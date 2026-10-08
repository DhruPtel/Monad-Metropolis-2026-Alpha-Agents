import {
  type ArmingState,
  type AccountMode,
  INTENT_STATES,
  type IntentState,
  REJECTION_CODES,
  type RejectionCode,
  TRADE_FLOW_CODES,
  type TradeFlowCode,
  formatAmount,
} from "@alpha-agents/domain";
import { CircleAlert, CircleCheck, Hourglass, LoaderCircle, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { AddressDisplay } from "../address-display";
import { AmountDisplay } from "../amount-display";
import { ReasonMessage } from "../reason-message";
import { StatBar } from "../stat-bar";
import { StatusPill } from "../status-pill";
import { Badge } from "../ui/badge";
import { SectionLabel } from "../ui/section-label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

/**
 * The owner's portfolio (P2-U7, FINAL_PLAN 4.10): positions, the beta caps,
 * the arming card, the approval card with its deterministic financial
 * fields, recent trades, why the agent did not trade, and the status of a
 * wallet action. Presentational: the web app passes chain and API values in.
 */

type PortfolioAsset = "USDC" | "WMON";
const DECIMALS: Readonly<Record<PortfolioAsset, number>> = { USDC: 6, WMON: 18 };
const DIGITS: Readonly<Record<PortfolioAsset, number>> = { USDC: 2, WMON: 4 };

/** A fixed, timezone-free rendering, so a page reads the same everywhere. */
const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const percent = (bps: number) => `${(bps / 100).toFixed(2)}%`;

function Amount({
  asset,
  value,
  className,
}: {
  asset: PortfolioAsset;
  value: bigint;
  className?: string;
}) {
  return (
    <AmountDisplay
      value={value}
      decimals={DECIMALS[asset]}
      minFractionDigits={asset === "USDC" ? 2 : 0}
      maxFractionDigits={DIGITS[asset]}
      symbol={asset}
      {...(className ? { className } : {})}
    />
  );
}

export interface PositionsView {
  readonly usdc: bigint;
  readonly wmon: bigint;
  /** WMON's value in USDC base units; null when its price is unusable. */
  readonly wmonValueUsdc: bigint | null;
  readonly totalUsdc: bigint | null;
  readonly usdcShareBps: number | null;
  readonly wmonShareBps: number | null;
  readonly mode: AccountMode;
  /** Null when the breaker cannot read the price. */
  readonly drawdownBps: number | null;
  /** The 7-day peak of the value per unit, as a ratio to 1 (1.0 = no gain or loss). */
  readonly peak7d: string | null;
  readonly price: {
    /** MON/USD as text, for example "0.0250". */
    readonly monUsd: string | null;
    readonly ageSeconds: number;
    readonly usable: boolean;
    /** The oracle's reason when it is not usable, for example "STALE". */
    readonly reason: string;
  };
}

/** USDC and WMON held, their value and share, the mode, the breaker and the price's age. */
function PositionsPanel({
  positions: p,
  className,
}: {
  positions: PositionsView;
  className?: string;
}) {
  const rows: {
    asset: PortfolioAsset;
    amount: bigint;
    value: bigint | null;
    share: number | null;
  }[] = [
    { asset: "USDC", amount: p.usdc, value: p.usdc, share: p.usdcShareBps },
    { asset: "WMON", amount: p.wmon, value: p.wmonValueUsdc, share: p.wmonShareBps },
  ];
  return (
    <section
      aria-label="Positions"
      className={cn("flex flex-col gap-4", className)}
      data-testid="positions"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionLabel as="h3">Positions</SectionLabel>
        <StatusPill kind="account_mode" value={p.mode} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-foreground-muted">Account value</span>
        {p.totalUsdc === null ? (
          <span className="text-sm text-foreground-muted">
            Unknown while the WMON price is unavailable
          </span>
        ) : (
          <Amount asset="USDC" value={p.totalUsdc} className="text-2xl" />
        )}
      </div>
      <Table stack label="Holdings">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Asset</TableHead>
            <TableHead scope="col">Amount</TableHead>
            <TableHead scope="col">Value</TableHead>
            <TableHead scope="col">Share</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.asset}>
              <TableCell label="Asset" className="font-medium">
                {r.asset}
              </TableCell>
              <TableCell label="Amount">
                <Amount asset={r.asset} value={r.amount} />
              </TableCell>
              <TableCell label="Value">
                {r.value === null ? (
                  <span className="text-xs text-foreground-muted">Unknown</span>
                ) : (
                  <Amount asset="USDC" value={r.value} />
                )}
              </TableCell>
              <TableCell label="Share" className="numeric">
                {r.share === null ? "Unknown" : percent(r.share)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-foreground-muted">Drawdown from the 7-day peak</dt>
          <dd className="numeric">
            {p.drawdownBps === null ? "Unknown without a price" : percent(p.drawdownBps)}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-foreground-muted">7-day peak, value per unit</dt>
          <dd className="numeric">{p.peak7d ?? "None yet"}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-foreground-muted">MON price</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <span className="numeric">{p.price.monUsd ? `$${p.price.monUsd}` : "Unavailable"}</span>
            {p.price.usable ? (
              <Badge tone="positive">
                <span className="numeric">{`${p.price.ageSeconds}s old`}</span>
              </Badge>
            ) : (
              <Badge tone="warning">{p.price.reason.replace(/_/g, " ").toLowerCase()}</Badge>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export interface CapsView {
  readonly personalCapUsdc: bigint;
  readonly principalUsdc: bigint;
  readonly platformCapUsdc: bigint;
  readonly platformTotalUsdc: bigint;
  /** What may still go in: the smaller of the two rooms. */
  readonly roomUsdc: bigint;
  readonly allowlisted: boolean;
}

/** The beta's deposit limits: how much this account and the platform may still take. */
function CapsPanel({ caps: c, className }: { caps: CapsView; className?: string }) {
  const fill = (part: bigint, whole: bigint) =>
    whole === 0n ? 0 : Number((part * 10_000n) / whole);
  const usdc = (v: bigint) => <Amount asset="USDC" value={v} />;
  const text = (v: bigint) => formatAmount(v, 6, { minFractionDigits: 2 });
  return (
    <section
      aria-label="Deposit limits"
      className={cn("flex flex-col gap-3", className)}
      data-testid="caps"
    >
      <SectionLabel as="h4">Beta deposit limits</SectionLabel>
      <StatBar
        label="This account"
        value={`${text(c.principalUsdc)} of ${text(c.personalCapUsdc)} USDC`}
        fillBps={fill(c.principalUsdc, c.personalCapUsdc)}
      />
      <StatBar
        label="The whole platform"
        value={`${text(c.platformTotalUsdc)} of ${text(c.platformCapUsdc)} USDC`}
        fillBps={fill(c.platformTotalUsdc, c.platformCapUsdc)}
      />
      <p className="flex flex-wrap items-center gap-1 text-sm text-foreground-muted">
        Room for up to {usdc(c.roomUsdc)} more.
        {c.allowlisted ? null : (
          <Badge tone="warning">This wallet is not on the beta allowlist</Badge>
        )}
      </p>
    </section>
  );
}

export interface ArmingView {
  readonly state: ArmingState;
  /** The grant's last day, YYYY-MM-DD. */
  readonly validUntilDate: string | null;
  readonly renewalDue: boolean;
  /** Why the last arming ended, when the agent is not armed now. */
  readonly endedMessage: string | null;
  /** The key the grant names: the agent's funding address. */
  readonly fundingAddress: string | null;
}

const ARMING_TEXT: Readonly<Record<ArmingState, string>> = {
  unarmed:
    "Every trade the agent proposes waits for your approval. Arm it to let trades within its hard limits go through on their own.",
  awaiting_first_trade:
    "Your trading permission is on chain. Approve the agent's first proposed trade to arm it.",
  armed: "Trades within the hard limits go through on their own. You can disarm at any time.",
};

/** The arming card: armed or not, the grant's expiry, a renewal reminder, and the actions. */
function ArmingCard({
  arming: a,
  agentName,
  actions,
  status,
  className,
}: {
  arming: ArmingView;
  agentName: string;
  /** Arm, Disarm or Renew, as the page wires them. */
  actions?: ReactNode;
  /** The wallet action's status line, if one is running or just ended. */
  status?: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={`Arming of ${agentName}`}
      className={cn("flex flex-col gap-3 rounded-md border border-border p-4", className)}
      data-testid="arming-card"
      data-state={a.state}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionLabel as="h3">Automatic trading</SectionLabel>
        <StatusPill kind="arming" value={a.state} />
      </div>
      <p className="text-sm text-foreground-muted">{ARMING_TEXT[a.state]}</p>
      {a.state === "unarmed" && a.endedMessage ? (
        <p className="text-sm text-foreground-muted">Last arming ended: {a.endedMessage}</p>
      ) : null}
      {a.validUntilDate && a.state !== "unarmed" ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-foreground-muted">Permission until</span>
          <span className="numeric">{a.validUntilDate}</span>
          {a.renewalDue ? <Badge tone="warning">Ends soon: renew to keep trading</Badge> : null}
        </p>
      ) : null}
      {a.fundingAddress ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
          The permission names {agentName}&apos;s funding address, and lasts at most 30 days:
          <AddressDisplay address={a.fundingAddress} label={`Funding address of ${agentName}`} />
        </p>
      ) : null}
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      {status}
    </section>
  );
}

export interface ApprovalView {
  readonly intentId: string;
  readonly account: string;
  readonly chainName: string;
  readonly chainId: number;
  readonly sell: {
    readonly asset: PortfolioAsset;
    readonly token: string;
    readonly amount: bigint;
  };
  readonly buy: { readonly asset: PortfolioAsset; readonly token: string };
  /** The venue's quote when it was proposed; null when there was none. */
  readonly expectedOut: bigint | null;
  /** Set at submission from a fresh quote; null before it is sent. */
  readonly minOut: bigint | null;
  /** ISO 8601: the approval expires then. */
  readonly expiresAt: string;
  /** The agent's own words, shown as its reason. */
  readonly reason: string;
  /** The first approval after the grant arms the agent. */
  readonly arms: boolean;
}

/**
 * The approval card: every financial field rendered from the intent itself,
 * never from narration (FINAL_PLAN 4.6.3): account, chain, assets with their
 * addresses, the maximum input, the minimum output rule, and the expiry.
 */
function ApprovalCard({
  approval: v,
  actions,
  status,
  className,
}: {
  approval: ApprovalView;
  actions?: ReactNode;
  status?: ReactNode;
  className?: string;
}) {
  const field = (label: string, value: ReactNode) => (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-foreground-muted">{label}</dt>
      <dd className="min-w-0 text-sm">{value}</dd>
    </div>
  );
  return (
    <section
      aria-label="Trade awaiting your approval"
      className={cn("flex flex-col gap-3 rounded-md border border-warning p-4", className)}
      data-testid="approval-card"
      data-intent={v.intentId}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionLabel as="h4">
          {v.arms ? "Approve the first trade to arm" : "Awaiting your approval"}
        </SectionLabel>
        <StatusPill kind="intent" value="awaiting_approval" />
      </div>
      <dl className="grid gap-3 sm:grid-cols-2">
        {field("Sell, at most", <Amount asset={v.sell.asset} value={v.sell.amount} />)}
        {field(
          "Receive, at least",
          v.minOut === null ? (
            <span className="text-foreground-muted">
              Set when sent: the fresh quote less 0.5%, never under the oracle price
            </span>
          ) : (
            <Amount asset={v.buy.asset} value={v.minOut} />
          ),
        )}
        {field(
          "Quoted when proposed",
          v.expectedOut === null ? (
            "No quote"
          ) : (
            <Amount asset={v.buy.asset} value={v.expectedOut} />
          ),
        )}
        {field("Approval expires", <span className="numeric">{when(v.expiresAt)}</span>)}
        {field("Account", <AddressDisplay address={v.account} label="Trading account" />)}
        {field(
          "Chain",
          <span>
            {v.chainName} <span className="numeric text-foreground-muted">({v.chainId})</span>
          </span>,
        )}
        {field(
          `${v.sell.asset} token`,
          <AddressDisplay address={v.sell.token} label={`${v.sell.asset} token`} />,
        )}
        {field(
          `${v.buy.asset} token`,
          <AddressDisplay address={v.buy.token} label={`${v.buy.asset} token`} />,
        )}
      </dl>
      <p className="text-sm break-words text-foreground-muted">
        The agent&apos;s reason: {v.reason}
      </p>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      {status}
    </section>
  );
}

export interface TradeItem {
  readonly intentId: string;
  readonly status: string;
  readonly sell: { readonly asset: PortfolioAsset; readonly amount: bigint };
  readonly buy: PortfolioAsset;
  /** What it got, once settled. */
  readonly amountOut: bigint | null;
  readonly txHash: string | null;
  readonly approvedBy: "owner" | "auto" | null;
  /** ISO 8601. */
  readonly createdAt: string;
  readonly settledAt: string | null;
}

const isIntentState = (s: string): s is IntentState =>
  (INTENT_STATES as readonly string[]).includes(s);

const SETTLEMENT: Readonly<Partial<Record<IntentState, string>>> = {
  awaiting_approval: "Waiting for approval",
  approved: "Approved; checked again before it is sent",
  submitted: "Sent; waiting for the network",
  confirmed: "Mined; settling",
  rejected: "Not sent",
  expired: "Expired before approval",
  failed: "Did not go through",
  cancelled: "You rejected it",
};

/** The agent's recent trades and proposals, each with its state, amounts, hash and settlement. */
function RecentTrades({ trades, className }: { trades: readonly TradeItem[]; className?: string }) {
  if (trades.length === 0)
    return (
      <p className={cn("text-sm text-foreground-muted", className)} data-testid="recent-trades">
        No trades yet. The agent proposes trades when it runs; they show here.
      </p>
    );
  return (
    <Table stack label="Recent trades" className={className} data-testid="recent-trades">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">State</TableHead>
          <TableHead scope="col">Trade</TableHead>
          <TableHead scope="col">Settlement</TableHead>
          <TableHead scope="col">Transaction</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {trades.map((t) => (
          <TableRow key={t.intentId} data-status={t.status}>
            <TableCell label="State" className="align-top">
              {isIntentState(t.status) ? (
                <StatusPill kind="intent" value={t.status} />
              ) : (
                <Badge>{t.status}</Badge>
              )}
            </TableCell>
            <TableCell label="Trade" className="align-top">
              <span className="flex flex-col gap-1">
                <span className="flex flex-wrap items-center gap-1">
                  Sell <Amount asset={t.sell.asset} value={t.sell.amount} /> for {t.buy}
                </span>
                <time dateTime={t.createdAt} className="numeric text-xs text-foreground-muted">
                  {when(t.createdAt)}
                </time>
              </span>
            </TableCell>
            <TableCell label="Settlement" className="align-top text-sm">
              {t.amountOut !== null && t.status === "reconciled" ? (
                <span className="flex flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-1">
                    Got <Amount asset={t.buy} value={t.amountOut} />
                  </span>
                  <span className="text-xs text-foreground-muted">
                    Settled{t.settledAt ? ` ${when(t.settledAt)}` : ""},{" "}
                    {t.approvedBy === "auto" ? "approved while armed" : "approved by you"}
                  </span>
                </span>
              ) : (
                <span className="text-foreground-muted">
                  {isIntentState(t.status) ? (SETTLEMENT[t.status] ?? t.status) : t.status}
                </span>
              )}
            </TableCell>
            <TableCell label="Transaction" className="align-top">
              {t.txHash ? (
                <span className="numeric text-xs break-all text-foreground-muted">{t.txHash}</span>
              ) : (
                <span className="text-xs text-foreground-muted">None</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export interface BlockedReason {
  readonly code: string;
  readonly clears: string;
  /** ISO 8601, when the chain says when it clears. */
  readonly clearsAt: string | null;
  readonly hint: string;
  /** ISO 8601: when the trade was blocked. */
  readonly at: string;
}

const isReason = (c: string): c is RejectionCode | TradeFlowCode =>
  (REJECTION_CODES as readonly string[]).includes(c) ||
  (TRADE_FLOW_CODES as readonly string[]).includes(c);

const CLEARS_TEXT: Readonly<Record<string, string>> = {
  by_waiting: "clears by waiting",
  by_changing_the_trade: "clears with a different trade",
  by_the_owner: "you can clear it",
  by_the_platform: "the platform clears it",
};

/** Why the agent did not trade: each reason in the owner's words, and when it may clear. */
function WhyNotTraded({
  reasons,
  armingEnded,
  className,
}: {
  reasons: readonly BlockedReason[];
  /** Why the last arming ended, when that is the reason. */
  armingEnded?: string | null;
  className?: string;
}) {
  return (
    <section
      aria-label="Why the agent did not trade"
      className={cn("flex flex-col gap-3", className)}
      data-testid="why-not-traded"
    >
      <SectionLabel as="h3">Why the agent did not trade</SectionLabel>
      {armingEnded ? <p className="text-sm text-foreground-muted">{armingEnded}</p> : null}
      {reasons.length === 0 ? (
        <p className="text-sm text-foreground-muted">
          Nothing blocked a trade in the last 24 hours.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {reasons.map((r) => (
            <li key={`${r.code}-${r.at}`} className="flex flex-col gap-1">
              {isReason(r.code) ? (
                <ReasonMessage
                  code={r.code}
                  detail={`${CLEARS_TEXT[r.clears] ?? r.clears}${r.clearsAt ? ` at ${when(r.clearsAt)}` : ""}`}
                />
              ) : (
                <span className="text-sm">{r.code}</span>
              )}
              <span className="text-xs text-foreground-muted">
                {r.hint}{" "}
                <time dateTime={r.at} className="numeric">
                  {when(r.at)}
                </time>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export type WalletActionState =
  "checking" | "waiting-wallet" | "confirming" | "confirmed" | "rejected" | "failed";

const ACTION_TONE: Readonly<Record<WalletActionState, string>> = {
  checking: "text-foreground-muted",
  "waiting-wallet": "text-warning",
  confirming: "text-foreground-muted",
  confirmed: "text-positive",
  rejected: "text-foreground-muted",
  failed: "text-negative",
};

const ACTION_ICON: Readonly<Record<WalletActionState, typeof Wallet>> = {
  checking: LoaderCircle,
  "waiting-wallet": Wallet,
  confirming: Hourglass,
  confirmed: CircleCheck,
  rejected: CircleAlert,
  failed: CircleAlert,
};

/** One line saying where a wallet action is: waiting in the wallet, confirming, done, declined or failed. */
function WalletActionStatus({
  state,
  text,
  hash,
  className,
}: {
  state: WalletActionState;
  text: string;
  hash?: string | null;
  className?: string;
}) {
  const Icon = ACTION_ICON[state];
  return (
    <p
      role="status"
      data-testid="wallet-action-status"
      data-state={state}
      className={cn("flex items-start gap-2 text-sm", ACTION_TONE[state], className)}
    >
      <Icon
        aria-hidden
        className={cn("mt-0.5 size-4 shrink-0", state === "checking" && "animate-spin")}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span>{text}</span>
        {hash ? (
          <span className="numeric text-xs break-all text-foreground-muted">{hash}</span>
        ) : null}
      </span>
    </p>
  );
}

const ASSET_TONE: Readonly<Record<PortfolioAsset, string>> = {
  USDC: "text-rare",
  WMON: "text-primary",
};
const ASSET_FILL: Readonly<Record<PortfolioAsset, string>> = {
  USDC: "bg-rare",
  WMON: "bg-primary",
};

/**
 * The account's allocation by value as a donut (Phase 2 tuning): USDC in
 * steel, WMON in lime, with the total in the middle and a legend of shares.
 * Unknown while WMON is held and its price is unusable.
 */
function AllocationChart({
  usdcShareBps,
  wmonShareBps,
  totalUsdc,
  className,
}: {
  usdcShareBps: number | null;
  wmonShareBps: number | null;
  totalUsdc: bigint | null;
  className?: string;
}) {
  const known = usdcShareBps !== null && wmonShareBps !== null && totalUsdc !== null;
  const empty = known && totalUsdc === 0n;
  const r = 42;
  const c = 2 * Math.PI * r;
  const wmonLength = known ? (c * wmonShareBps) / 10_000 : 0;
  const label = !known
    ? "Allocation unknown while the WMON price is unavailable"
    : empty
      ? "Allocation: the account is empty"
      : `Allocation by value: USDC ${percent(usdcShareBps)}, WMON ${percent(wmonShareBps)}`;
  return (
    <figure
      className={cn("flex flex-col items-center gap-3 sm:flex-row sm:items-center", className)}
      data-testid="allocation-chart"
    >
      <svg viewBox="0 0 100 100" role="img" aria-label={label} className="size-36 shrink-0">
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          strokeWidth="12"
          className="text-border"
          stroke="currentColor"
        />
        {known && !empty ? (
          <>
            <circle
              cx="50"
              cy="50"
              r={r}
              fill="none"
              strokeWidth="12"
              stroke="currentColor"
              className={ASSET_TONE.USDC}
              transform="rotate(-90 50 50)"
              strokeDasharray={`${c - wmonLength} ${c}`}
            />
            {wmonLength > 0 ? (
              <circle
                cx="50"
                cy="50"
                r={r}
                fill="none"
                strokeWidth="12"
                stroke="currentColor"
                className={ASSET_TONE.WMON}
                transform={`rotate(${-90 + (360 * (usdcShareBps ?? 0)) / 10_000} 50 50)`}
                strokeDasharray={`${wmonLength} ${c}`}
              />
            ) : null}
          </>
        ) : null}
      </svg>
      <figcaption className="flex flex-col gap-2 text-sm">
        {known ? (
          (["USDC", "WMON"] as const).map((asset) => (
            <span key={asset} className="flex items-center gap-2">
              <span aria-hidden className={cn("size-2.5 rounded-full", ASSET_FILL[asset])} />
              <span className="w-12">{asset}</span>
              <span className="numeric">
                {percent(asset === "USDC" ? usdcShareBps : wmonShareBps)}
              </span>
            </span>
          ))
        ) : (
          <span className="text-foreground-muted">{label}</span>
        )}
      </figcaption>
    </figure>
  );
}

/** The allocation as one compact bar, for an agent's card. */
function AllocationBar({
  usdcShareBps,
  className,
}: {
  /** Null while unknown; WMON is the rest. */
  usdcShareBps: number | null;
  className?: string;
}) {
  if (usdcShareBps === null)
    return (
      <span className={cn("text-xs text-foreground-muted", className)}>Allocation unknown</span>
    );
  const wmon = 10_000 - usdcShareBps;
  return (
    <div
      className={cn("flex flex-col gap-1", className)}
      role="img"
      aria-label={`Allocation by value: USDC ${percent(usdcShareBps)}, WMON ${percent(wmon)}`}
      data-testid="allocation-bar"
    >
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-border">
        <span className={ASSET_FILL.USDC} style={{ flexGrow: usdcShareBps }} />
        <span className={ASSET_FILL.WMON} style={{ flexGrow: wmon }} />
      </div>
      <span className="flex justify-between text-xs text-foreground-muted">
        <span>
          USDC <span className="numeric">{percent(usdcShareBps)}</span>
        </span>
        <span>
          WMON <span className="numeric">{percent(wmon)}</span>
        </span>
      </span>
    </div>
  );
}

/**
 * The portfolio at a glance (Phase 2 tuning): the allocation chart, the total
 * value, each asset's share, the account's mode and the price's freshness.
 */
function PortfolioOverview({
  positions: p,
  className,
}: {
  positions: PositionsView;
  className?: string;
}) {
  const tile = (label: string, value: ReactNode) => (
    <div className="flex flex-col gap-1 rounded-md border border-border p-3">
      <span className="text-xs text-foreground-muted">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
  return (
    <section
      aria-label="Portfolio overview"
      className={cn("grid gap-4 md:grid-cols-[auto_minmax(0,1fr)] md:items-center", className)}
      data-testid="portfolio-overview"
    >
      <AllocationChart
        usdcShareBps={p.usdcShareBps}
        wmonShareBps={p.wmonShareBps}
        totalUsdc={p.totalUsdc}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <div className="col-span-2 flex flex-col gap-1 rounded-md border border-border p-3 lg:col-span-1">
          <span className="text-xs text-foreground-muted">Total value</span>
          {p.totalUsdc === null ? (
            <span className="text-sm text-foreground-muted">Unknown without a price</span>
          ) : (
            <Amount asset="USDC" value={p.totalUsdc} className="text-xl" />
          )}
        </div>
        {tile(
          "USDC",
          <span className="numeric">
            {p.usdcShareBps === null ? "Unknown" : percent(p.usdcShareBps)}
          </span>,
        )}
        {tile(
          "WMON",
          <span className="numeric">
            {p.wmonShareBps === null ? "Unknown" : percent(p.wmonShareBps)}
          </span>,
        )}
        {tile("Mode", <StatusPill kind="account_mode" value={p.mode} />)}
        {tile(
          "Price",
          p.price.usable ? (
            <Badge tone="positive">
              <span className="numeric">{`Fresh, ${p.price.ageSeconds}s old`}</span>
            </Badge>
          ) : (
            <Badge tone="warning">{`Unavailable: ${p.price.reason.replace(/_/g, " ").toLowerCase()}`}</Badge>
          ),
        )}
      </div>
    </section>
  );
}

/**
 * The wallet's MON for gas (Phase 2 tuning), with a warning when it is too
 * low to arm, deposit or withdraw. Every one of those is a wallet transaction
 * the wallet pays gas for.
 */
function GasNotice({
  monWei,
  lowBelowWei,
  network,
  className,
}: {
  monWei: bigint;
  lowBelowWei: bigint;
  network: string;
  className?: string;
}) {
  const low = monWei < lowBelowWei;
  const amount = <AmountDisplay value={monWei} decimals={18} maxFractionDigits={4} symbol="MON" />;
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-2 text-sm",
        low ? "text-warning" : "text-foreground-muted",
        className,
      )}
      data-testid="gas-notice"
      data-low={low ? "true" : "false"}
      {...(low ? { role: "alert" } : {})}
    >
      {low ? (
        <>
          Your wallet has {amount} for gas, too little to arm, deposit or withdraw. Add MON on{" "}
          {network} first.
        </>
      ) : (
        <>Gas in your wallet: {amount}</>
      )}
    </p>
  );
}

export {
  AllocationBar,
  AllocationChart,
  GasNotice,
  PortfolioOverview,
  ApprovalCard,
  ArmingCard,
  CapsPanel,
  PositionsPanel,
  RecentTrades,
  WalletActionStatus,
  WhyNotTraded,
};
