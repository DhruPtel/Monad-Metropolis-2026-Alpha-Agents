import { type AppChain, MONAD_MAINNET_CHAIN_ID } from "@alpha-agents/config";
import type { Address } from "viem";
import { chainName } from "@/auth/session";

/**
 * Is the wallet on the network the app reads? (P1-U11, L-53, L-57)
 *
 * A wallet chooses its own RPC for a chain, so the app checks through the
 * wallet's own provider, in this order:
 * 1. its chain ID equals the app's: catches Monad mainnet (143) for the fork;
 * 2. one fixed block, the pinned block, has the same hash through the wallet
 *    and through the app: catches a node that answers the right chain ID but
 *    is another chain or a fork of another block. A fixed block, because a
 *    wallet caches and polls "latest" on its own schedule (L-57); the pinned
 *    block alone cannot tell the fork from mainnet, whose history it copies,
 *    which is what checks 1 and 3 are for;
 * 3. AgentNFT has code through the wallet: catches a node forked at the same
 *    block without our deployment, and mainnet, where it does not exist.
 * A wallet that cannot answer is reported as such, never as another network.
 */
export type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;

export interface NetworkCheckInput {
  /** Requests answered by the connected wallet's own provider. */
  readonly wallet: Rpc;
  /** Requests answered by the RPC the app reads. */
  readonly app: Rpc;
  readonly target: AppChain;
  /** A block both sides must agree on: the fork's pinned block. */
  readonly referenceBlock: bigint;
  /** A contract the app relies on, deployed on the target network. */
  readonly contract: Address;
}

export type NetworkCheckFailure =
  | "wallet-unreachable"
  | "wrong-chain-id"
  | "different-block"
  | "no-contract-in-wallet"
  | "no-contract-in-app";

export type NetworkCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: NetworkCheckFailure; readonly message: string };

/** The wallet's network, named for the user, by its chain ID. */
export function walletNetworkName(walletChainId: number, target: AppChain): string {
  if (walletChainId === MONAD_MAINNET_CHAIN_ID) return "Monad mainnet (chain ID 143)";
  const name = chainName(walletChainId, target);
  // chainName falls back to "chain N"; with the ID appended that would repeat it.
  const known = name && name !== `chain ${walletChainId}` ? name : "another network";
  return `${known} (chain ID ${walletChainId})`;
}

/** What the user should set in the wallet, for the target network. */
function fixFor(target: AppChain): string {
  return target.environment === "local"
    ? `In your wallet, use ${target.name}: chain ID ${target.id}, RPC URL ${target.browserRpcUrl}.`
    : `In your wallet, use ${target.name} (chain ID ${target.id}) with its official RPC.`;
}

const short = (hash: string) => `${hash.slice(0, 10)}…`;

export async function checkWalletNetwork(input: NetworkCheckInput): Promise<NetworkCheck> {
  const { wallet, app, target, referenceBlock, contract } = input;
  const fail = (reason: NetworkCheckFailure, message: string): NetworkCheck => ({
    ok: false,
    reason,
    message,
  });
  const silent = (method: string) =>
    fail(
      "wallet-unreachable",
      `Your wallet did not answer ${method}, so the app cannot confirm which network it is on. Nothing was sent. Unlock your wallet and try again.`,
    );

  // 1. Chain ID, from the wallet's own provider.
  let walletChainId: number;
  try {
    walletChainId = Number(await wallet("eth_chainId", []));
  } catch {
    return silent("a request for its chain ID");
  }
  if (walletChainId !== target.id) {
    return fail(
      "wrong-chain-id",
      `Your wallet is on ${walletNetworkName(walletChainId, target)}, but this app uses ${target.name} (chain ID ${target.id}). Nothing was sent. ${fixFor(target)}`,
    );
  }

  // 2. One fixed block, through both.
  const blockTag = `0x${referenceBlock.toString(16)}`;
  let walletBlock: { hash?: string } | null;
  try {
    walletBlock = (await wallet("eth_getBlockByNumber", [blockTag, false])) as {
      hash?: string;
    } | null;
  } catch {
    return silent(`a request for block ${referenceBlock}`);
  }
  const appBlock = (await app("eth_getBlockByNumber", [blockTag, false]).catch(() => null)) as {
    hash?: string;
  } | null;
  if (!appBlock?.hash) {
    return fail(
      "different-block",
      `This app could not read block ${referenceBlock} from ${target.name} at ${target.browserRpcUrl}. Nothing was sent. Check that the fork is running (pnpm dev:up).`,
    );
  }
  if (walletBlock?.hash?.toLowerCase() !== appBlock.hash.toLowerCase()) {
    const seen = walletBlock?.hash ? `block ${short(walletBlock.hash)}` : "no such block";
    return fail(
      "different-block",
      `Your wallet's network uses chain ID ${target.id} but is a different node from the one this app reads: at block ${referenceBlock} it has ${seen}, the app has block ${short(appBlock.hash)}. Nothing was sent. ${fixFor(target)}`,
    );
  }

  // 3. AgentNFT's code, through the wallet (and the app, to blame the right side).
  const appCode = await app("eth_getCode", [contract, "latest"]).catch(() => null);
  if (typeof appCode !== "string" || appCode === "0x") {
    return fail(
      "no-contract-in-app",
      `AgentNFT is not deployed at ${contract} on ${target.name}. Nothing was sent. ${target.environment === "local" ? "Deploy it with pnpm deploy:agent-nft." : "It is not available on this network yet."}`,
    );
  }
  let walletCode: unknown;
  try {
    walletCode = await wallet("eth_getCode", [contract, "latest"]);
  } catch {
    return silent("a request for AgentNFT's code");
  }
  if (typeof walletCode !== "string" || walletCode === "0x") {
    return fail(
      "no-contract-in-wallet",
      `Your wallet's network has no AgentNFT at ${contract}, although it matches ${target.name}'s chain ID and history, so it is another node without our deployment. Nothing was sent. ${fixFor(target)}`,
    );
  }
  return { ok: true };
}
