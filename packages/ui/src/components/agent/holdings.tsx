import { ArrowDownToLine, CircleAlert } from "lucide-react";
import { AddressDisplay } from "../address-display";
import { AmountDisplay } from "../amount-display";
import { Button } from "../ui/button";
import { SectionLabel } from "../ui/section-label";
import { Tag } from "../ui/tag";
import { cn } from "../../lib/utils";
import { type WalletActionState, WalletActionStatus } from "./portfolio";

/**
 * Every balance at each of an agent's addresses (D-315): what each address is
 * for in plain words, what each balance does there, and for anything that
 * sits where it does nothing, plainly so, with a safe way to move it to the
 * owner's wallet when the owner can.
 */
export type HoldingAddressRole = "funding" | "token_bound" | "personal_account";
export type HoldingUse = "gas" | "credits" | "trading" | null;
export type HoldingStatus = "in_use" | "movable" | "platform_only" | "stuck";

export interface HoldingLine {
  readonly symbol: string;
  readonly raw: bigint;
  readonly decimals: number;
  readonly use: HoldingUse;
  readonly status: HoldingStatus;
  /** For a movable line: where its move to the wallet is, if one was started. */
  readonly move?: {
    readonly state: WalletActionState;
    readonly text: string;
    readonly hash?: string | null;
  };
}

export interface HoldingAddress {
  readonly role: HoldingAddressRole;
  /** Null when it does not exist yet. */
  readonly address: string | null;
  readonly lines: readonly HoldingLine[];
}

const ROLE_TEXT: Readonly<
  Record<HoldingAddressRole, { title: string; purpose: string; missing: string }>
> = {
  funding: {
    title: "Funding address",
    purpose:
      "Pays for the agent's work: USDC here is its research credits, and MON here pays the gas for its trades.",
    missing: "Not set up yet. It is created when the agent is ready to run.",
  },
  token_bound: {
    title: "The agent's own account",
    purpose:
      "The account that belongs to the agent NFT itself (its token-bound account). The platform never uses it, so nothing here helps the agent.",
    missing: "Not created yet.",
  },
  personal_account: {
    title: "Trading account",
    purpose:
      "Holds what the agent trades with: your deposits in USDC and the WMON it buys. Only you can withdraw from it.",
    missing: "Not opened yet. Open it on the portfolio page to deposit and trade.",
  },
};

const USE_TAG: Readonly<Record<NonNullable<HoldingUse>, string>> = {
  gas: "Gas",
  credits: "Credits",
  trading: "Trading",
};

const STRANDED_TEXT: Readonly<Record<Exclude<HoldingStatus, "in_use">, string>> = {
  movable: "Does nothing here. You can move it to your wallet.",
  platform_only: "Does nothing here, and only the platform can move it.",
  stuck: "Does nothing here, and nothing can move it.",
};

function Line({
  line,
  network,
  onMove,
}: {
  line: HoldingLine;
  network: string;
  onMove: (() => void) | undefined;
}) {
  const busy =
    line.move?.state === "checking" ||
    line.move?.state === "waiting-wallet" ||
    line.move?.state === "confirming";
  return (
    <li className="flex flex-col gap-2 border-t py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <AmountDisplay
          value={line.raw}
          decimals={line.decimals}
          symbol={line.symbol}
          maxFractionDigits={line.decimals === 6 ? 4 : 6}
          className="text-sm"
        />
        {line.status === "in_use" && line.use ? (
          <Tag>{USE_TAG[line.use]}</Tag>
        ) : (
          <Tag tone="warning">Unused</Tag>
        )}
      </div>
      {line.status !== "in_use" ? (
        <p className="flex items-start gap-2 text-xs text-foreground-muted">
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>{STRANDED_TEXT[line.status]}</span>
        </p>
      ) : null}
      {line.status === "movable" && line.move?.state !== "confirmed" ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={onMove}
            disabled={!onMove || busy}
            loading={busy}
          >
            <ArrowDownToLine aria-hidden />
            Move {line.symbol} to my wallet
          </Button>
          <span className="text-xs text-foreground-muted">
            You sign it in your wallet on {network}; it costs a little MON for gas.
          </span>
        </div>
      ) : null}
      {line.move ? (
        <WalletActionStatus
          state={line.move.state}
          text={line.move.text}
          hash={line.move.hash ?? null}
        />
      ) : null}
    </li>
  );
}

/** Every balance at an agent's addresses, with stranded funds explained and, where possible, movable. */
export function HoldingsPanel({
  addresses,
  network,
  onMove,
  className,
}: {
  readonly addresses: readonly HoldingAddress[];
  /** The wallet's network, for example "Monad Testnet". */
  readonly network: string;
  /** Moves a movable line to the owner's wallet; absent where the viewer cannot sign. */
  readonly onMove?: (role: HoldingAddressRole, symbol: string) => void;
  readonly className?: string;
}) {
  const stranded = addresses.some((a) => a.lines.some((l) => l.status !== "in_use" && l.raw > 0n));
  return (
    <section
      aria-label="All holdings"
      data-testid="holdings-panel"
      className={cn("flex flex-col gap-4", className)}
    >
      <div className="flex flex-col gap-1">
        <SectionLabel as="h3">All holdings</SectionLabel>
        <p className="text-xs text-foreground-muted">
          Everything at each of this agent&apos;s addresses.
          {stranded ? " Some of it does nothing where it is; each line says what you can do." : ""}
        </p>
      </div>
      <ul className="flex flex-col gap-3">
        {addresses.map((a) => {
          const text = ROLE_TEXT[a.role];
          return (
            <li
              key={a.role}
              data-testid={`holdings-${a.role}`}
              className="flex flex-col gap-3 rounded-lg border bg-surface p-4"
            >
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-medium">{text.title}</h4>
                  {a.address ? (
                    <AddressDisplay address={a.address} label={`${text.title} address`} />
                  ) : null}
                </div>
                <p className="text-xs text-foreground-muted">{text.purpose}</p>
              </div>
              {!a.address ? (
                <p className="text-sm text-foreground-muted">{text.missing}</p>
              ) : a.lines.length === 0 ? (
                <p className="text-sm text-foreground-muted">Holds nothing.</p>
              ) : (
                <ul aria-label={`${text.title} balances`} className="flex flex-col">
                  {a.lines.map((line) => (
                    <Line
                      key={line.symbol}
                      line={line}
                      network={network}
                      onMove={onMove ? () => onMove(a.role, line.symbol) : undefined}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
