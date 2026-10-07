"use client";

/**
 * TEST BUILDS ONLY. Two installed wallets, MetaMask and OKX, as EIP-1193
 * providers that announce themselves with EIP-6963, the way the real
 * extensions do; OKX also takes window.ethereum, as it does when both are
 * installed (L-53). Each keeps its own account, chain, site connection and a
 * log of the requests it received, so a test can prove which wallet the app
 * used. Like the extensions, they remember the site connection, account and
 * network across a reload. Imported only by the mock wallet provider, which
 * only test builds alias in.
 */
import { MOCK_WALLET_ADDRESS } from "./mock-wallet-constants";

export type MockWalletId = "metamask" | "okx";
/**
 * How the wallet answers network switches; "refuse-add" is OKX Wallet's answer
 * to adding a network with an http RPC from a site: an error, not a decline.
 */
export type SwitchBehavior =
  "approve" | "unknown-chain" | "reject" | "reject-add" | "refuse-add" | "already-pending" | "stay";

const INFO: Record<MockWalletId, { name: string; rdns: string; uuid: string }> = {
  metamask: { name: "MetaMask", rdns: "io.metamask", uuid: "mock-metamask" },
  okx: { name: "OKX Wallet", rdns: "com.okex.wallet", uuid: "mock-okx" },
};
/** A plain square icon as a data URL, as EIP-6963 requires one. */
const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8'/%3E%3C/svg%3E";
const PROMPT_DELAY_MS = 150;

const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });

interface Persisted {
  account: string;
  connected: boolean;
  chainId: number;
}

export class MockWallet {
  readonly id: MockWalletId;
  readonly info: { name: string; rdns: string; uuid: string; icon: string };
  /** Every method this wallet's provider was asked, in order. */
  readonly requests: string[] = [];
  behavior: SwitchBehavior = "approve";
  rejectNextSend = false;
  rpcUrl: string;
  private readonly listeners = new Map<string, Set<(v: unknown) => void>>();
  private readonly known: Set<number>;
  private s: Persisted;

  constructor(id: MockWalletId, targetChainId: number, rpcUrl: string) {
    this.id = id;
    this.info = { ...INFO[id], icon: ICON };
    this.rpcUrl = rpcUrl;
    this.known = new Set([targetChainId]);
    const saved = (() => {
      try {
        return JSON.parse(localStorage.getItem(this.key) ?? "null") as Persisted | null;
      } catch {
        return null;
      }
    })();
    this.s = saved ?? { account: MOCK_WALLET_ADDRESS, connected: false, chainId: targetChainId };
  }

  private get key() {
    return `alpha-mock-wallet-${this.id}`;
  }

  private save() {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.s));
    } catch {
      // storage blocked: the wallet still works for this page
    }
  }

  private emit(event: string, value: unknown) {
    for (const fn of this.listeners.get(event) ?? []) fn(value);
  }

  get account(): string {
    return this.s.account;
  }

  /** The user switches accounts in this wallet. */
  setAccount(address: string) {
    this.s = { ...this.s, account: address };
    this.save();
    if (this.s.connected) this.emit("accountsChanged", [address]);
  }

  /** The user switches networks in this wallet. */
  setChainId(chainId: number) {
    this.s = { ...this.s, chainId };
    this.save();
    this.emit("chainChanged", `0x${chainId.toString(16)}`);
  }

  /** The user locks the wallet, or disconnects the site in it: it shares no account. */
  lock() {
    this.s = { ...this.s, connected: false };
    this.save();
    this.emit("accountsChanged", []);
  }

  forgetChain(chainId: number) {
    this.known.delete(chainId);
  }

  readonly provider = {
    request: async ({ method, params = [] }: { method: string; params?: unknown }) => {
      this.requests.push(method);
      const args = (params ?? []) as unknown[];
      switch (method) {
        case "eth_requestAccounts":
          await new Promise((r) => setTimeout(r, PROMPT_DELAY_MS));
          this.s = { ...this.s, connected: true };
          this.save();
          this.emit("accountsChanged", [this.s.account]);
          return [this.s.account];
        case "eth_accounts":
          return this.s.connected ? [this.s.account] : [];
        case "eth_chainId":
          return `0x${this.s.chainId.toString(16)}`;
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain": {
          await new Promise((r) => setTimeout(r, PROMPT_DELAY_MS));
          const id = Number((args[0] as { chainId?: string } | undefined)?.chainId);
          const b = this.behavior;
          if (b === "already-pending") throw rpcError(-32002, "Request already pending.");
          if (method === "wallet_addEthereumChain") {
            if (b === "reject-add") throw rpcError(4001, "User rejected the request.");
            if (b === "refuse-add") throw rpcError(-32603, "Unsupported RPC URL: use https.");
            this.known.add(id);
            return null;
          }
          if (b === "reject") throw rpcError(4001, "User rejected the request.");
          if (!this.known.has(id)) throw rpcError(4902, `Unrecognized chain ID "${id}".`);
          if (b === "stay") return null;
          this.setChainId(id);
          return null;
        }
        case "eth_sendTransaction":
          if (!this.s.connected) throw rpcError(4100, "The wallet is not connected.");
          if (this.rejectNextSend) {
            this.rejectNextSend = false;
            throw rpcError(4001, "User rejected the request.");
          }
          return this.forward(method, [{ ...(args[0] as object), from: this.s.account }]);
        default:
          return this.forward(method, args);
      }
    },
    on: (event: string, fn: (v: unknown) => void) => {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)?.add(fn);
    },
    removeListener: (event: string, fn: (v: unknown) => void) => {
      this.listeners.get(event)?.delete(fn);
    },
  };

  /** Everything else goes to this wallet's network RPC (the fork's unless a test moves it). */
  private async forward(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? `${method} failed`);
    return body.result;
  }
}

declare global {
  interface Window {
    __mockWallets?: Record<MockWalletId, MockWallet>;
    ethereum?: unknown;
  }
}

/**
 * Installs both wallets once per page: announces each on EIP-6963 requests,
 * and lets OKX take window.ethereum, so a test proves the app never relies on it.
 */
export function installMockWallets(
  targetChainId: number,
  rpcUrl: string,
): Record<MockWalletId, MockWallet> {
  if (window.__mockWallets) return window.__mockWallets;
  const wallets = {
    metamask: new MockWallet("metamask", targetChainId, rpcUrl),
    okx: new MockWallet("okx", targetChainId, rpcUrl),
  };
  window.__mockWallets = wallets;
  window.ethereum = wallets.okx.provider;
  const announce = () => {
    for (const w of Object.values(wallets))
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: Object.freeze({ info: w.info, provider: w.provider }),
        }),
      );
  };
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  return wallets;
}

export const walletIdOf = (rdns: string): MockWalletId | undefined =>
  (Object.keys(INFO) as MockWalletId[]).find((id) => INFO[id].rdns === rdns);
