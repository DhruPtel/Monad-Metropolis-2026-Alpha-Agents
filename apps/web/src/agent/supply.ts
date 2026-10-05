import { SPECIES, type Species, TIER_IDS, type Tier, slotsFor } from "@alpha-agents/domain";
import type { PublicClient } from "viem";
import { AGENT_NFT_ABI, type AgentNftDeployment } from "./agent-nft";

/**
 * The mint page's supply figures (P1-U10), from AgentNFT's own reads: the cap,
 * the minted count, and the deck's remaining slots per species.
 *
 * The deck shrinks at reveal, not at mint, so a tier's remaining count still
 * includes agents that are minted and waiting for their reveal. The odds of
 * the next mint landing in a tier are its remaining slots over all remaining
 * slots: each reveal draws uniformly from what is left, so by symmetry the
 * next agent's draw has that chance however the earlier pending reveals fall.
 */
export interface SupplyReading {
  readonly maxSupply: number;
  readonly totalMinted: number;
  /** `remainingOf(species)` for species 1 to 25, in SPECIES order. */
  readonly remaining: readonly number[];
}

export interface SpeciesSupply {
  readonly species: Species;
  readonly remaining: number;
}

export interface TierSupply {
  readonly tier: Tier;
  readonly slots: number;
  /** The tier's full supply, from the species counts (D-178). */
  readonly total: number;
  /** Slots left in the deck for this tier. */
  readonly remaining: number;
  /** The chance the next mint lands here, 0 to 1; null when nothing can be minted. */
  readonly odds: number | null;
  readonly species: readonly SpeciesSupply[];
}

export interface SupplySummary {
  readonly maxSupply: number;
  readonly minted: number;
  readonly leftToMint: number;
  /** Minted agents whose tier is not drawn yet. */
  readonly awaitingReveal: number;
  readonly soldOut: boolean;
  readonly tiers: readonly TierSupply[];
}

export function summarizeSupply(reading: SupplyReading): SupplySummary {
  if (reading.remaining.length !== SPECIES.length) {
    throw new RangeError(
      `expected ${SPECIES.length} species counts, got ${reading.remaining.length}`,
    );
  }
  const deck = reading.remaining.reduce((sum, n) => sum + n, 0);
  const leftToMint = Math.max(0, reading.maxSupply - reading.totalMinted);
  const soldOut = leftToMint === 0;
  const revealed = reading.maxSupply - deck;
  const tiers = TIER_IDS.map((tier): TierSupply => {
    const species = SPECIES.filter((s) => s.tier === tier).map((s) => ({
      species: s,
      remaining: reading.remaining[s.index - 1] ?? 0,
    }));
    const remaining = species.reduce((sum, s) => sum + s.remaining, 0);
    return {
      tier,
      slots: slotsFor(tier),
      total: species.reduce((sum, s) => sum + s.species.count, 0),
      remaining,
      odds: soldOut || deck === 0 ? null : remaining / deck,
      species,
    };
  });
  return {
    maxSupply: reading.maxSupply,
    minted: reading.totalMinted,
    leftToMint,
    awaitingReveal: Math.max(0, reading.totalMinted - revealed),
    soldOut,
    tiers,
  };
}

/** Odds as a percentage with one decimal; never rounds a live chance to 0% or a doubt to 100%. */
export function formatOdds(odds: number | null): string {
  if (odds === null) return "None left";
  if (odds <= 0) return "0%";
  if (odds >= 1) return "100%";
  const pct = odds * 100;
  if (pct < 0.1) return "<0.1%";
  if (pct > 99.9) return ">99.9%";
  return `${pct.toFixed(1)}%`;
}

export const formatCount = (n: number) => n.toLocaleString("en-US");

/** Reads the supply from AgentNFT through the app's chain client. */
export async function readSupply(
  client: PublicClient,
  deployment: AgentNftDeployment,
): Promise<SupplyReading> {
  const target = { address: deployment.address, abi: AGENT_NFT_ABI } as const;
  const [maxSupply, totalMinted, ...remaining] = await Promise.all([
    client.readContract({ ...target, functionName: "MAX_SUPPLY" }),
    client.readContract({ ...target, functionName: "totalMinted" }),
    ...SPECIES.map((s) =>
      client.readContract({ ...target, functionName: "remainingOf", args: [s.index] }),
    ),
  ]);
  return {
    maxSupply: Number(maxSupply),
    totalMinted: Number(totalMinted),
    remaining: remaining.map(Number),
  };
}
