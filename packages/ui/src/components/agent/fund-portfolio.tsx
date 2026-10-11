import { ArrowDownToLine } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { AmountDisplay } from "../amount-display";
import { StatusPill } from "../status-pill";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SectionLabel } from "../ui/section-label";
import { AllocationDonut, type AssetRow } from "./window";
import type { AccountMode } from "@alpha-agents/domain";

/**
 * The portfolio page on the fund agent's set (after the F-U11 playtest,
 * A-80): the account at a glance across every held token, and the older v2
 * account the owner withdraws from. Presentational: the web app passes the
 * API's values in.
 */

/** The account at a glance: the allocation across every token, the total, the mode and the prices' state. */
function FundOverview({
  rows,
  totalValueUsdcE6,
  mode,
  drawdownBps,
  prices,
  className,
}: {
  rows: readonly AssetRow[];
  /** The account's own value; null while a held token's price is unusable. */
  totalValueUsdcE6: string | null;
  mode: AccountMode;
  drawdownBps: number | null;
  /** How many held tokens have a usable price, and the oldest usable price's age. */
  prices: {
    readonly priced: number;
    readonly held: number;
    readonly oldestAgeSeconds: number | null;
  };
  className?: string;
}) {
  const tile = (label: string, value: ReactNode) => (
    <div className="flex flex-col gap-1 rounded-md border border-border p-3">
      <span className="text-xs text-foreground-muted">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
  const unpriced = prices.held - prices.priced;
  return (
    <section
      aria-label="Portfolio overview"
      className={cn("grid gap-4 md:grid-cols-[auto_minmax(0,1fr)] md:items-center", className)}
      data-testid="portfolio-overview"
      data-custody="v3"
    >
      <AllocationDonut rows={rows} />
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 flex flex-col gap-1 rounded-md border border-border p-3">
          <span className="text-xs text-foreground-muted">Total value</span>
          {totalValueUsdcE6 === null ? (
            <span className="text-sm text-foreground-muted">
              Unknown while a held token has no usable price
            </span>
          ) : (
            <AmountDisplay
              value={BigInt(totalValueUsdcE6)}
              decimals={6}
              minFractionDigits={2}
              symbol="USDC"
              className="text-xl"
            />
          )}
        </div>
        {tile("Mode", <StatusPill kind="account_mode" value={mode} />)}
        {tile(
          "Drawdown from the peak",
          <span className="numeric">
            {drawdownBps === null ? "Unknown" : `${(drawdownBps / 100).toFixed(2)}%`}
          </span>,
        )}
        {tile(
          "Prices",
          prices.held === 0 ? (
            <Badge tone="neutral">Nothing held</Badge>
          ) : unpriced === 0 ? (
            <Badge tone="positive">
              <span className="numeric">
                {prices.oldestAgeSeconds === null
                  ? "Fresh"
                  : `Fresh, ${prices.oldestAgeSeconds}s old at most`}
              </span>
            </Badge>
          ) : (
            <Badge tone="warning">
              {unpriced} of {prices.held} token{prices.held === 1 ? "" : "s"} unpriced
            </Badge>
          ),
        )}
        {tile(
          "Tokens held",
          <span className="numeric">{rows.filter((r) => BigInt(r.amountRaw) > 0n).length}</span>,
        )}
      </div>
    </section>
  );
}

export interface OlderAccountLine {
  readonly symbol: string;
  readonly decimals: number;
  readonly raw: bigint;
  /** Held back for the owner after a transfer that failed. */
  readonly claimableRaw: bigint;
}

/**
 * The agent's trading account from before the fund set (A-80): what it still
 * holds, plainly an older account the agent no longer trades, with one action
 * that moves everything to the owner's wallet so it can go into the new
 * account.
 */
function OlderAccountCard({
  account,
  lines,
  mode,
  busy,
  onWithdrawAll,
  onClaim,
  status,
  className,
}: {
  account: string;
  lines: readonly OlderAccountLine[];
  mode: AccountMode | null;
  busy: boolean;
  onWithdrawAll: () => void;
  onClaim?: (symbol: string) => void;
  status?: ReactNode;
  className?: string;
}) {
  const held = lines.filter((l) => l.raw > 0n);
  const claimable = lines.filter((l) => l.claimableRaw > 0n);
  const empty = held.length === 0 && claimable.length === 0;
  const short = `${account.slice(0, 6)}…${account.slice(-4)}`;
  return (
    <section
      aria-label="Older trading account"
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-warning/40 bg-surface p-4",
        className,
      )}
      data-testid="older-account"
      data-state={empty ? "empty" : "held"}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel as="h3">Older trading account</SectionLabel>
        <span className="flex items-center gap-2">
          {mode ? <StatusPill kind="account_mode" value={mode} /> : null}
          <Badge tone="warning">Not traded any more</Badge>
        </span>
      </div>
      <p className="text-sm text-foreground-muted">
        This agent&apos;s account from before the fund set, at{" "}
        <span className="numeric">{short}</span>. The agent trades the new account only, so what
        sits here does nothing. Withdraw it to your wallet, then deposit it into the new account.
      </p>
      {empty ? (
        <p className="text-sm text-foreground-muted" data-testid="older-account-empty">
          Nothing is left in it.
        </p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="older-account-lines">
          {held.map((l) => (
            <li key={l.symbol} className="flex items-center justify-between gap-3 text-sm">
              <span>{l.symbol}</span>
              <AmountDisplay
                value={l.raw}
                decimals={l.decimals}
                symbol={l.symbol}
                maxFractionDigits={6}
              />
            </li>
          ))}
          {claimable.map((l) => (
            <li
              key={`claim-${l.symbol}`}
              className="flex flex-wrap items-center justify-between gap-3 text-sm"
            >
              <span className="text-foreground-muted">Held for you to claim</span>
              <span className="flex items-center gap-2">
                <AmountDisplay
                  value={l.claimableRaw}
                  decimals={l.decimals}
                  symbol={l.symbol}
                  maxFractionDigits={6}
                />
                {onClaim ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => onClaim(l.symbol)}
                  >
                    Claim {l.symbol}
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {held.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy} onClick={onWithdrawAll} data-testid="older-account-withdraw-all">
            <ArrowDownToLine aria-hidden /> Withdraw all to your wallet
          </Button>
          <span className="text-xs text-foreground-muted">
            One wallet transaction for everything it holds; withdrawals work in every mode.
          </span>
        </div>
      ) : null}
      {status}
    </section>
  );
}

export { FundOverview, OlderAccountCard };
