import { randomBytes } from "node:crypto";
import { AGENT_MAX_SUPPLY, SPECIES } from "@alpha-agents/domain";
import { type Hex, encodeAbiParameters, keccak256 } from "viem";

/**
 * Steered reveals on the local fork only (D-221). On the fork the keeper
 * plays Entropy and delivers the random number itself, so it may pick a
 * number under which a chosen agent draws a chosen species. This replays
 * AgentNFT's draw exactly (AgentNFT.sol `_entropyCallback` and `reveal`):
 *
 *   seed    = keccak256(abi.encode(randomNumber, sequence, block.chainid, address(this)))
 *   draw(n) = uint256(keccak256(abi.encode(seed, n))) % remaining
 *
 * with `remaining` starting at MAX_SUPPLY - (next - 1) and each drawn species
 * leaving the deck in mint order. Nothing here touches a chain, and nothing
 * outside the fork's simulated delivery calls it: on testnet and mainnet the
 * number comes from Pyth Entropy and is never chosen by the platform.
 */
export interface BatchContext {
  readonly sequence: bigint;
  readonly chainId: number;
  readonly contract: Hex;
  /** The first agent the batch reveals (AgentNFT's nextToReveal). */
  readonly next: number;
  /** The batch's last agent. */
  readonly last: number;
  /** Slots left per species, index 0 for species 1 (AgentNFT's remainingOf). */
  readonly deck: readonly number[];
}

export function revealSeed(randomNumber: Hex, c: BatchContext): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }, { type: "uint256" }, { type: "address" }],
      [randomNumber, c.sequence, BigInt(c.chainId), c.contract],
    ),
  );
}

/** The species each agent of the batch draws under this number, as the contract would assign them. */
export function simulateBatch(randomNumber: Hex, c: BatchContext): Map<number, number> {
  const seed = revealSeed(randomNumber, c);
  const deck = [...c.deck];
  let remaining = BigInt(AGENT_MAX_SUPPLY - (c.next - 1));
  const out = new Map<number, number>();
  for (let n = c.next; n <= c.last; n += 1) {
    let draw =
      BigInt(
        keccak256(
          encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [seed, BigInt(n)]),
        ),
      ) % remaining;
    let species = 0;
    for (let s = 0; s < deck.length; s += 1) {
      const count = BigInt(deck[s] ?? 0);
      if (draw < count) {
        species = s + 1;
        break;
      }
      draw -= count;
    }
    if (species === 0) throw new Error("the deck is smaller than the remaining count");
    deck[species - 1] = (deck[species - 1] ?? 0) - 1;
    remaining -= 1n;
    out.set(n, species);
  }
  return out;
}

/**
 * A random number under which `agentId` draws `species`, or null when that
 * species has no slot left or none was found within the tries (the caller then
 * delivers an ordinary random number).
 */
export function findRandomNumber(
  target: { readonly agentId: number; readonly species: number },
  c: BatchContext,
  maxTries = 100_000,
  random: () => Hex = () => `0x${randomBytes(32).toString("hex")}`,
): Hex | null {
  if (target.agentId < c.next || target.agentId > c.last) return null;
  if ((c.deck[target.species - 1] ?? 0) <= 0) return null;
  for (let i = 0; i < maxTries; i += 1) {
    const candidate = random();
    if (simulateBatch(candidate, c).get(target.agentId) === target.species) return candidate;
  }
  return null;
}

/** A species index from its slug ("bee"), or null for "random"; throws on anything else. */
export function speciesFromSlug(slug: string): number | null {
  if (slug === "random") return null;
  const s = SPECIES.find((x) => x.slug === slug);
  if (!s) throw new Error(`no species "${slug}"; use a slug such as bee, or random`);
  return s.index;
}

/**
 * What the local keeper should steer (D-221): the first reveal on a fresh fork
 * (agent #1) to `firstSpecies`, and the next reveal to whatever the dev
 * console chose, once. Held in memory by the orchestrator, local only.
 */
export class RevealSteering {
  readonly firstSpecies: number | null;
  private next: number | null = null;

  constructor(firstSpecies: number | null) {
    this.firstSpecies = firstSpecies;
  }

  /** The dev console's choice for the next reveal; null clears it. */
  setNext(species: number | null): void {
    this.next = species;
  }

  get nextSpecies(): number | null {
    return this.next;
  }

  /** The steer for a batch starting at `next`: the console's choice first, else agent #1's. */
  targetFor(
    next: number,
  ): { agentId: number; species: number; source: "console" | "first" } | null {
    if (this.next !== null) return { agentId: next, species: this.next, source: "console" };
    if (next === 1 && this.firstSpecies !== null)
      return { agentId: 1, species: this.firstSpecies, source: "first" };
    return null;
  }

  /** Called once a steered number was delivered: the console's choice is used once. */
  consumed(source: "console" | "first"): void {
    if (source === "console") this.next = null;
  }
}

/**
 * The orchestrator's steering for an environment: local only (D-221). Any
 * other environment gets none, whatever the configuration holds; the config
 * loader also refuses to start them with a species set.
 */
export function revealSteeringFor(
  environment: string,
  firstSpeciesSlug: string | undefined,
): RevealSteering | null {
  if (environment !== "local") return null;
  return new RevealSteering(speciesFromSlug(firstSpeciesSlug ?? "bee"));
}
