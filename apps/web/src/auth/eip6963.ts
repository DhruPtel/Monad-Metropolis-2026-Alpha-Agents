"use client";

import type { EIP1193Provider } from "viem";

/**
 * EIP-6963 wallet discovery: every installed wallet announces itself with its
 * own provider, so the app can tell MetaMask from OKX even when one of them
 * has taken window.ethereum (L-53's root cause 4). Privy does this itself for
 * its login modal; the test build's mock wallets announce the same way, and
 * this collects the announcements.
 */
export interface Eip6963Info {
  readonly uuid: string;
  readonly name: string;
  readonly icon: string;
  /** Reverse-DNS wallet ID: io.metamask, com.okex.wallet. */
  readonly rdns: string;
}

export interface Eip6963Wallet {
  readonly info: Eip6963Info;
  readonly provider: EIP1193Provider;
}

/** Collects announcements now and later; calls back with the wallets known so far. */
export function discoverWallets(onChange: (wallets: readonly Eip6963Wallet[]) => void): () => void {
  const byRdns = new Map<string, Eip6963Wallet>();
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963Wallet>).detail;
    if (!detail?.info?.rdns || !detail.provider) return;
    byRdns.set(detail.info.rdns, detail);
    onChange([...byRdns.values()]);
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
}
