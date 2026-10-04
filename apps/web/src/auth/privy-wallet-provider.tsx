"use client";

import { appChain, type EnvironmentId } from "@alpha-agents/config";
import { type PrivyErrorCode, PrivyProvider, useLogin, usePrivy } from "@privy-io/react-auth";
import { createConfig, WagmiProvider } from "@privy-io/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { http, useAccount, useSwitchChain } from "wagmi";
import { deriveState, viemChain, type WalletSession, WalletSessionContext } from "./session";

interface WalletProviderProps {
  /** The public Privy app ID, or undefined when login is not configured. */
  readonly appId: string | undefined;
  readonly environment: EnvironmentId;
  readonly children: ReactNode;
}

/** Owner-facing text for a failed login. Closing the modal is not a failure. */
function loginErrorMessage(code: PrivyErrorCode): string | undefined {
  if (code === "exited_auth_flow") return undefined;
  return "The wallet did not complete the login. Try again, or check MetaMask.";
}

/** Reads Privy and wagmi into one WalletSession for the app. */
function PrivySessionBridge({
  environment,
  children,
}: {
  environment: EnvironmentId;
  children: ReactNode;
}) {
  const target = appChain(environment);
  const { ready, authenticated, logout, getAccessToken } = usePrivy();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
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
  const { address, chainId } = useAccount();
  const { switchChain, isPending: switching } = useSwitchChain();

  const state = deriveState({
    initializing: !ready,
    error,
    pending,
    authenticated,
    address,
    chainId,
    targetChainId: target.id,
  });
  const session: WalletSession = {
    state,
    ...(address ? { address } : {}),
    ...(chainId !== undefined ? { chainId } : {}),
    target,
    ...(error ? { errorMessage: error } : {}),
    switching,
    ready: state === "connected",
    mock: false,
    connect: () => {
      setError(undefined);
      setPending(true);
      login();
    },
    disconnect: () => {
      setError(undefined);
      void logout();
    },
    switchChain: () => switchChain({ chainId: target.id }),
    getAccessToken: () => (authenticated ? getAccessToken() : Promise.resolve(null)),
  };
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
    target: appChain(environment),
    errorMessage: "Wallet login is not configured: set PRIVY_APP_ID for this app.",
    switching: false,
    ready: false,
    mock: false,
    connect: () => undefined,
    disconnect: () => undefined,
    switchChain: () => undefined,
    getAccessToken: () => Promise.resolve(null),
  };
  return <WalletSessionContext.Provider value={session}>{children}</WalletSessionContext.Provider>;
}

/**
 * Privy login with MetaMask as the only wallet (OKX is deferred to W-6), no
 * embedded wallets, and the one chain this build targets.
 */
export function WalletProvider({ appId, environment, children }: WalletProviderProps) {
  const target = appChain(environment);
  const chain = useMemo(() => viemChain(appChain(environment)), [environment]);
  // Privy's chain type is not viem's, so it gets the same chain as a plain literal.
  const privyChain = {
    id: target.id,
    name: target.name,
    nativeCurrency: target.nativeCurrency,
    rpcUrls: { default: { http: [target.browserRpcUrl] } },
  };
  const [queryClient] = useState(() => new QueryClient());
  const wagmiConfig = useMemo(
    () =>
      createConfig({
        chains: [chain],
        transports: { [chain.id]: http(chain.rpcUrls.default.http[0]) },
      }),
    [chain],
  );
  if (!appId)
    return <UnconfiguredSession environment={environment}>{children}</UnconfiguredSession>;
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["wallet"],
        appearance: { theme: "dark", walletList: ["metamask"], showWalletLoginFirst: true },
        embeddedWallets: { ethereum: { createOnLogin: "off" } },
        defaultChain: privyChain,
        supportedChains: [privyChain],
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>
          <PrivySessionBridge environment={environment}>{children}</PrivySessionBridge>
        </WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
