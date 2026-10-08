import { formatAmount } from "@alpha-agents/domain";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { AmountDisplay } from "../amount-display";
import { StatBar } from "../stat-bar";
import { Button } from "../ui/button";
import { Field, Input } from "../ui/input";
import { SectionLabel } from "../ui/section-label";

/**
 * "Add credits" (Phase 2 tuning): the owner sends USDC from the connected
 * wallet to the agent's funding address in one transaction, and it becomes
 * credits with no other step. The panel shows the balance, the room left
 * under the per-agent cap, and before anything is sent how much of the amount
 * would be credited and how much held above the cap (held, never lost, and
 * returned with the next refund). The page wires the wallet and the status.
 */

/** How a deposit splits under the cap: the platform's rule (accounting's splitDeposit), for display. */
export function creditSplit(amount: bigint, credits: bigint, cap: bigint) {
  const room = cap - credits > 0n ? cap - credits : 0n;
  const credited = amount < room ? amount : room;
  return { room, credited, held: amount > credited ? amount - credited : 0n };
}

/** Parses whole or decimal USDC, at most 6 decimals; null otherwise. */
export function parseUsdc(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  const [whole = "0", frac = ""] = t.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0") || "0");
}

const usdc = (v: bigint) => formatAmount(v, 6, { minFractionDigits: 2, maxFractionDigits: 6 });

function AddCreditsPanel({
  agentName,
  creditsUsdcE6,
  capUsdcE6,
  walletUsdcE6,
  amountText,
  onAmountChange,
  onAdd,
  disabled = false,
  status,
  className,
}: {
  agentName: string;
  creditsUsdcE6: bigint;
  capUsdcE6: bigint;
  /** The connected wallet's USDC; null while it is being read. */
  walletUsdcE6: bigint | null;
  amountText: string;
  onAmountChange: (text: string) => void;
  onAdd: (amountUsdcE6: bigint) => void;
  disabled?: boolean;
  /** The wallet action's status line, if one is running or just ended. */
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
  const fill =
    capUsdcE6 === 0n
      ? 0
      : Number(((creditsUsdcE6 > capUsdcE6 ? capUsdcE6 : creditsUsdcE6) * 10_000n) / capUsdcE6);
  return (
    <section
      aria-label={`Add credits to ${agentName}`}
      className={cn("flex flex-col gap-3", className)}
      data-testid="add-credits"
    >
      <SectionLabel as="h4">Add credits</SectionLabel>
      <StatBar
        label="Credits"
        value={`${usdc(creditsUsdcE6)} of ${usdc(capUsdcE6)} USDC`}
        fillBps={fill}
      />
      <p className="text-sm text-foreground-muted">
        Room for <span className="numeric text-foreground">{usdc(split.room)}</span> USDC more under
        the beta cap. Your wallet sends the USDC to {agentName}&apos;s funding address in one
        transaction, and it pays for the agent&apos;s research.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Amount (USDC)" className="min-w-40 flex-1" {...(error ? { error } : {})}>
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              placeholder="0.00"
              value={amountText}
              onChange={(e) => onAmountChange(e.target.value)}
            />
          )}
        </Field>
        <Button
          disabled={disabled || amount === null || amount === 0n || overWallet}
          onClick={() => amount !== null && onAdd(amount)}
        >
          Add credits
        </Button>
      </div>
      <p className="text-xs text-foreground-muted">
        In your wallet:{" "}
        {walletUsdcE6 === null ? (
          "reading"
        ) : (
          <AmountDisplay value={walletUsdcE6} decimals={6} maxFractionDigits={2} symbol="USDC" />
        )}
      </p>
      {amount !== null && amount > 0n && split.held > 0n ? (
        <p role="alert" className="text-sm text-warning" data-testid="credit-cap-note">
          {usdc(split.held)} USDC of this is above the {usdc(capUsdcE6)} USDC credit cap: it is held
          for you, not lost, and comes back with your next refund. {usdc(split.credited)} USDC
          becomes credits.
        </p>
      ) : null}
      {status}
    </section>
  );
}

export { AddCreditsPanel };
