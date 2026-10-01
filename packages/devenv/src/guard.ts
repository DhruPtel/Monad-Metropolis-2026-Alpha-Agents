import { LOCAL_FORK_RPC_URL, MONAD_MAINNET_CHAIN_ID } from "@alpha-agents/config";
import { hexToNumber, rpc } from "./rpc.ts";

/**
 * The local-fork guard. Every action that changes chain state calls it first
 * and refuses to run unless the target is the local anvil fork:
 * 1. the URL's host is exactly 127.0.0.1 (checked before any request, so a
 *    remote RPC is never contacted);
 * 2. the node says it is anvil (web3_clientVersion "anvil/...");
 * 3. it serves chain 143, the Monad mainnet fork.
 */
export class NotLocalForkError extends Error {
  constructor(reason: string) {
    super(`Refused: the target RPC is not the local anvil fork (${reason}).`);
    this.name = "NotLocalForkError";
  }
}

export const LOCAL_HOST = "127.0.0.1";

export async function assertLocalFork(url: string = LOCAL_FORK_RPC_URL): Promise<void> {
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
  if (chainId !== MONAD_MAINNET_CHAIN_ID) {
    throw new NotLocalForkError(`chain ID is ${chainId}, not ${MONAD_MAINNET_CHAIN_ID}`);
  }
}
