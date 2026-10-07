import { SPECIES } from "@alpha-agents/domain";
import { describe, expect, it } from "vitest";
import { ViemRevealChain } from "./keeper-chain.ts";
import {
  type BatchContext,
  MemorySteerStore,
  RevealSteering,
  type SteerBatch,
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
  const ALICE = "0x00000000000000000000000000000000000a11ce";
  const BOB = "0x0000000000000000000000000000000000000b0b";
  const batch = (next: number, last: number, owners: Record<number, string>): SteerBatch => ({
    next,
    last,
    owners: new Map(Object.entries(owners).map(([k, v]) => [Number(k), v])),
  });
  const must = <T>(v: T | null): T => {
    if (v === null) throw new Error("expected a steer");
    return v;
  };
  const steering = (first: number | null = BEE) =>
    new RevealSteering(first, new MemorySteerStore(), 143143);

  it("steers agent #1 to the first species when nothing else is chosen", async () => {
    const s = steering();
    expect(await s.targetFor(batch(1, 1, { 1: ALICE }))).toEqual({
      agentId: 1,
      species: BEE,
      source: "first",
    });
    expect(await s.targetFor(batch(2, 2, { 2: ALICE }))).toBeNull();
    expect(await steering(null).targetFor(batch(1, 1, { 1: ALICE }))).toBeNull();
  });

  it("aims a wallet steer at that wallet's agent in the batch, not the batch's first agent", async () => {
    const s = steering();
    await s.store.create(143143, { kind: "wallet", wallet: BOB }, MANTIS);
    const b = batch(1, 3, { 1: ALICE, 2: BOB, 3: BOB });
    const choice = await s.targetFor(b);
    expect(choice).toMatchObject({ agentId: 2, species: MANTIS, source: "console" });
    // A batch without Bob's agents leaves his steer pending for his next mint.
    expect((await s.targetFor(batch(4, 4, { 4: ALICE })))?.source).not.toBe("console");
    expect(await s.store.pending(143143)).toHaveLength(1);
    await s.settle(must(choice), b, true);
    const [done] = await s.store.recent(143143, 1);
    expect(done).toMatchObject({ status: "applied", appliedAgentId: 2 });
    expect(await s.store.pending(143143)).toHaveLength(0);
  });

  it("aims an agent steer at that agent only while it still has the owner it had", async () => {
    const s = steering(null);
    await s.store.create(143143, { kind: "agent", agentId: 3, owner: ALICE }, MANTIS);
    expect(await s.targetFor(batch(2, 2, { 2: ALICE }))).toBeNull();
    // After a fork reset agent #3 can belong to someone else: the steer fails, it is not inherited.
    expect(await s.targetFor(batch(3, 3, { 3: BOB }))).toBeNull();
    const [failed] = await s.store.recent(143143, 1);
    expect(failed?.status).toBe("failed");
    expect(failed?.note).toMatch(/another wallet/);
  });

  it("fails an agent steer whose agent was revealed without it, and the losers of a shared batch", async () => {
    const s = steering(null);
    await s.store.create(143143, { kind: "agent", agentId: 1, owner: ALICE }, MANTIS);
    expect(await s.targetFor(batch(2, 2, { 2: ALICE }))).toBeNull();
    expect((await s.store.recent(143143, 1))[0]?.note).toMatch(/already revealed/);

    await s.store.create(143143, { kind: "agent", agentId: 5, owner: ALICE }, MANTIS);
    await s.store.create(143143, { kind: "wallet", wallet: BOB }, BEE);
    const b = batch(5, 6, { 5: ALICE, 6: BOB });
    const choice = await s.targetFor(b);
    expect(choice?.agentId).toBe(5);
    await s.settle(must(choice), b, true);
    const all = await s.store.recent(143143, 10);
    expect(all.find((r) => r.target.kind === "wallet")).toMatchObject({
      status: "failed",
      appliedAgentId: 6,
    });
  });

  it("keeps one pending steer per target: a newer choice replaces the older", async () => {
    const s = steering();
    await s.store.create(143143, { kind: "wallet", wallet: BOB }, MANTIS);
    await s.store.create(
      143143,
      { kind: "wallet", wallet: BOB.toUpperCase().replace("0X", "0x") },
      BEE,
    );
    const pending = await s.store.pending(143143);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.species).toBe(BEE);
  });

  it("records a failed steer when the species has no slot left", async () => {
    const s = steering(null);
    await s.store.create(143143, { kind: "wallet", wallet: ALICE }, BEE);
    const b = batch(1, 1, { 1: ALICE });
    await s.settle(must(await s.targetFor(b)), b, false);
    expect((await s.store.recent(143143, 1))[0]).toMatchObject({ status: "failed" });
  });

  it("reads slugs, and refuses anything that is not a species or random", () => {
    expect(speciesFromSlug("bee")).toBe(BEE);
    expect(speciesFromSlug("random")).toBeNull();
    expect(() => speciesFromSlug("unicorn")).toThrow(/no species/);
  });
});

describe("never outside the local fork (D-221)", () => {
  it("gives testnet and beta no steering, whatever the configuration holds", () => {
    const store = new MemorySteerStore();
    expect(revealSteeringFor("testnet", "bee", store, 10143)).toBeNull();
    expect(revealSteeringFor("beta", "bee", store, 143)).toBeNull();
    expect(revealSteeringFor("mainnet", "bee", store, 143)).toBeNull();
    expect(revealSteeringFor("local", undefined, store, 143143)?.firstSpecies).toBe(BEE);
    expect(revealSteeringFor("local", "random", store, 143143)?.firstSpecies).toBeNull();
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
      () =>
        new ViemRevealChain({
          ...base,
          localFork: false,
          steering: new RevealSteering(BEE, new MemorySteerStore(), 10143),
        }),
    ).toThrow(/only on the local fork/);
    // Off the fork there is no simulated delivery at all: the number comes from Pyth.
    expect(new ViemRevealChain({ ...base, localFork: false }).deliver).toBeUndefined();
  });
});
