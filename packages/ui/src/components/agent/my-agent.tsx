import encodeQR from "@paulmillr/qr";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { AddressDisplay } from "../address-display";
import { AmountDisplay } from "../amount-display";
import type { AccountMode } from "@alpha-agents/domain";
import { StatusPill } from "../status-pill";
import { Badge, type BadgeTone } from "../ui/badge";
import { AllocationBar } from "./portfolio";
import { SectionLabel } from "../ui/section-label";

/**
 * The owner's view of an agent (P1-U9, D-218): what it is doing, how to fund
 * it, and what it has spent. Used by the web app's My Agents page; shown on
 * /design. Every value comes from the control API.
 */
export const RUN_STATUSES = [
  "awaiting_reveal",
  "provisioning",
  "ready",
  "running",
  "restricted",
  "failed",
  "stopped",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STATUS_RENDERING: Readonly<
  Record<RunStatus, { readonly label: string; readonly tone: BadgeTone; readonly meaning: string }>
> = {
  awaiting_reveal: {
    label: "Waiting for reveal",
    tone: "warning",
    meaning: "Its species and tier are drawn at reveal; setup starts right after",
  },
  provisioning: {
    label: "Setting up",
    tone: "warning",
    meaning: "The platform is preparing its configuration and model key",
  },
  ready: {
    label: "Ready",
    tone: "positive",
    meaning: "Set up and funded; it researches on schedule",
  },
  running: { label: "Running", tone: "detail-solid", meaning: "Working in its sandbox right now" },
  restricted: {
    label: "Paused: no credits",
    tone: "negative",
    meaning: "Research is paused until it has credits; safety checks keep running",
  },
  failed: {
    label: "Setup failed",
    tone: "negative",
    meaning: "Setup failed and is retried automatically",
  },
  stopped: { label: "Stopped", tone: "neutral", meaning: "Not set up to run" },
};

/** What the agent is doing, with its meaning as the title. */
function RunStatusBadge({ status }: { status: RunStatus }) {
  const r = RUN_STATUS_RENDERING[status];
  return (
    <Badge tone={r.tone} title={r.meaning} data-run-status={status}>
      {r.label}
    </Badge>
  );
}

/**
 * A QR code of a value, drawn as SVG in the design tokens: dark modules on a
 * light quiet zone, which every scanner reads. It encodes exactly the value
 * given (an address), never a payment request with an amount or a chain.
 */
function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const modules = encodeQR(value, "raw", { ecc: "medium", border: 0 });
  const size = modules.length;
  const quiet = 4;
  const total = size + quiet * 2;
  const path = modules
    .flatMap((row, y) =>
      row.map((on, x) => (on ? `M${x + quiet} ${y + quiet}h1v1h-1z` : "")).filter(Boolean),
    )
    .join("");
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      className={cn("aspect-square w-full max-w-40 rounded-sm", className)}
      data-qr-value={value}
    >
      <rect width={total} height={total} className="fill-foreground" />
      <path d={path} className="fill-background" />
    </svg>
  );
}

export interface FundingView {
  readonly fundingAddress: string;
  /** Spendable credits, in USDC base units. */
  readonly spendableUsdcE6: bigint;
  /** Deposited above the beta cap: held, never spent, returned by a refund. */
  readonly heldUsdcE6: bigint;
}

/** The agent's trading account in "Fund your agent" (P2-U7): its value, or that none is open. */
export interface TradingSummaryView {
  /** Null before the owner opens the account. */
  readonly hasAccount: boolean;
  /** The account's value in USDC base units; null while it cannot be priced. */
  readonly valueUsdcE6: bigint | null;
  /** USDC's share of the value in basis points; null while unknown or absent (Phase 2 tuning). */
  readonly usdcShareBps?: number | null;
  readonly mode?: AccountMode | null;
}

/**
 * "Fund your agent" (FINAL_PLAN 5.7): send USDC to the funding address and it
 * becomes credits with no other step. Trading capital is a separate balance
 * in the PersonalAccount (P2-U7), which only the owner can withdraw from; the
 * two never mix.
 */
