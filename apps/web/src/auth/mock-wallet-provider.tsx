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
import type { EnvironmentId } from "@alpha-agents/config";
import { webAppChain } from "./app-chain";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Address, createWalletClient, http } from "viem";
import { deriveState, viemChain, type WalletSession, WalletSessionContext } from "./session";
import { useChainSwitch } from "./use-chain-switch";

import {
  MOCK_ACCESS_TOKEN,
  MOCK_WALLET_ADDRESS,
  MOCK_WALLET_MARKER,
} from "./mock-wallet-constants";

export { MOCK_WALLET_ADDRESS, MOCK_WALLET_MARKER };
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
  /** Moves the connected wallet to another account, as MetaMask's account switch does. */
  setAccount(address: Address): void;
  /** Makes the next transaction fail as declined in the wallet (EIP-1193 4001). */
  rejectNextWrite(): void;
  /**
   * Points the wallet's network at another RPC, as a MetaMask network whose
   * RPC URL is not the app's does (L-53): reads and sends go there.
   */
  setRpcUrl(url: string): void;
  /**
   * How the wallet answers the next network switches, as MetaMask can:
   * approve; not know the chain (4902) and then approve adding it; decline
   * the switch or the add (4001); have a request open already (-32002); or
   * accept the request and stay on its network. Defaults to approve.
   */
  setSwitchBehavior(behavior: SwitchBehavior): void;
}

export type SwitchBehavior =
  "approve" | "unknown-chain" | "reject" | "reject-add" | "already-pending" | "stay";

/** How long the mock wallet takes to answer, as a wallet prompt does. */
const PROMPT_DELAY_MS = 150;

/** What MetaMask throws when the user declines a request. */
function userRejected(): Error {
  return Object.assign(new Error("User rejected the request."), { code: 4001 });
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
  const target = webAppChain(environment);
  const [mock, setMock] = useState<MockState>({ status: "logged-out" });
  const [failNext, setFailNext] = useState(false);
  const [account, setAccount] = useState<Address>(MOCK_WALLET_ADDRESS);
  const [rejectNext, setRejectNext] = useState(false);
  const [rpcUrl, setRpcUrl] = useState(target.browserRpcUrl);
  const behavior = useRef<SwitchBehavior>("approve");
  const knownChains = useRef(new Set<number>([target.id]));
  const chainRef = useRef<number | undefined>(undefined);
  chainRef.current = mock.chainId;

  useEffect(() => {
    window.__mockWallet = {
      marker: MOCK_WALLET_MARKER,
      setChainId: (chainId) => setMock((m) => (m.status === "connected" ? { ...m, chainId } : m)),
      failNextLogin: () => setFailNext(true),
      setAccount: (address) => setAccount(address),
      rejectNextWrite: () => setRejectNext(true),
      setRpcUrl: (url) => setRpcUrl(url),
      setSwitchBehavior: (b) => {
        behavior.current = b;
        if (b === "unknown-chain" || b === "reject-add") knownChains.current.delete(target.id);
      },
    };
    return () => {
      delete window.__mockWallet;
    };
  }, [target.id]);

  const state = deriveState({
    initializing: false,
    error: mock.error,
    pending: mock.status === "connecting",
    authenticated: mock.status === "connected",
    address: mock.status === "connected" ? account : undefined,
    chainId: mock.chainId,
    targetChainId: target.id,
  });
  const connected = mock.status === "connected";
  const fail = (code: number, message: string) =>
    Promise.reject(Object.assign(new Error(message), { code }));
  // The wallet's own provider: network switching as MetaMask answers it, and
  // everything else through the wallet's RPC.
  const walletRequest = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    if (!connected) throw new Error("The wallet is not connected.");
    if (method === "eth_chainId") return `0x${(chainRef.current ?? target.id).toString(16)}`;
    if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") {
      await new Promise((r) => setTimeout(r, PROMPT_DELAY_MS));
      const id = Number((params[0] as { chainId?: string } | undefined)?.chainId);
      const b = behavior.current;
      if (b === "already-pending") return fail(-32002, "Request already pending.");
      if (method === "wallet_addEthereumChain") {
        if (b === "reject-add") return fail(4001, "User rejected the request.");
        knownChains.current.add(id);
        return null;
      }
      if (b === "reject") return fail(4001, "User rejected the request.");
      if (!knownChains.current.has(id)) return fail(4902, `Unrecognized chain ID "${id}".`);
      if (b === "stay") return null;
      chainRef.current = id;
      setMock((m) => (m.status === "connected" ? { ...m, chainId: id } : m));
      return null;
    }
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? `${method} failed`);
    return body.result;
  };
  const chainSwitch = useChainSwitch(
    connected ? walletRequest : undefined,
    target,
    mock.chainId === target.id,
  );

  const session: WalletSession = {
    state,
    ...(mock.status === "connected" ? { address: account } : {}),
    ...(mock.chainId !== undefined ? { chainId: mock.chainId } : {}),
    target,
    ...(mock.error ? { errorMessage: mock.error } : {}),
    switching: chainSwitch.busy,
    switchStatus: chainSwitch.status,
    ready: state === "connected",
    mock: true,
    configured: true,
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
    switchChain: chainSwitch.run,
    getAccessToken: () => Promise.resolve(mock.status === "connected" ? MOCK_ACCESS_TOKEN : null),
    // Sends from the mock address through the wallet's RPC, the fork's unless a
    // test points it elsewhere (eth_sendTransaction); the end-to-end test makes
    // anvil impersonate and fund that address first.
    writeContract: (request) => {
      if (mock.status !== "connected") {
        return Promise.reject(new Error("The wallet is not connected."));
      }
      if (rejectNext) {
        setRejectNext(false);
        return Promise.reject(userRejected());
      }
      const client = createWalletClient({
        chain: viemChain(target),
        transport: http(rpcUrl),
        account,
      });
      return client.writeContract(request as unknown as Parameters<typeof client.writeContract>[0]);
    },
    walletRequest,
  };
  return <WalletSessionContext.Provider value={session}>{children}</WalletSessionContext.Provider>;
}
