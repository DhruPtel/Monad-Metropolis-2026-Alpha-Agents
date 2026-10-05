import { type AppChain, MONAD_MAINNET_CHAIN_ID } from "@alpha-agents/config";
import type { Address } from "viem";
import { chainName } from "@/auth/session";

/**
 * Is the wallet on the network the app reads? (P1-U11, L-53)
 *
 * A wallet chooses its own RPC for a chain ID, so the chain ID alone does not
 * prove the wallet and the app see the same chain: with the local fork and
 * Monad mainnet both on 143, MetaMask sent a local mint to mainnet. Before an
 * action, this asks the wallet's own provider for its latest block and for
 * AgentNFT's code, and requires the app's RPC to have that same block (same
 * hash) and the same code. The wallet's latest block is used, not an old one:
 * the fork copies mainnet's history, so blocks at or below the pin match.
 */
export type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;

export interface NetworkCheckInput {
  /** Requests answered by the wallet's own provider (its RPC for this network). */
  readonly wallet: Rpc;
  /** Requests answered by the RPC the app reads. */
  readonly app: Rpc;
  readonly target: AppChain;
  /** The chain ID the wallet reports. */
  readonly walletChainId: number | undefined;
  /** A contract the app relies on, deployed on the target network. */
  readonly contract: Address;
  /** Waits between tries while the app's RPC catches up with the wallet's. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export type NetworkCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "wallet-unreachable" | "different-blocks" | "different-code";
      readonly message: string;
    };

/** Tries, one second apart, for the app's RPC to reach the wallet's block. */
const CATCH_UP_TRIES = 3;

interface RawBlock {
  readonly number?: string;
  readonly hash?: string;
}

/** The wallet's network, named for the user. */
export function walletNetworkName(walletChainId: number | undefined, target: AppChain): string {
  if (walletChainId === undefined) return "an unknown network";
  if (walletChainId === MONAD_MAINNET_CHAIN_ID) return "Monad mainnet";
  if (walletChainId === target.id) return `a network that reports chain ${walletChainId}`;
  return chainName(walletChainId, target) ?? `chain ${walletChainId}`;
}

/** What the user should change in the wallet, for the target network. */
function fixFor(target: AppChain): string {
  return target.environment === "local"
    ? `Switch the wallet to ${target.name}: chain ID ${target.id}, RPC URL ${target.browserRpcUrl}.`
    : `Switch the wallet to ${target.name} (chain ID ${target.id}) using its official RPC.`;
}

export async function checkWalletNetwork(input: NetworkCheckInput): Promise<NetworkCheck> {
  const { wallet, app, target, walletChainId, contract } = input;
  const sleep = input.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const mismatch = (reason: "different-blocks" | "different-code"): NetworkCheck => ({
    ok: false,
    reason,
    message: `Your wallet is on ${walletNetworkName(walletChainId, target)}, not ${target.name}, which this app reads. Nothing was sent. ${fixFor(target)}`,
  });

  let latest: RawBlock | null;
  try {
    latest = (await wallet("eth_getBlockByNumber", ["latest", false])) as RawBlock | null;
  } catch {
    return {
      ok: false,
      reason: "wallet-unreachable",
      message: "Your wallet did not answer a network check. Unlock it and try again.",
    };
  }
  if (!latest?.number || !latest.hash) return mismatch("different-blocks");

  let ours: RawBlock | null = null;
  for (let tries = 0; tries < CATCH_UP_TRIES; tries++) {
    ours = (await app("eth_getBlockByNumber", [latest.number, false]).catch(
      () => null,
    )) as RawBlock | null;
    if (ours) break;
    if (tries < CATCH_UP_TRIES - 1) await sleep(1_000);
  }
  if (!ours?.hash || ours.hash.toLowerCase() !== latest.hash.toLowerCase()) {
    return mismatch("different-blocks");
  }

  const [walletCode, appCode] = await Promise.all([
    wallet("eth_getCode", [contract, "latest"]).catch(() => null),
    app("eth_getCode", [contract, "latest"]).catch(() => null),
  ]);
  if (
    typeof walletCode !== "string" ||
    walletCode.toLowerCase() !== String(appCode).toLowerCase()
  ) {
    return mismatch("different-code");
  }
  return { ok: true };
}
