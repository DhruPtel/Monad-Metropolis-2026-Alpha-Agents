"use client";

import { useEffect, useState } from "react";
import type { EIP1193Provider } from "viem";

/** The part of a wagmi connector this hook uses. */
interface ChainSource {
  getProvider(): Promise<unknown>;
  onChainChanged?(chainId: string): void;
}

/**
 * The chain the wallet is really on, read from its own provider (P1-U11).
 *
 * wagmi caches a connection's chain, and the cache can disagree with the
 * wallet: MetaMask keeps a network per site, and a switch it accepts without
 * a chainChanged event leaves the cache behind. This reads eth_chainId when
 * the connector or wagmi's chain changes, on every chainChanged event and
 * whenever the window regains focus (the user may have changed networks in
 * MetaMask), and moves wagmi's connection to that chain, so wagmi's writes
 * target the chain the wallet is on. Falls back to wagmi's value until the
 * first read.
 */
export function useWalletChainId(
  connector: ChainSource | undefined,
  wagmiChainId: number | undefined,
): number | undefined {
  const [walletChainId, setWalletChainId] = useState<number>();

  useEffect(() => {
    if (!connector) {
      setWalletChainId(undefined);
      return;
    }
    let live = true;
    let provider: EIP1193Provider | undefined;
    const apply = (value: unknown) => {
      const id = Number(value);
      if (!live || !Number.isSafeInteger(id) || id <= 0) return;
      setWalletChainId(id);
      if (id !== wagmiChainId) connector.onChainChanged?.(`0x${id.toString(16)}`);
    };
    const read = () => {
      void provider?.request({ method: "eth_chainId" }).then(apply, () => undefined);
    };
    void connector.getProvider().then(
      (p) => {
        if (!live) return;
        provider = p as EIP1193Provider;
        provider.on?.("chainChanged", apply);
        read();
      },
      () => undefined,
    );
    window.addEventListener("focus", read);
    return () => {
      live = false;
      provider?.removeListener?.("chainChanged", apply);
      window.removeEventListener("focus", read);
    };
  }, [connector, wagmiChainId]);

  return walletChainId ?? wagmiChainId;
}
