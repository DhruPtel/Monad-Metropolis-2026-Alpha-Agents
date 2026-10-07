"use client";

import { AlertTriangle, Hourglass, LogOut, RotateCcw, Wallet } from "lucide-react";
import type { ReactNode } from "react";
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
  readonly address?: string | undefined;
  /** The wallet's current chain, by name, in the connected state. */
  readonly chainName?: string | undefined;
  /** The connected wallet's name ("MetaMask", "OKX Wallet"), shown beside the address. */
  readonly walletName?: string | undefined;
  /** Owner-facing reason in the error state. */
  readonly errorMessage?: string | undefined;
  /**
   * The short error label. Defaults to "Login failed". Without `onConnect` the
   * error cannot be retried (for example, login is not configured), so no retry
   * button is shown and the label stays visible at every width.
   */
  readonly errorLabel?: string | undefined;
  readonly onConnect?: (() => void) | undefined;
  readonly onDisconnect?: (() => void) | undefined;
  readonly onSwitchChain?: (() => void) | undefined;
  /** Gives up a connect that is waiting; while connecting, shown as Cancel so the spinner always has a way out. */
  readonly onCancel?: (() => void) | undefined;
  readonly className?: string | undefined;
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
  walletName,
  errorMessage,
  errorLabel = "Login failed",
  onConnect,
  onDisconnect,
  onSwitchChain,
  onCancel,
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
          <>
            <Button variant="secondary" size="sm" loading>
              Connecting
            </Button>
            {onCancel ? (
              <Button variant="ghost" size="sm" onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
          </>
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
            {/* From xl to 2xl the app header also holds the nav, so the wallet's
                name takes the chain chip's place there; the header's chain
                indicator and the wrong-chain prompt still cover the network. */}
            {chainName ? (
              <span
                className={cn("hidden sm:inline-flex", walletName && "xl:hidden 2xl:inline-flex")}
              >
                <ChainChip name={chainName} tone="ok" />
              </span>
            ) : null}
            {walletName ? (
              <span
                data-slot="wallet-name"
                className="hidden text-xs whitespace-nowrap text-foreground-muted sm:inline"
              >
                {walletName}
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
              className={cn(
                "items-center gap-1.5 text-xs whitespace-nowrap text-negative",
                onConnect ? "hidden sm:inline-flex" : "inline-flex",
              )}
              title={errorMessage}
            >
              <AlertTriangle aria-hidden className="size-3.5" />
              {errorLabel}
              {errorMessage ? <span className="sr-only">: {errorMessage}</span> : null}
            </span>
            {onConnect ? (
              <Button variant="secondary" size="sm" onClick={onConnect}>
                <RotateCcw aria-hidden />
                Try again
              </Button>
            ) : null}
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

/**
 * What happened to the last network switch (P1-U11): waiting in the wallet,
 * or how it ended when it did not switch. Shown under the prompt so a switch
 * button never fails silently.
 */
export interface SwitchStatus {
  readonly tone: "muted" | "negative";
  readonly text: string;
}

interface WrongChainPromptProps {
  /** The chain this app needs, by name. */
  readonly targetChainName: string;
  /** The chain the wallet is on, by name or ID, if known. */
  readonly currentChainName?: string | undefined;
  /** True while the wallet is asking the user to approve the switch. */
  readonly switching?: boolean | undefined;
  readonly onSwitchChain?: (() => void) | undefined;
  /** The last switch's progress or outcome, if any. */
  readonly status?: SwitchStatus | undefined;
  readonly className?: string | undefined;
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
  status,
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
        {status ? (
          <p
            role="status"
            data-slot="switch-status"
            className={cn(
              "pt-1 text-xs break-words",
              status.tone === "negative" ? "text-negative" : "text-foreground-muted",
            )}
          >
            {status.text}
          </p>
        ) : null}
      </div>
      <Button variant="primary" size="md" loading={switching} onClick={onSwitchChain}>
        Switch to {targetChainName}
      </Button>
    </div>
  );
}

interface WalletNoticeProps {
  readonly title: string;
  readonly children: ReactNode;
  /** Actions for the notice, such as Cancel; rendered at the end. */
  readonly actions?: ReactNode;
  readonly className?: string | undefined;
}

/**
 * What a wallet connect is waiting for (wallet reliability task): shown under
 * the header while a connect waits on the wallet, so the spinner always says
 * what it needs and offers a way out.
 */
function WalletNotice({ title, children, actions, className }: WalletNoticeProps) {
  return (
    <div
      role="status"
      data-slot="wallet-notice"
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-surface p-4 sm:flex-row sm:items-center",
        className,
      )}
    >
      <Hourglass aria-hidden className="size-5 shrink-0 text-foreground-muted" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <div className="text-sm break-words text-foreground-muted">{children}</div>
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}

export { WalletButton, WalletNotice, WrongChainPrompt };
