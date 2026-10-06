import { SPECIES } from "@alpha-agents/domain";
import { describe, expect, it } from "vitest";
import { ViemRevealChain } from "./keeper-chain.ts";
import {
  type BatchContext,
  RevealSteering,
  findRandomNumber,
  revealSteeringFor,
  simulateBatch,
  speciesFromSlug,
} from "./reveal-steer.ts";

const FULL_DECK = SPECIES.map((s) => s.count);
const BEE = 14;
const MANTIS = 15;
const ctx = (over: Partial<BatchContext> = {}): BatchContext => ({
  sequence: 7n,
  chainId: 143143,
  contract: "0x60cacA6dE327331b321E140Ae19AcbCc4188Be6E",
  next: 1,
  last: 3,
  deck: FULL_DECK,
  ...over,
});

describe("replaying AgentNFT's draw (D-221)", () => {
  it("assigns every agent of the batch a species from the deck, the same way each time", () => {
    const n = `0x${"ab".repeat(32)}` as const;
    const a = simulateBatch(n, ctx());
    expect([...a.keys()]).toEqual([1, 2, 3]);
    expect(simulateBatch(n, ctx())).toEqual(a);
    for (const s of a.values()) expect(s).toBeGreaterThanOrEqual(1);
  });

  it("never draws a species with no slot left", () => {
    // Only the ant has slots: every draw is an ant, whatever the number.
    const deck = FULL_DECK.map((_, i) => (i === 2 ? 997 : 0));
    const out = simulateBatch(`0x${"01".repeat(32)}`, ctx({ deck, next: 4, last: 6 }));
    expect([...out.values()]).toEqual([3, 3, 3]);
  });

  it("finds a number that reveals agent #1 as the Bee, and one for a later agent of the batch", () => {
    const first = findRandomNumber({ agentId: 1, species: BEE }, ctx());
    expect(first).not.toBeNull();
    expect(simulateBatch(first as `0x${string}`, ctx()).get(1)).toBe(BEE);
    const third = findRandomNumber({ agentId: 3, species: MANTIS }, ctx());
    expect(simulateBatch(third as `0x${string}`, ctx()).get(3)).toBe(MANTIS);
  });

  it("gives up for a species with no slot, or an agent outside the batch", () => {
    const noBee = FULL_DECK.map((c, i) => (i === BEE - 1 ? 0 : c));
    expect(findRandomNumber({ agentId: 1, species: BEE }, ctx({ deck: noBee }))).toBeNull();
    expect(findRandomNumber({ agentId: 9, species: BEE }, ctx())).toBeNull();
  });
});

describe("what to steer", () => {
  it("steers agent #1 to the first species, and the next reveal to the console's choice once", () => {
    const s = new RevealSteering(BEE);
    expect(s.targetFor(1)).toEqual({ agentId: 1, species: BEE, source: "first" });
    expect(s.targetFor(2)).toBeNull();
    s.setNext(MANTIS);
    expect(s.targetFor(2)).toEqual({ agentId: 2, species: MANTIS, source: "console" });
    // The console's choice wins even for agent #1, and is used once.
    expect(s.targetFor(1)?.source).toBe("console");
    s.consumed("console");
    expect(s.targetFor(2)).toBeNull();
    expect(new RevealSteering(null).targetFor(1)).toBeNull();
  });

  it("reads slugs, and refuses anything that is not a species or random", () => {
    expect(speciesFromSlug("bee")).toBe(BEE);
    expect(speciesFromSlug("random")).toBeNull();
    expect(() => speciesFromSlug("unicorn")).toThrow(/no species/);
  });
});

describe("never outside the local fork (D-221)", () => {
  it("gives testnet and beta no steering, whatever the configuration holds", () => {
    expect(revealSteeringFor("testnet", "bee")).toBeNull();
    expect(revealSteeringFor("beta", "bee")).toBeNull();
    expect(revealSteeringFor("mainnet", "bee")).toBeNull();
    expect(revealSteeringFor("local", undefined)?.firstSpecies).toBe(BEE);
    expect(revealSteeringFor("local", "random")?.firstSpecies).toBeNull();
  });

  it("refuses to build a chain client that steers a real Entropy reveal", () => {
    const base = {
      rpcUrl: "http://127.0.0.1:9",
      chainId: 10143,
      agentNft: "0x60cacA6dE327331b321E140Ae19AcbCc4188Be6E" as const,
      entropy: "0x825c0390f379c631f3cf11a82a37d20bddf93c07" as const,
      privateKey: `0x${"11".repeat(32)}` as const,
    };
    expect(
      () => new ViemRevealChain({ ...base, localFork: false, steering: new RevealSteering(BEE) }),
    ).toThrow(/only on the local fork/);
    // Off the fork there is no simulated delivery at all: the number comes from Pyth.
    expect(new ViemRevealChain({ ...base, localFork: false }).deliver).toBeUndefined();
  });
});
