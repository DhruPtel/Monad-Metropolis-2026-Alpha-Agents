import { type TestFork, startTestFork, testForkUpstream } from "@alpha-agents/devenv";
import { SPECIES, slotsFor, speciesByIndex } from "@alpha-agents/domain";
import { type Hex, createPublicClient, http, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * NFT-U1: the new AgentNFT on a fork of its own (port 8587): a mint and a
 * steered reveal for one species of every tier, the first 25 and the nine
 * appended ones alike, each agent's tier and slots following its species
 * through the tier table; and two mints per wallet, the third refused by the
 * real contract. Skips without MONAD_RPC_URL (as in CI).
 */
const PORT = 8587;
const upstream = testForkUpstream();
const SLOW = 300_000;

const ABI = parseAbi([
  "function speciesOf(uint256) view returns (uint8)",
  "function tierOf(uint256) view returns (uint8)",
  "function slotsOf(uint256) view returns (uint8)",
  "function mintsOf(address) view returns (uint8)",
  "function MINTS_PER_WALLET() view returns (uint8)",
  "function SPECIES_COUNT() view returns (uint8)",
  "function remainingOf(uint8) view returns (uint256)",
  "function tokenURI(uint256) view returns (string)",
]);
const TIER_NUMBER = { base: 1, medium: 2, pro: 3 } as const;

describe.skipIf(upstream === null)("the new AgentNFT on a real fork", { timeout: SLOW }, () => {
  let fork: TestFork;
  let nft: Hex;
  let mintLocal: (nft: Hex, minter?: Hex) => Promise<{ agentId: bigint }>;
  let revealLocal: (
    nft: Hex,
    want?: { agentId: bigint; species: number },
  ) => Promise<{ first: bigint; last: bigint } | null>;
  const previousPort = process.env.LOCAL_FORK_PORT;

  beforeAll(async () => {
    process.env.LOCAL_FORK_PORT = String(PORT);
    fork = await startTestFork({ port: PORT });
    const { deployLocal } = await import("../../../scripts/lib/agent-nft.js");
    ({ mintLocal } = (await import("../../../scripts/lib/agent-mint.js")) as never);
    ({ revealLocal } = (await import("../../../scripts/lib/agent-reveal.js")) as never);
    nft = (await deployLocal({ quiet: true })) as Hex;
  }, SLOW);

  afterAll(async () => {
    await fork?.stop();
    if (previousPort === undefined) delete process.env.LOCAL_FORK_PORT;
    else process.env.LOCAL_FORK_PORT = previousPort;
  }, SLOW);

  it("deploys with 34 species, two mints per wallet and the new deck", async () => {
    const client = createPublicClient({ transport: http(fork.url) });
    const read = <T>(functionName: string, args: readonly unknown[] = []) =>
      client.readContract({ address: nft, abi: ABI, functionName, args } as never) as Promise<T>;
    expect(Number(await read<number>("SPECIES_COUNT"))).toBe(SPECIES.length);
    expect(Number(await read<number>("MINTS_PER_WALLET"))).toBe(2);
    for (const s of SPECIES)
      expect(Number(await read<bigint>("remainingOf", [s.index]))).toBe(s.count);
  });

  it("mints and reveals one species of every tier, old and appended, with the right tier and slots", async () => {
    const client = createPublicClient({ transport: http(fork.url) });
    const read = <T>(functionName: string, args: readonly unknown[] = []) =>
      client.readContract({ address: nft, abi: ABI, functionName, args } as never) as Promise<T>;
    // A base, a medium and a pro of the first 25, then one of each tier among the nine new ones.
    const wanted = [4, 9, 14, 29, 30, 34];
    for (const species of wanted) {
      const { agentId } = await mintLocal(nft);
      const batch = await revealLocal(nft, { agentId, species });
      expect(batch).toMatchObject({ first: agentId, last: agentId });
      const expected = speciesByIndex(species);
      expect(Number(await read<number>("speciesOf", [agentId]))).toBe(species);
      expect(Number(await read<number>("tierOf", [agentId]))).toBe(TIER_NUMBER[expected.tier]);
      expect(Number(await read<number>("slotsOf", [agentId]))).toBe(slotsFor(expected.tier));
      const uri = await read<string>("tokenURI", [agentId]);
      const json = JSON.parse(
        Buffer.from(uri.replace("data:application/json;base64,", ""), "base64").toString("utf8"),
      ) as { image: string; attributes: { trait_type: string; value: string }[] };
      expect(json.image).toBe(`ipfs://alpha-agents-images-pending/${expected.slug}.png`);
      expect(json.attributes).toEqual([
        {
          trait_type: "Tier",
          value: { base: "Base", medium: "Medium", pro: "Pro" }[expected.tier],
        },
        { trait_type: "Species", value: expected.name },
        { trait_type: "Status", value: "Revealed" },
      ]);
      expect(Number(await read<bigint>("remainingOf", [species]))).toBe(expected.count - 1);
    }
  });

  it("lets one wallet mint twice and refuses its third mint on the real contract", async () => {
    const client = createPublicClient({ transport: http(fork.url) });
    const wallet = privateKeyToAccount(generatePrivateKey()).address;
    const first = await mintLocal(nft, wallet);
    const second = await mintLocal(nft, wallet);
    expect(second.agentId).toBe(first.agentId + 1n);
    const mints = await client.readContract({
      address: nft,
      abi: ABI,
      functionName: "mintsOf",
      args: [wallet],
    });
    expect(Number(mints)).toBe(2);
    await expect(mintLocal(nft, wallet)).rejects.toThrow(/MintLimitReached|reverted/);
  });
});
