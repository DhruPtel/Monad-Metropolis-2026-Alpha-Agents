import { APP_CHAINS } from "@alpha-agents/config";
import { describe, expect, it } from "vitest";
import {
  type SwitchPhase,
  type WalletRequest,
  addChainParams,
  switchWalletChain,
} from "./switch-chain";

const target = APP_CHAINS.local;
const err = (code: number, message = `error ${code}`) =>
  Object.assign(new Error(message), { code });

/**
 * A wallet that behaves like MetaMask: it switches only to chains it knows,
 * answers 4902 for others, and adds a chain when asked. `on` overrides a
 * method to throw or to misbehave.
 */
function wallet(options: {
  chain?: number;
  known?: number[];
  on?: Partial<Record<string, () => unknown>>;
}) {
  let chain = options.chain ?? 10143;
  const known = new Set(options.known ?? [143, 10143]);
  const calls: string[] = [];
  const request: WalletRequest = async (method, params) => {
    calls.push(method);
    const override = options.on?.[method];
    if (override) return override();
    const id = Number((params[0] as { chainId?: string } | undefined)?.chainId);
    if (method === "wallet_switchEthereumChain") {
      if (!known.has(id)) throw err(4902, "Unrecognized chain ID");
      chain = id;
      return null;
    }
    if (method === "wallet_addEthereumChain") {
      known.add(id);
      return null;
    }
    if (method === "eth_chainId") return `0x${chain.toString(16)}`;
    throw new Error(`unexpected ${method}`);
  };
  return { request, calls };
}

async function run(w: ReturnType<typeof wallet>) {
  const phases: SwitchPhase[] = [];
  const result = await switchWalletChain({
    request: w.request,
    target,
    onPhase: (p) => phases.push(p),
  });
  return { result, phases };
}

describe("switchWalletChain", () => {
  it("switches a wallet that knows the chain and confirms it", async () => {
    const w = wallet({ known: [143, 10143, 143143] });
    const { result, phases } = await run(w);
    expect(result).toEqual({ outcome: "switched" });
    expect(phases).toEqual(["pending"]);
    expect(w.calls).toEqual(["wallet_switchEthereumChain", "eth_chainId"]);
  });

  it("adds an unrecognized chain (4902), then switches", async () => {
    const w = wallet({});
    const { result, phases } = await run(w);
    expect(result).toEqual({ outcome: "switched" });
    expect(phases).toEqual(["pending", "adding", "pending"]);
    expect(w.calls).toEqual([
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
      "eth_chainId",
    ]);
  });

  it("recognizes 4902 wrapped as -32603 by MetaMask mobile", async () => {
    let first = true;
    const w = wallet({
      on: {
        wallet_switchEthereumChain: () => {
          if (!first) return null;
          first = false;
          throw Object.assign(new Error("Internal error"), {
            code: -32603,
            data: { originalError: { code: 4902 } },
          });
        },
        eth_chainId: () => "0x22f27",
      },
    });
    expect((await run(w)).result).toEqual({ outcome: "switched" });
    expect(w.calls).toContain("wallet_addEthereumChain");
  });

  it("says the user declined the switch (4001)", async () => {
    const w = wallet({ on: { wallet_switchEthereumChain: () => Promise.reject(err(4001)) } });
    expect((await run(w)).result).toEqual({
      outcome: "rejected",
      message: "You declined the network switch in your wallet.",
    });
  });

  it("says the user declined adding the chain", async () => {
    const w = wallet({ on: { wallet_addEthereumChain: () => Promise.reject(err(4001)) } });
    expect((await run(w)).result).toEqual({
      outcome: "rejected",
      message: "You declined adding Monad (local fork) in your wallet.",
    });
  });

  it("says a request is already open in the wallet (-32002)", async () => {
    const w = wallet({ on: { wallet_switchEthereumChain: () => Promise.reject(err(-32002)) } });
    const { result } = await run(w);
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") expect(result.message).toMatch(/already has a request open/);
  });

  it("reports the wallet's error when adding fails", async () => {
    const w = wallet({
      on: {
        wallet_addEthereumChain: () =>
          Promise.reject(err(-32602, "Expected an array with at least one valid string HTTPS url")),
      },
    });
    const { result } = await run(w);
    expect(result).toEqual({
      outcome: "failed",
      message:
        "Your wallet could not add Monad (local fork): Expected an array with at least one valid string HTTPS url",
    });
  });

  it("reports any other switch error", async () => {
    const w = wallet({
      on: { wallet_switchEthereumChain: () => Promise.reject(err(-32603, "boom")) },
    });
    expect((await run(w)).result).toEqual({
      outcome: "failed",
      message: "Your wallet could not switch: boom",
    });
  });

  it("catches a wallet that accepts the request but stays on its network", async () => {
    // The playtest: the request resolved, and the wallet still said Monad Testnet.
    const w = wallet({ on: { wallet_switchEthereumChain: () => null } });
    const { result } = await run(w);
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.message).toContain("Your wallet still reports Monad Testnet");
      expect(result.message).toContain("open MetaMask on this page and choose Monad (local fork)");
    }
  });

  it("adds the chain with the fork's RPC, chain ID and currency, and no empty explorer URL", () => {
    expect(addChainParams(target)).toEqual({
      chainId: "0x22f27",
      chainName: "Monad (local fork)",
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: ["http://127.0.0.1:8545"],
    });
  });
});
