import { type Transport, fallback, http } from "viem";

/**
 * The viem transport for an environment's RPC providers (P2-EC, D-254): the
 * primary alone, or the primary then the second provider through viem's
 * fallback transport, which moves a request to the next provider on a network
 * failure, a rate limit or a server error, and never on a revert or another
 * answer about the request itself.
 */
export function rpcTransport(primary: string, secondary?: string | null): Transport {
  if (!secondary || secondary === primary) return http(primary);
  return fallback([http(primary, { retryCount: 1 }), http(secondary, { retryCount: 1 })]);
}