function FundAgentPanel({
  agentName,
  funding,
  trading,
  tradingAction,
  addCredits,
  className,
}: {
  agentName: string;
  /** Null until the platform has recorded the funding address. */
  funding: FundingView | null;
  /** The trading account; null while it is being read or where trading is not deployed. */
  trading?: TradingSummaryView | null;
  /** A link to the portfolio, as the app routes it. */
  tradingAction?: ReactNode;
  /** The add-credits form, as the app wires it (Phase 2 tuning). */
  addCredits?: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={`Fund ${agentName}`}
      className={cn("flex flex-col gap-4", className)}
      data-testid="fund-panel"
    >
      <SectionLabel as="h4">Fund your agent</SectionLabel>
      {funding ? (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <QrCode
            value={funding.fundingAddress}
            label={`QR code of ${agentName}'s funding address`}
            className="max-w-32 self-center sm:self-start"
          />
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-foreground-muted">Credits</span>
              <AmountDisplay
                value={funding.spendableUsdcE6}
                decimals={6}
                maxFractionDigits={4}
                symbol="USDC"
                className="text-lg"
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-foreground-muted">Funding address</span>
              <AddressDisplay
                address={funding.fundingAddress}
                label={`Funding address of ${agentName}`}
              />
              <p className="text-xs text-foreground-muted">
                Send USDC on Monad to this address. It becomes {agentName}&apos;s credits with no
                other step, and pays for its research.
              </p>
            </div>
            {funding.heldUsdcE6 > 0n ? (
              <p className="flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
                <Badge tone="warning">
                  <AmountDisplay value={funding.heldUsdcE6} decimals={6} symbol="USDC" /> held
                </Badge>
                Credits are capped at 50 USDC during the beta. USDC above the cap is held, never
                spent, and returned with your next refund.
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-sm text-foreground-muted">
          The funding address appears here as soon as the platform has set it up.
        </p>
      )}
      <div
        className="flex flex-col gap-2 rounded-md border border-border p-3"
        data-testid="trading-summary"
      >
        <span className="text-xs text-foreground-muted">Trading account</span>
        {trading?.hasAccount ? (
          trading.valueUsdcE6 === null ? (
            <p className="text-sm text-foreground-muted">
              Value unknown while the WMON price is unavailable.
            </p>
          ) : (
            <AmountDisplay
              value={trading.valueUsdcE6}
              decimals={6}
              minFractionDigits={2}
              symbol="USDC"
              className="text-lg"
            />
          )
        ) : (
          <p className="text-sm text-foreground-muted">
            {trading === undefined || trading === null
              ? "Trading capital lives in an account only you can withdraw from, separate from credits."
              : "No trading account yet. Open one to deposit trading capital, separate from credits."}
          </p>
        )}
        {trading?.hasAccount ? (
          <div className="flex flex-col gap-2">
            {trading.usdcShareBps !== undefined ? (
              <AllocationBar usdcShareBps={trading.usdcShareBps} />
            ) : null}
            {trading.mode ? <StatusPill kind="account_mode" value={trading.mode} /> : null}
          </div>
        ) : null}
        {tradingAction}
      </div>
      {addCredits}
    </section>
  );
}

export interface ChargeItem {
  readonly entryId: string;
  /** ISO 8601. */
  readonly at: string;
  readonly kind: "model" | "tool" | "reversal";
  /** The model alias or the tool name. */
  readonly label: string;
  /** Credits taken (positive) or given back (negative), in USDC base units. */
  readonly amountUsdcE6: bigint;
}

const CHARGE_KIND: Record<ChargeItem["kind"], string> = {
  model: "Model call",
  tool: "Tool call",
  reversal: "Given back",
};

/** A fixed, timezone-free rendering, so a page reads the same everywhere. */
const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** Credits spent in the last 24 hours, and the recent charges behind them. */
function SpendPanel({
  agentName,
  spent24hUsdcE6,
  charges,
  className,
}: {
  agentName: string;
  spent24hUsdcE6: bigint;
  charges: readonly ChargeItem[];
  className?: string;
}) {
  return (
    <section
      aria-label={`Spend of ${agentName}`}
      className={cn("flex flex-col gap-3", className)}
      data-testid="spend-panel"
    >
      <SectionLabel as="h4">Spend</SectionLabel>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-foreground-muted">Last 24 hours</span>
        {/* Calls cost fractions of a cent: four decimals, truncated, never overstated. */}
        <AmountDisplay value={spent24hUsdcE6} decimals={6} maxFractionDigits={4} symbol="USDC" />
      </div>
      {charges.length === 0 ? (
        <p className="text-sm text-foreground-muted">No charges yet.</p>
      ) : (
        <ol
          aria-label={`Recent charges of ${agentName}`}
          className="flex flex-col divide-y divide-border"
        >
          {charges.map((c) => (
            <li key={c.entryId} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="flex min-w-0 flex-col">
                <span className="truncate">
                  {CHARGE_KIND[c.kind]}: <span className="font-mono text-xs">{c.label}</span>
                </span>
                <time dateTime={c.at} className="numeric text-xs text-foreground-muted">
                  {when(c.at)}
                </time>
              </span>
              <AmountDisplay
                value={-c.amountUsdcE6}
                decimals={6}
                maxFractionDigits={4}
                symbol="USDC"
                colorBySign={c.kind === "reversal"}
                className="shrink-0"
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export { FundAgentPanel, QrCode, RunStatusBadge, SpendPanel };
