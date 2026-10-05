"use client";

import { type AppChain, APP_CHAINS } from "@alpha-agents/config";
import type { WalletState } from "@alpha-agents/ui";
import { createContext, useContext } from "react";
import { type Abi, type Address, defineChain, type Chain, type Hex } from "viem";

/** A contract call for the wallet to sign and send (P1-U11: the mint). */
export interface ContractWrite {
  readonly address: Address;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args: readonly unknown[];
}

/**
 * The signed-in wallet as the rest of the app sees it (P1-U2). Two providers
 * fill it: the real one (Privy and wagmi, `privy-wallet-provider.tsx`) and, in
 * test builds only, the mock (`mock-wallet-provider.tsx`).
 */
export interface WalletSession {
  readonly state: WalletState;
  readonly address?: `0x${string}`;
  /** The chain the wallet is on, if connected. */
  readonly chainId?: number;
  /** The chain this build targets (from APP_ENV). */
  readonly target: AppChain;
  readonly errorMessage?: string;
  /** True while the wallet is asking the user to approve a network switch. */
  readonly switching: boolean;
  /**
   * True only when connected on the target chain. Every later read or signature
   * that depends on the wallet checks this: on the wrong chain nothing proceeds.
   */
  readonly ready: boolean;
  /** True in a test build with the mock wallet; the shell labels it on screen. */
  readonly mock: boolean;
  /**
   * False when login cannot work at all (PRIVY_APP_ID unset or malformed): the
   * shell then says "Login unavailable" and offers no retry that would do nothing.
   */
  readonly configured: boolean;
  connect(): void;
  disconnect(): void;
  switchChain(): void;
  /** A Privy access token for the server session check, or null when logged out. */
  getAccessToken(): Promise<string | null>;
  /**
   * Asks the wallet to sign and send a contract call on the target chain and
   * resolves to the transaction hash. Rejects if the user declines; see
   * `isUserRejection`.
   */
  writeContract(request: ContractWrite): Promise<Hex>;
  /**
   * Sends a read-only JSON-RPC request through the wallet's own provider, so
   * it is answered by whatever RPC the wallet uses for its current network,
   * which can differ from the app's (L-53). Rejects when no wallet is connected.
   */
  walletRequest(method: string, params: readonly unknown[]): Promise<unknown>;
}

/** True when an error means the user declined in their wallet (EIP-1193 code 4001). */
export function isUserRejection(error: unknown): boolean {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const { code, name } = e as { code?: unknown; name?: unknown };
    if (code === 4001 || name === "UserRejectedRequestError") return true;
  }
  return false;
}

export const WalletSessionContext = createContext<WalletSession | null>(null);

export function useWalletSession(): WalletSession {
  const session = useContext(WalletSessionContext);
  if (!session) throw new Error("useWalletSession needs a WalletProvider above it");
  return session;
}

/** The target chain as a viem chain, for wagmi. */
export function viemChain(chain: AppChain): Chain {
  return defineChain({
    id: chain.id,
    name: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: { default: { http: [chain.browserRpcUrl] } },
    testnet: chain.testnet,
  });
}

const KNOWN_CHAINS: Readonly<Record<number, string>> = {
  1: "Ethereum",
  [APP_CHAINS.beta.id]: APP_CHAINS.beta.name,
  [APP_CHAINS.testnet.id]: APP_CHAINS.testnet.name,
};

/** A readable name for the chain a wallet is on. */
export function chainName(chainId: number | undefined, target: AppChain): string | undefined {
  if (chainId === undefined) return undefined;
  if (chainId === target.id) return target.name;
  return KNOWN_CHAINS[chainId] ?? `chain ${chainId}`;
}

/** The session's state from what the wallet reports, shared by both providers. */
export function deriveState(input: {
  readonly initializing: boolean;
  readonly error?: string | undefined;
  readonly pending: boolean;
  readonly authenticated: boolean;
  readonly address?: string | undefined;
  readonly chainId?: number | undefined;
  readonly targetChainId: number;
}): WalletState {
  if (input.error) return "error";
  if (input.initializing || input.pending) return "connecting";
  if (!input.authenticated) return "logged-out";
  if (!input.address || input.chainId === undefined) return "connecting";
  return input.chainId === input.targetChainId ? "connected" : "wrong-chain";
}
