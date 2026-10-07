"use client";

import type { AppChain } from "@alpha-agents/config";
import { toast } from "@alpha-agents/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Address, type EIP1193Provider, createWalletClient, custom, getAddress } from "viem";
import { type WalletSession, deriveState, viemChain } from "./session";
import { useChainSwitch } from "./use-chain-switch";

/**
 * The wallet session's rules, shared by the Privy provider and the test
 * build's mock (wallet reliability task, D-224). Both feed it the same three
 * things: the login (whose wallet and address it belongs to), the wallet the
 * user chose, with that wallet's own EIP-1193 provider (found by EIP-6963, so
 * MetaMask is MetaMask and OKX is OKX whichever one holds window.ethereum),
 * and the login actions. From those it:
 *
 * - reads the account and chain from the chosen wallet's provider, on its
 *   events and whenever the window regains focus, never from a cache;
 * - ends the session the moment that account is not the one the login
 *   belongs to (an account switch in the wallet), or the wallet stops
 *   answering with any account (locked, or the site disconnected), and says
 *   so; nothing is ever read or signed with one wallet's session for another;
 * - sends every request, switch, network check and transaction through the
 *   chosen wallet's provider only;
 * - never leaves a spinner without a way out: a connect that stalls offers
 *   Cancel and says what it is waiting for.
 */
export interface ChosenWallet {
  /** The wallet's name as it announces itself ("MetaMask", "OKX Wallet"). */
  readonly name: string;
  readonly provider: EIP1193Provider;
}

export interface WalletAuth {
  /** The login layer has loaded and knows whether there is a session. */
  readonly ready: boolean;
  readonly authenticated: boolean;
  /** The address the session was created for, or null when there is none. */
  readonly loginAddress: Address | null;
  /** The wallet the session was created with, once its provider is available. */
  readonly wallet: ChosenWallet | null;
  /** A login prompt is open. */
  readonly pending: boolean;
  readonly error: string | undefined;
  login(): void;
  logout(): Promise<void>;
  getAccessToken(): Promise<string | null>;
}

/** After this long without the chosen wallet answering, a connect is called stalled. */
export const STALL_MS = 8_000;
/**
 * After this long with a login window open, the notice says what it waits
 * for; a quick login never flashes it (Cancel shows in the button at once).
 */
export const NOTICE_MS = 1_500;

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Why the session ended, in plain words, when the wallet no longer matches the login. */
export function mismatchNotice(account: string | null, login: string, walletName: string): string {
  if (!account)
    return `${walletName} stopped sharing an account with this site (it may be locked), so you have been logged out. Connect again to continue.`;
  return `${walletName} switched to ${short(account)}. You were logged in as ${short(login)}, so that session has ended. Connect again to use ${short(account)}.`;
}

export function useWalletCore(auth: WalletAuth, target: AppChain, mock: boolean): WalletSession {
  const provider = auth.wallet?.provider ?? null;
  const walletName = auth.wallet?.name;
  // undefined: not read yet; null: the wallet shares no account with the site.
  const [account, setAccount] = useState<Address | null | undefined>(undefined);
  const [chainId, setChainId] = useState<number>();
  const [stalled, setStalled] = useState(false);
  const ending = useRef(false);

  // The chosen wallet's own account and chain, from its provider and its events.
  useEffect(() => {
    setAccount(undefined);
    setChainId(undefined);
    if (!provider) return;
    let live = true;
    const onAccounts = (value: unknown) => {
      if (!live) return;
      const first = Array.isArray(value) ? value[0] : undefined;
      setAccount(typeof first === "string" ? getAddress(first) : null);
    };
    const onChain = (value: unknown) => {
      const id = Number(value);
      if (live && Number.isSafeInteger(id) && id > 0) setChainId(id);
    };
    const read = () => {
      void provider.request({ method: "eth_accounts" }).then(onAccounts, () => undefined);
      void provider.request({ method: "eth_chainId" }).then(onChain, () => undefined);
    };
    provider.on?.("accountsChanged", onAccounts);
    provider.on?.("chainChanged", onChain);
    read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
      window.removeEventListener("focus", read);
    };
  }, [provider]);

  // A wallet that is not (or no longer) the login's ends the session at once.
  const mismatch =
    auth.authenticated &&
    !!auth.loginAddress &&
    account !== undefined &&
    !same(account, auth.loginAddress);
  useEffect(() => {
    if (!mismatch || ending.current || !auth.loginAddress) return;
    ending.current = true;
    toast.info(mismatchNotice(account ?? null, auth.loginAddress, walletName ?? "Your wallet"));
    void auth.logout().finally(() => {
      ending.current = false;
    });
  }, [mismatch, account, auth, walletName]);

  // A session whose wallet never answers is stalled, not loading forever.
  const waiting =
    auth.authenticated && (!provider || account === undefined || chainId === undefined);
  useEffect(() => {
    setStalled(false);
    if (!waiting && !auth.pending) return;
    const timer = window.setTimeout(() => setStalled(true), auth.pending ? NOTICE_MS : STALL_MS);
    return () => window.clearTimeout(timer);
  }, [waiting, auth.pending]);

  const verified = auth.authenticated && !mismatch && same(account, auth.loginAddress);
  const address = verified && account ? account : undefined;
  const state = deriveState({
    initializing: !auth.ready,
    error: auth.error,
    pending: auth.pending || mismatch,
    authenticated: auth.authenticated,
    address,
    chainId,
    targetChainId: target.id,
  });

  const walletRequest = useCallback(
    async (method: string, params: readonly unknown[]) => {
      if (!provider || !verified) throw new Error("The wallet is not connected.");
      return provider.request({ method, params } as never);
    },
    [provider, verified],
  );
  const chainSwitch = useChainSwitch(
    provider && verified ? walletRequest : undefined,
    target,
    chainId === target.id,
  );
  const client = useMemo(
    () =>
      provider && address
        ? createWalletClient({
            chain: viemChain(target),
            transport: custom(provider),
            account: address,
          })
        : null,
    [provider, address, target],
  );

  const cancel = useCallback(() => {
    setStalled(false);
    void auth.logout();
  }, [auth]);

  return {
    state,
    ...(address ? { address } : {}),
    ...(chainId !== undefined && verified ? { chainId } : {}),
    ...(walletName ? { walletName } : {}),
    target,
    ...(auth.error ? { errorMessage: auth.error } : {}),
    ...(state === "connecting" && (stalled || auth.pending) ? { cancel } : {}),
    ...(state === "connecting" && stalled
      ? {
          waitingFor: !auth.ready
            ? "Loading the login."
            : auth.pending
              ? "Finish the login in your wallet's window."
              : `Waiting for ${walletName ?? "your wallet"} to answer. Unlock it, or cancel and connect again.`,
        }
      : {}),
    switching: chainSwitch.busy,
    switchStatus: chainSwitch.status,
    ready: state === "connected",
    mock,
    configured: true,
    connect: () => {
      // A login that exists but whose wallet does not answer is ended first:
      // Privy's login() does nothing while a session exists.
      if (auth.authenticated) void auth.logout().then(() => auth.login());
      else auth.login();
    },
    disconnect: () => void auth.logout(),
    switchChain: chainSwitch.run,
    // A token only for the wallet the session belongs to, never for another.
    getAccessToken: () => (verified ? auth.getAccessToken() : Promise.resolve(null)),
    writeContract: (request) => {
      if (!client) return Promise.reject(new Error("The wallet is not connected."));
      return client.writeContract(request as unknown as Parameters<typeof client.writeContract>[0]);
    },
    walletRequest,
  };
}
