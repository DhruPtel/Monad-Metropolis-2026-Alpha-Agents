"use client";

import { appChain, type EnvironmentId } from "@alpha-agents/config";
import { type PrivyErrorCode, PrivyProvider, useLogin, usePrivy } from "@privy-io/react-auth";
import { createConfig, WagmiProvider } from "@privy-io/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { http, useAccount, useWriteContract } from "wagmi";
import type { EIP1193Provider } from "viem";
import { deriveState, viemChain, type WalletSession, WalletSessionContext } from "./session";
import { useChainSwitch } from "./use-chain-switch";
import { useWalletChainId } from "./use-wallet-chain";

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
  const { address, chainId: wagmiChainId, connector } = useAccount();
  const { writeContractAsync } = useWriteContract();
  // The wallet's provider decides, not wagmi's cached connection (P1-U11).
  const walletRequest = useCallback(
    async (method: string, params: readonly unknown[]) => {
      if (!connector) throw new Error("The wallet is not connected.");
      const provider = (await connector.getProvider()) as EIP1193Provider;
      return provider.request({ method, params } as never);
    },
    [connector],
  );
  const chainId = useWalletChainId(connector, wagmiChainId);
  const chainSwitch = useChainSwitch(
    connector ? walletRequest : undefined,
    target,
    chainId === target.id,
  );

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
    switching: chainSwitch.busy,
    switchStatus: chainSwitch.status,
    ready: state === "connected",
    mock: false,
    configured: true,
    connect: () => {
      setError(undefined);
      setPending(true);
      login();
    },
    disconnect: () => {
      setError(undefined);
      void logout();
    },
    switchChain: chainSwitch.run,
    getAccessToken: () => (authenticated ? getAccessToken() : Promise.resolve(null)),
    writeContract: (request) =>
      // The ABI is the caller's own; wagmi's per-function typing does not survive
      // the generic request, so it is passed through as wagmi's parameters.
      writeContractAsync({
        ...request,
        chainId: target.id,
      } as unknown as Parameters<typeof writeContractAsync>[0]),
    walletRequest,
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
