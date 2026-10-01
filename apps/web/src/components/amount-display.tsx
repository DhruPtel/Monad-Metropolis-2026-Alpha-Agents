import { type FormatAmountOptions, formatAmount } from "@alpha-agents/domain";
import { cn } from "@/lib/utils";

interface AmountDisplayProps extends FormatAmountOptions {
  /** The amount in base units, for example USDC with 6 decimals. */
  value: bigint;
  decimals: number;
  /** Shown after the number, for example "USDC" or "WMON". */
  symbol?: string;
  /** Colors the value: lime when above zero, muted red when below. Use only for changes, never balances. */
  colorBySign?: boolean;
  className?: string;
}

/** A bigint amount formatted by packages/domain's formatAmount, in monospace. */
function AmountDisplay({
  value,
  decimals,
  symbol,
  colorBySign = false,
  className,
  ...format
}: AmountDisplayProps) {
  const text = formatAmount(value, decimals, format);
  const tone = colorBySign
    ? value > 0n
      ? "text-positive"
      : value < 0n
        ? "text-negative"
        : ""
    : "";
  return (
    <span data-slot="amount" className={cn("numeric whitespace-nowrap", tone, className)}>
      {text}
      {symbol ? <span className="ml-1 text-foreground-muted">{symbol}</span> : null}
    </span>
  );
}

export { AmountDisplay };
