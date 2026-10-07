"use client";

/**
 * TEST BUILDS ONLY. A stand-in for Privy, with two installed mock wallets
 * (MetaMask and OKX, mock-wallets.ts), so the end-to-end and screenshot tests
 * can walk every login state without a real wallet or a Privy app.
 *
 * It is compiled in only when next.config.ts resolves "#wallet-provider" here,
 * which wallet-mode.ts allows only for ALPHA_E2E_MOCK_WALLET=1 on the local
 * environment, into the separate .next-e2e output. `scripts/check-web-build.js`
 * fails if MOCK_WALLET_MARKER appears in a real build. The shell labels the page
 * "Test build: mock wallet" whenever this provider is active.
 *
 * It behaves as Privy does where the app's correctness depends on it: the
 * login names the wallet and address it was made with and outlives a reload;
 * the access token links that one wallet only; an account switch in the
 * wallet does not move the login. The session rules themselves are the shared
 * core's (wallet-core.ts), the same as with Privy.
 */
import type { EnvironmentId } from "@alpha-agents/config";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type Address, getAddress } from "viem";
import { webAppChain } from "./app-chain";
import { discoverWallets, type Eip6963Wallet } from "./eip6963";
import {
  MOCK_WALLET_ADDRESS,
  MOCK_WALLET_MARKER,
  mockAccessTokenFor,
} from "./mock-wallet-constants";
import {
  installMockWallets,
  type MockWallet,
  type MockWalletId,
  type SwitchBehavior,
  walletIdOf,
} from "./mock-wallets";
import { WalletSessionContext } from "./session";
import { useWalletCore, type WalletAuth } from "./wallet-core";

export { MOCK_WALLET_ADDRESS, MOCK_WALLET_MARKER };
export type { MockWalletId, SwitchBehavior };

/** The handle the tests use to act as the user in the active wallet. */
export interface MockWalletHandle {
  readonly marker: typeof MOCK_WALLET_MARKER;
  /** Moves the wallet to another chain, as a network switch in the wallet does. */
  setChainId(chainId: number): void;
  /** Makes the next connect fail, as a rejected login does. */
  failNextLogin(): void;
  /** Moves the wallet to another account, as an account switch in the wallet does. */
  setAccount(address: Address): void;
  /** Makes the next transaction fail as declined in the wallet (EIP-1193 4001). */
  rejectNextWrite(): void;
  /**
   * Points the wallet's network at another RPC, as a wallet network whose
   * RPC URL is not the app's does (L-53): reads and sends go there.
   */
  setRpcUrl(url: string): void;
  /**
   * How the wallet answers the next network switches: approve; not know the
   * chain (4902) and then approve adding it; decline the switch or the add
   * (4001); have a request open already (-32002); or accept the request and
   * stay on its network. Defaults to approve.
   */
  setSwitchBehavior(behavior: SwitchBehavior): void;
  /** Which wallet the next login picks in the login window (MetaMask by default). */
  chooseOnConnect(id: MockWalletId): void;
  /** Makes the next login stall without an answer, as a locked wallet's does. */
  stallNextLogin(): void;
}

declare global {
  interface Window {
    /** Acts on the wallet the session uses, or the one the next login picks. */
    __mockWallet?: MockWalletHandle;
  }
}

interface MockLogin {
  readonly wallet: MockWalletId;
  readonly address: Address;
}

const LOGIN_KEY = "alpha-mock-login";

function savedLogin(): MockLogin | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LOGIN_KEY) ?? "null") as MockLogin | null;
    return raw?.wallet && raw.address
      ? { wallet: raw.wallet, address: getAddress(raw.address) }
      : null;
  } catch {
    return null;
  }
}

function saveLogin(login: MockLogin | null) {
  try {
    if (login) localStorage.setItem(LOGIN_KEY, JSON.stringify(login));
    else localStorage.removeItem(LOGIN_KEY);
  } catch {
    // storage blocked: the login lasts for this page only
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
  const [wallets, setWallets] = useState<Record<MockWalletId, MockWallet> | null>(null);
  const [found, setFound] = useState<readonly Eip6963Wallet[]>([]);
  // undefined until read after mount, so the server render and the first client render agree.
  const [login, setLogin] = useState<MockLogin | null | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const choice = useRef<MockWalletId>("metamask");
  const failNext = useRef(false);
  const stallNext = useRef(false);
  const attempt = useRef(0);

  useEffect(() => {
    setWallets(installMockWallets(target.id, target.browserRpcUrl));
    setLogin(savedLogin());
    return discoverWallets(setFound);
  }, [target.id, target.browserRpcUrl]);

  // The wallet a test acts on: the session's, else the one the next login picks.
  const loginRef = useRef(login);
  loginRef.current = login;
  useEffect(() => {
    if (!wallets) return;
    const active = () => wallets[loginRef.current?.wallet ?? choice.current];
    window.__mockWallet = {
      marker: MOCK_WALLET_MARKER,
      setChainId: (id) => active().setChainId(id),
      failNextLogin: () => {
        failNext.current = true;
      },
      setAccount: (address) => active().setAccount(address),
      rejectNextWrite: () => {
        active().rejectNextSend = true;
      },
      setRpcUrl: (url) => {
        active().rpcUrl = url;
      },
      setSwitchBehavior: (b) => {
        const w = active();
        w.behavior = b;
        if (b === "unknown-chain" || b === "reject-add" || b === "refuse-add")
          w.forgetChain(target.id);
      },
      chooseOnConnect: (id) => {
        choice.current = id;
      },
      stallNextLogin: () => {
        stallNext.current = true;
      },
    };
    return () => {
      delete window.__mockWallet;
    };
  }, [wallets, target.id]);

  // The login's wallet, by its EIP-6963 announcement, never by window.ethereum.
  const chosen = useMemo(() => {
    const entry = login ? found.find((w) => walletIdOf(w.info.rdns) === login.wallet) : undefined;
    return entry ? { name: entry.info.name, provider: entry.provider } : null;
  }, [login, found]);

  const auth: WalletAuth = useMemo(
    () => ({
      ready: login !== undefined && wallets !== null,
      authenticated: !!login,
      loginAddress: login?.address ?? null,
      wallet: chosen,
      pending,
      error,
      login: () => {
        if (!wallets) return;
        const id = choice.current;
        const fail = failNext.current;
        const stall = stallNext.current;
        failNext.current = false;
        stallNext.current = false;
        const mine = (attempt.current += 1);
        setError(undefined);
        setPending(true);
        if (stall) return; // the login window stays open until the user cancels
        void (async () => {
          try {
            if (fail) throw new Error("rejected");
            const [account] = (await wallets[id].provider.request({
              method: "eth_requestAccounts",
            })) as string[];
            if (attempt.current !== mine) return;
            if (!account) throw new Error("no account");
            const next = { wallet: id, address: getAddress(account) };
            saveLogin(next);
            setLogin(next);
          } catch {
            if (attempt.current === mine) setError("The wallet did not complete the login.");
          } finally {
            if (attempt.current === mine) setPending(false);
          }
        })();
      },
      logout: async () => {
        attempt.current += 1;
        saveLogin(null);
        setLogin(null);
        setPending(false);
        setError(undefined);
      },
      getAccessToken: () => Promise.resolve(login ? mockAccessTokenFor(login.address) : null),
    }),
    [login, wallets, chosen, pending, error],
  );

  const session = useWalletCore(auth, target, true);
  return <WalletSessionContext.Provider value={session}>{children}</WalletSessionContext.Provider>;
}
