"use client";

import type { EnvironmentId } from "@alpha-agents/config";
import { webAppChain } from "./app-chain";
import {
  type PrivyErrorCode,
  PrivyProvider,
  useLogin,
  usePrivy,
  useWallets,
} from "@privy-io/react-auth";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type Address, type EIP1193Provider, getAddress, isAddress } from "viem";
import { discoverWallets, type Eip6963Wallet } from "./eip6963";
import { type WalletSession, WalletSessionContext } from "./session";
import { useWalletCore, type WalletAuth } from "./wallet-core";

interface WalletProviderProps {
  /** The public Privy app ID, or undefined when login is not configured. */
  readonly appId: string | undefined;
  readonly environment: EnvironmentId;
  readonly children: ReactNode;
}

/** Owner-facing text for a failed login. Closing the modal is not a failure. */
function loginErrorMessage(code: PrivyErrorCode): string | undefined {
  if (code === "exited_auth_flow") return undefined;
  return "The wallet did not complete the login. Unlock your wallet and try again.";
}

/** Privy's wallet IDs for the wallets in its list, by their EIP-6963 rdns. */
const RDNS_OF: Readonly<Record<string, string>> = {
  metamask: "io.metamask",
  okx_wallet: "com.okex.wallet",
};

/**
 * Reads Privy into the shared wallet core (wallet-core.ts). The login names
 * its wallet (user.wallet: walletClientType and address); that wallet's own
 * provider is found by its EIP-6963 announcement (rdns), so choosing MetaMask
 * uses MetaMask and choosing OKX uses OKX, whichever holds window.ethereum.
 * Privy's own provider for the wallet is the fallback when the wallet does
 * not announce itself.
 */
function PrivySessionBridge({
  environment,
  children,
}: {
  environment: EnvironmentId;
  children: ReactNode;
}) {
  const target = webAppChain(environment);
  const { ready, authenticated, user, logout, getAccessToken } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [announced, setAnnounced] = useState<readonly Eip6963Wallet[]>([]);
  useEffect(() => discoverWallets(setAnnounced), []);
  const { login } = useLogin({
    onComplete: () => {
      setPending(false);
      setError(undefined);
    },
    onError: (code) => {
      setPending(false);
      setError(loginErrorMessage(code));
    },
  });

  const raw = user?.wallet?.address;
  const loginAddress: Address | null = raw && isAddress(raw) ? getAddress(raw) : null;
  const clientType = user?.wallet?.walletClientType;
  // Privy's entry for the login's wallet: by wallet type (the address in it
  // follows an account switch, the login's does not), else by address.
  const connected = useMemo(
    () =>
      wallets.find((w) => w.walletClientType === clientType) ??
      wallets.find((w) => !!loginAddress && w.address.toLowerCase() === loginAddress.toLowerCase()),
    [wallets, clientType, loginAddress],
  );
  const rdns = (clientType && RDNS_OF[clientType]) ?? connected?.meta.id ?? clientType;
  const own = announced.find((w) => w.info.rdns === rdns);
  const [fallback, setFallback] = useState<EIP1193Provider | null>(null);
  useEffect(() => {
    setFallback(null);
    if (own || !connected) return;
    let live = true;
    void connected.getEthereumProvider().then(
      (p) => live && setFallback(p as EIP1193Provider),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [own, connected]);
  const provider = own?.provider ?? fallback;
  const name = own?.info.name ?? connected?.meta.name;
  const wallet = useMemo(
    () => (provider ? { name: name ?? "Your wallet", provider } : null),
    [provider, name],
  );

  const auth: WalletAuth = useMemo(
    () => ({
      ready: ready && (!authenticated || walletsReady),
      authenticated,
      loginAddress,
      wallet,
      pending,
      error,
      login: () => {
        setError(undefined);
        setPending(true);
        login();
      },
      logout: async () => {
        setPending(false);
        setError(undefined);
        await logout();
      },
      getAccessToken,
    }),
    [
      ready,
      authenticated,
      walletsReady,
      loginAddress,
      wallet,
      pending,
      error,
      login,
      logout,
      getAccessToken,
    ],
  );
  const session = useWalletCore(auth, target, false);
  return <WalletSessionContext.Provider value={session}>{children}</WalletSessionContext.Provider>;
}

/** Shown when PRIVY_APP_ID is not set: the shell explains instead of failing. */
function UnconfiguredSession({
  environment,
  children,
}: {
  environment: EnvironmentId;
  children: ReactNode;
}) {
  const session: WalletSession = {
    state: "error",
    target: webAppChain(environment),
    errorMessage:
      "Wallet login is not configured: set a 25-character PRIVY_APP_ID in the root .env and start the app with pnpm dev:web.",
    switching: false,
    ready: false,
    mock: false,
    configured: false,
    connect: () => undefined,
    disconnect: () => undefined,
    switchChain: () => undefined,
    getAccessToken: () => Promise.resolve(null),
    writeContract: () => Promise.reject(new Error("Wallet login is not configured.")),
    walletRequest: () => Promise.reject(new Error("Wallet login is not configured.")),
  };
  return <WalletSessionContext.Provider value={session}>{children}</WalletSessionContext.Provider>;
}

/**
 * Privy login with an installed wallet: MetaMask, OKX Wallet (D-224), or any
 * other wallet that announces itself; no embedded wallets, and the one chain
 * this build targets.
 */
export function WalletProvider({ appId, environment, children }: WalletProviderProps) {
  const target = webAppChain(environment);
  // Privy's chain type is not viem's, so it gets the chain as a plain literal.
  const privyChain = {
    id: target.id,
    name: target.name,
    nativeCurrency: target.nativeCurrency,
    rpcUrls: { default: { http: [target.browserRpcUrl] } },
  };
  if (!appId)
    return <UnconfiguredSession environment={environment}>{children}</UnconfiguredSession>;
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["wallet"],
        appearance: {
          theme: "dark",
          walletList: ["metamask", "okx_wallet", "detected_ethereum_wallets"],
          showWalletLoginFirst: true,
        },
        embeddedWallets: { ethereum: { createOnLogin: "off" } },
        defaultChain: privyChain,
        supportedChains: [privyChain],
      }}
    >
      <PrivySessionBridge environment={environment}>{children}</PrivySessionBridge>
    </PrivyProvider>
  );
}
