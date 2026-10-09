import { type Transport, fallback, http } from "viem";
import { MarketError } from "./upstream.ts";

/**
 * Research's mainnet connection (D-289, P3-U9): reads only. Every request is
 * checked against the read methods below before it leaves the process, so a
 * client built on this transport can never sign, send or touch an account,
 * whatever code holds it. It carries no key and no wallet.
 */
export const READ_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
]);

export function readOnlyTransport(rpcUrls: readonly string[], timeoutMs = 15_000): Transport {
  if (rpcUrls.length === 0) throw new Error("the read-only mainnet transport needs an RPC URL");
  const inner = fallback(rpcUrls.map((u) => http(u, { timeout: timeoutMs })));
  return (opts) => {
    const t = inner(opts);
    return {
      ...t,
      request: (async (args: { method: string; params?: unknown }) => {
        if (!READ_METHODS.has(args.method))
          throw new MarketError(
            "UPSTREAM_UNAVAILABLE",
            "monad",
            `The research connection to Monad mainnet is read-only; ${args.method} is refused.`,
            { retryable: false },
          );
        return t.request(args as never);
      }) as typeof t.request,
    };
  };
}
