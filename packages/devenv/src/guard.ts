import { FORK_CHAIN_IDS, LOCAL_FORK_CHAIN_ID, MONAD_MAINNET_CHAIN_ID } from "@alpha-agents/config";
import { hexToNumber, rpc } from "./rpc.ts";

/**
 * The local-fork guard. Every action that changes chain state calls it first
 * and refuses to run unless the target is the local anvil fork:
 * 1. the URL's host is exactly 127.0.0.1 (checked before any request, so a
 *    remote RPC is never contacted);
 * 2. the node says it is anvil (web3_clientVersion "anvil/...");
 * 3. it serves the local fork's own chain, 143143 (D-195).
 */
export class NotLocalForkError extends Error {
  constructor(reason: string) {
    super(`Refused: the target RPC is not the local anvil fork (${reason}).`);
    this.name = "NotLocalForkError";
  }
}

export const LOCAL_HOST = "127.0.0.1";

export async function assertLocalFork(url: string): Promise<void> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new NotLocalForkError("the RPC URL is not a URL");
  }
  if (host !== LOCAL_HOST) throw new NotLocalForkError(`host is not ${LOCAL_HOST}`);

  let client: unknown;
  try {
    client = await rpc(url, "web3_clientVersion", [], 3_000);
  } catch {
    throw new NotLocalForkError("nothing answers at the local RPC address");
  }
  if (typeof client !== "string" || !client.startsWith("anvil/")) {
    throw new NotLocalForkError("the node is not anvil");
  }
  const chainId = hexToNumber(await rpc(url, "eth_chainId", [], 3_000));
  // M-FAST: a fork on this machine answers one of the fork chain ids (Monad's 143143, Base's 84538453), never a real chain's.
  if (!FORK_CHAIN_IDS.includes(chainId)) {
    const hint =
      chainId === MONAD_MAINNET_CHAIN_ID
        ? "; this fork was started as chain 143, restart it with pnpm dev:down then pnpm dev:up"
        : "";
    throw new NotLocalForkError(
      `chain ID is ${chainId}, not one of ${FORK_CHAIN_IDS.join(", ")}${hint}`,
    );
  }
}
