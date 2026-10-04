"use client";

import { AlertTriangle, LogOut, RotateCcw, Wallet } from "lucide-react";
import { AddressDisplay } from "./address-display";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

/**
 * The login states every wallet surface shows (P1-U2). Presentational only: the
 * app owns the wallet connection and passes the state and the actions in, so the
 * /design page and the screenshot tests can render every state without a wallet.
 */
export const WALLET_STATES = [
  "logged-out",
  "connecting",
  "wrong-chain",
  "connected",
  "error",
] as const;
export type WalletState = (typeof WALLET_STATES)[number];

interface WalletButtonProps {
  readonly state: WalletState;
  /** The connected address; shown in the wrong-chain and connected states. */
  readonly address?: string;
  /** The wallet's current chain, by name, in the connected state. */
  readonly chainName?: string;
  /** Owner-facing reason in the error state. */
  readonly errorMessage?: string;
  readonly onConnect?: () => void;
  readonly onDisconnect?: () => void;
  readonly onSwitchChain?: () => void;
  readonly className?: string;
}

function ChainChip({ name, tone }: { name: string; tone: "ok" | "wrong" }) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs whitespace-nowrap",
        tone === "ok" ? "border-border text-foreground-muted" : "border-warning text-warning",
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", tone === "ok" ? "bg-positive" : "bg-warning")}
      />
      {name}
    </span>
  );
}

/** The wallet control in the app shell: connect, connecting, wrong chain, connected, error. */
function WalletButton({
  state,
  address,
  chainName,
  errorMessage,
  onConnect,
  onDisconnect,
  onSwitchChain,
  className,
}: WalletButtonProps) {
  const body = (() => {
    switch (state) {
      case "logged-out":
        return (
          <Button variant="secondary" size="sm" onClick={onConnect}>
            <Wallet aria-hidden />
            <span className="hidden sm:inline">Connect wallet</span>
            <span className="sm:hidden">Connect</span>
          </Button>
        );
      case "connecting":
        return (
          <Button variant="secondary" size="sm" loading>
            Connecting
          </Button>
        );
      case "wrong-chain":
        return (
          <>
            <span className="hidden sm:inline-flex">
              <ChainChip name="Wrong network" tone="wrong" />
            </span>
            <Button variant="secondary-accent" size="sm" onClick={onSwitchChain}>
              Switch network
            </Button>
          </>
        );
      case "connected":
        return (
          <>
            {chainName ? (
              <span className="hidden sm:inline-flex">
                <ChainChip name={chainName} tone="ok" />
              </span>
            ) : null}
            {address ? <AddressDisplay address={address} label="Your wallet" /> : null}
            <Button variant="ghost" size="icon" aria-label="Disconnect" onClick={onDisconnect}>
              <LogOut aria-hidden />
            </Button>
          </>
        );
      case "error":
        return (
          <>
            <span
              className="hidden items-center gap-1.5 text-xs text-negative sm:inline-flex"
              title={errorMessage}
            >
              <AlertTriangle aria-hidden className="size-3.5" />
              Login failed
            </span>
            <Button variant="secondary" size="sm" onClick={onConnect}>
              <RotateCcw aria-hidden />
              Try again
            </Button>
          </>
        );
    }
  })();
  return (
    <div
      data-slot="wallet-button"
      data-state={state}
      className={cn("flex items-center gap-2", className)}
    >
      {body}
    </div>
  );
}

interface WrongChainPromptProps {
  /** The chain this app needs, by name. */
  readonly targetChainName: string;
  /** The chain the wallet is on, by name or ID, if known. */
  readonly currentChainName?: string;
  /** True while the wallet is asking the user to approve the switch. */
  readonly switching?: boolean;
  readonly onSwitchChain?: () => void;
  readonly className?: string;
}

/**
 * Blocks the app while the wallet is on the wrong chain: nothing that reads or
 * signs proceeds until the wallet switches (P1-U2).
 */
function WrongChainPrompt({
  targetChainName,
  currentChainName,
  switching = false,
  onSwitchChain,
  className,
}: WrongChainPromptProps) {
  return (
    <div
      role="alert"
      data-slot="wrong-chain-prompt"
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-warning bg-surface p-4 sm:flex-row sm:items-center",
        className,
      )}
    >
      <AlertTriangle aria-hidden className="size-5 shrink-0 text-warning" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-medium text-foreground">Switch to {targetChainName}</p>
        <p className="text-sm text-foreground-muted">
          {currentChainName
            ? `Your wallet is on ${currentChainName}. `
            : "Your wallet is on another network. "}
          Nothing can continue until it is on {targetChainName}.
        </p>
      </div>
      <Button variant="primary" size="md" loading={switching} onClick={onSwitchChain}>
        Switch to {targetChainName}
      </Button>
    </div>
  );
}

export { WalletButton, WrongChainPrompt };
