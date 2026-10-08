import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import type { ApiAgent } from "@/api/client";
import { type AgentNftReader, CHAIN_SCAN_LIMIT, ownedAgentsWithChain } from "./owned-agents";

const OWNER = "0x683eE842A16f85e69883F433745263BFe8D55f76" as Address;
const OTHER = "0xc7fcA8F663b8a20f8aFcCdd92E031678423AC2c8" as Address;
const TBA = "0x0000000000000000000000000000000000000Abc" as Address;

/** A chain with agents 1..n: owner and species per ID; counts the calls it answers. */
function chainOf(
  agents: Record<number, { owner: Address; species: number }>,
  minted: Address[] = [],
) {
  const calls = { ownerOf: 0, agent: 0 };
  const reader: AgentNftReader = {
    totalMinted: async () => BigInt(Object.keys(agents).length),
    hasMinted: async (w) => minted.some((m) => m.toLowerCase() === w.toLowerCase()),
    ownerOf: async (id) => {
      calls.ownerOf++;
      return agents[Number(id)]?.owner ?? null;
    },
    agent: async (id) => {
      calls.agent++;
      return { tba: TBA, species: agents[Number(id)]?.species ?? 0, ownerEpoch: 0n };
    },
  };
  return { reader, calls };
}

const indexed = (id: number, species: number, owner = OWNER): ApiAgent => ({
  id: BigInt(id),
  owner,
  tba: TBA,
  species,
  ownerEpoch: 0n,
});

describe("the wallet's agents when the index lags the chain (P2-EC)", () => {
  it("shows a revealed agent the index has not seen as pending indexing, never as no agent", async () => {
    // The testnet case: agent 2 minted and revealed on chain; the index knows only agent 1.
    const { reader } = chainOf(
      { 1: { owner: OTHER, species: 1 }, 2: { owner: OWNER, species: 5 } },
      [OTHER, OWNER],
    );
    const r = await ownedAgentsWithChain(OWNER, [], 1, reader);
    expect(r.agents).toEqual([
      {
        id: 2n,
        owner: OWNER,
        tba: TBA,
        species: 5,
        ownerEpoch: 0n,
        pending: "indexing",
        indexed: false,
      },
    ]);
    expect(r.hasMinted).toBe(true);
    expect(r.indexLagging).toBe(true);
  });

  it("shows an unrevealed agent the index has not seen as waiting for its reveal", async () => {
    const { reader } = chainOf({ 1: { owner: OWNER, species: 0 } }, [OWNER]);
    const r = await ownedAgentsWithChain(OWNER, [], 0, reader);
    expect(r.agents.map((a) => [a.id, a.pending])).toEqual([[1n, "reveal"]]);
  });

  it("takes the reveal from the chain when the index still shows the agent unrevealed", async () => {
    const { reader } = chainOf({ 1: { owner: OWNER, species: 9 } }, [OWNER]);
    const r = await ownedAgentsWithChain(OWNER, [indexed(1, 0)], 1, reader);
    expect(r.agents).toMatchObject([{ id: 1n, species: 9, pending: "indexing" }]);
  });

  it("adds nothing and marks nothing once the index has caught up", async () => {
    const { reader, calls } = chainOf({ 1: { owner: OWNER, species: 3 } }, [OWNER]);
    const r = await ownedAgentsWithChain(OWNER, [indexed(1, 3)], 1, reader);
    expect(r.agents).toEqual([{ ...indexed(1, 3), pending: null, indexed: true }]);
    expect(r.indexLagging).toBe(false);
    expect(calls).toEqual({ ownerOf: 0, agent: 0 });
  });

  it("leaves out agents other wallets minted while the index lagged", async () => {
    const { reader } = chainOf(
      { 1: { owner: OTHER, species: 1 }, 2: { owner: OTHER, species: 0 } },
      [OTHER],
    );
    const r = await ownedAgentsWithChain(OWNER, [], 0, reader);
    expect(r.agents).toEqual([]);
    expect(r.hasMinted).toBe(false);
  });

  it("reports a wallet that minted even when its agent has left it", async () => {
    const { reader } = chainOf({ 1: { owner: OTHER, species: 1 } }, [OWNER]);
    const r = await ownedAgentsWithChain(OWNER, [], 1, reader);
    expect(r).toMatchObject({ agents: [], hasMinted: true });
  });

  it("reads at most the newest CHAIN_SCAN_LIMIT agents past the index", async () => {
    const agents: Record<number, { owner: Address; species: number }> = {};
    for (let i = 1; i <= 120; i++) agents[i] = { owner: i === 120 ? OWNER : OTHER, species: 1 };
    const { reader, calls } = chainOf(agents, [OWNER]);
    const r = await ownedAgentsWithChain(OWNER, [], 0, reader);
    expect(r.agents.map((a) => a.id)).toEqual([120n]);
    expect(calls.ownerOf).toBe(CHAIN_SCAN_LIMIT);
  });

  it("lets a chain failure surface instead of answering no agents", async () => {
    const { reader } = chainOf({ 1: { owner: OWNER, species: 1 } }, [OWNER]);
    const failing: AgentNftReader = {
      ...reader,
      ownerOf: () => Promise.reject(new Error("fetch failed")),
    };
    await expect(ownedAgentsWithChain(OWNER, [], 0, failing)).rejects.toThrow("fetch failed");
  });
});
