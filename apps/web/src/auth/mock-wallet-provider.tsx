"use client";

/**
 * TEST BUILDS ONLY. A stand-in for Privy and MetaMask so the end-to-end and
 * screenshot tests can walk every login state without a wallet or a Privy app.
 *
 * It is compiled in only when next.config.ts resolves "#wallet-provider" here,
 * which wallet-mode.ts allows only for ALPHA_E2E_MOCK_WALLET=1 on the local
 * environment, into the separate .next-e2e output. `scripts/check-web-build.js`
 * fails if MOCK_WALLET_MARKER appears in a real build. The shell labels the page
 * "Test build: mock wallet" whenever this provider is active.
 */
import { appChain, type EnvironmentId } from "@alpha-agents/config";
import { type ReactNode, useEffect, useState } from "react";
import { deriveState, type WalletSession, WalletSessionContext } from "./session";

export const MOCK_WALLET_MARKER = "alpha-agents-mock-wallet-e2e-only";
export const MOCK_WALLET_ADDRESS = "0x00000000000000000000000000000000000e2e01";
const CONNECT_DELAY_MS = 150;

interface MockState {
  readonly status: "logged-out" | "connecting" | "connected";
  readonly chainId?: number;
  readonly error?: string;
}

/** The handle the tests use to change what the mock wallet reports. */
export interface MockWalletHandle {
  readonly marker: typeof MOCK_WALLET_MARKER;
  /** Moves the connected wallet to another chain, as MetaMask's network switch does. */
  setChainId(chainId: number): void;
  /** Makes the next connect fail, as a rejected login does. */
  failNextLogin(): void;
}

declare global {
  interface Window {
    __mockWallet?: MockWalletHandle;
  }
}

export function WalletProvider({
  environment,
  children,
}: {
  readonly appId: string | undefined;
  readonly environment: EnvironmentId;
  readonly children: ReactNode;
}) {
  const target = appChain(environment);
  const [mock, setMock] = useState<MockState>({ status: "logged-out" });
  const [failNext, setFailNext] = useState(false);

  useEffect(() => {
    window.__mockWallet = {
      marker: MOCK_WALLET_MARKER,
      setChainId: (chainId) => setMock((m) => (m.status === "connected" ? { ...m, chainId } : m)),
      failNextLogin: () => setFailNext(true),
    };
    return () => {
      delete window.__mockWallet;
    };
  }, []);

  const state = deriveState({
    initializing: false,
    error: mock.error,
    pending: mock.status === "connecting",
    authenticated: mock.status === "connected",
    address: mock.status === "connected" ? MOCK_WALLET_ADDRESS : undefined,
    chainId: mock.chainId,
    targetChainId: target.id,
  });
  const session: WalletSession = {
    state,
    ...(mock.status === "connected" ? { address: MOCK_WALLET_ADDRESS } : {}),
    ...(mock.chainId !== undefined ? { chainId: mock.chainId } : {}),
    target,
    ...(mock.error ? { errorMessage: mock.error } : {}),
    switching: false,
    ready: state === "connected",
    mock: true,
    connect: () => {
      setMock({ status: "connecting" });
      const fail = failNext;
      setFailNext(false);
      setTimeout(() => {
        setMock(
          fail
            ? { status: "logged-out", error: "The wallet did not complete the login." }
            : { status: "connected", chainId: target.id },
        );
      }, CONNECT_DELAY_MS);
    },
    disconnect: () => setMock({ status: "logged-out" }),
    switchChain: () =>
      setMock((m) => (m.status === "connected" ? { ...m, chainId: target.id } : m)),
    getAccessToken: () =>
      Promise.resolve(mock.status === "connected" ? `mock-token-${MOCK_WALLET_MARKER}` : null),
  };
  return <WalletSessionContext.Provider value={session}>{children}</WalletSessionContext.Provider>;
}
