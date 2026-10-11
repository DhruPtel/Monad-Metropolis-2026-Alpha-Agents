import type { ChainReaderV3, MarketStateV3 } from "@alpha-agents/chain-tools";
import type { Hex } from "viem";
import type { AttestationResult } from "./attestor.ts";

/**
 * The v3 reader with the attestor's prices laid over the market (F-U12):
 * a class A token's price, which the oracle cannot give on its own
 * (ATTESTATION_REQUIRED), comes from the attestor's current attestation
 * when it has one, so every reader of the market (the tools, the runner,
 * the Test stage, the snapshots, the sentinel) prices class A tokens the
 * same way the Executor will. The attestor's own pool source reads the
 * plain reader underneath, never this one, so nothing loops.
 */
export interface AttestedPrices {
  prices(tokens: readonly Hex[]): Promise<Record<string, AttestationResult>>;
}

export function withAttestedPrices(inner: ChainReaderV3, attestor: AttestedPrices): ChainReaderV3 {
  const overlay = async (m: MarketStateV3): Promise<MarketStateV3> => {
    const classA = m.tokens.filter((t) => t.priceClass === "A").map((t) => t.token);
    if (classA.length === 0) return m;
    const results = await attestor.prices(classA);
    const prices = { ...m.prices };
    for (const token of classA) {
      const r = results[token.toLowerCase()];
      if (r?.ok)
        prices[token.toLowerCase()] = {
          priceE18: r.priceE18,
          updatedAt: BigInt(Math.floor(r.observedAt.getTime() / 1000)),
          reason: "OK",
        };
    }
    return { ...m, prices };
  };
  return {
    chainId: inner.chainId,
    executorAddress: inner.executorAddress,
    market: () => inner.market().then(overlay),
    agent: (agentId) => inner.agent(agentId),
    custodyPath: (agentId) => inner.custodyPath(agentId),
    bestRoute: (tokenIn, tokenOut, amountIn, o) => inner.bestRoute(tokenIn, tokenOut, amountIn, o),
    quoteRoute: (route, tokenIn, amountIn) => inner.quoteRoute(route, tokenIn, amountIn),
  };
}
