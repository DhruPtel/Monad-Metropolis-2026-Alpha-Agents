import { type TestFork, startTestFork, testForkUpstream } from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import { type Hex, createPublicClient, http, parseAbi, parseAbiItem } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEEPER_POLICY, RevealKeeper } from "./keeper.ts";
import { ViemRevealChain } from "./keeper-chain.ts";
import { MemorySteerStore, RevealSteering } from "./reveal-steer.ts";
import { Redactor } from "./secrets.ts";

/**
 * The keeper against the real AgentNFT and Pyth Entropy on a fork of its own
 * (D-200, port 8549): three mints inside one window share one request, the
 * number is delivered as Entropy on the fork, and every agent is revealed.
 * Skips without MONAD_RPC_URL (as in CI).
 */
const PORT = 8549;
const upstream = testForkUpstream();
const SLOW = 240_000;

describe.skipIf(upstream === null)("the reveal keeper on a real fork", { timeout: SLOW }, () => {
  let fork: TestFork;
  let nft: Hex;
  let mintLocal: (nft: Hex, minter?: Hex) => Promise<{ agentId: bigint }>;
  const previousPort = process.env.LOCAL_FORK_PORT;

  beforeAll(async () => {
    process.env.LOCAL_FORK_PORT = String(PORT);
    fork = await startTestFork({ port: PORT });
    const { deployLocal } = await import("../../../scripts/lib/agent-nft.js");
    ({ mintLocal } = (await import("../../../scripts/lib/agent-mint.js")) as never);
    nft = (await deployLocal({ quiet: true })) as Hex;
  }, SLOW);

  afterAll(async () => {
    await fork?.stop();
    if (previousPort === undefined) delete process.env.LOCAL_FORK_PORT;
    else process.env.LOCAL_FORK_PORT = previousPort;
  }, SLOW);

  it("requests once for a window of mints, delivers, and reveals them all", async () => {
    // Anvil's public development account 3, the keeper's local wallet (D-201).
    const hd = mnemonicToAccount("test test test test test test test test test test test junk", {
      addressIndex: 3,
    }).getHdKey();
    const privateKey = `0x${Buffer.from(hd.privateKey ?? new Uint8Array()).toString("hex")}` as Hex;
    const entropy = addressEntry("local", "pyth_entropy");
    if (entropy.status !== "verified") throw new Error("address book: pyth_entropy");
    const steering = new RevealSteering(14, new MemorySteerStore(), 143143);
    const lines: string[] = [];
    const chain = new ViemRevealChain({
      rpcUrl: fork.url,
      chainId: 143143,
      agentNft: nft,
      entropy: entropy.address as Hex,
      privateKey,
      localFork: true,
      // D-221: the fork's default steering, agent #1 as the Bee.
      steering,
      log: (l) => lines.push(l),
    });
    const redactor = new Redactor();
    redactor.add(privateKey);
    let now = 0;
    const keeper = new RevealKeeper({
      chain,
      policy: KEEPER_POLICY.local,
      log: (l) => lines.push(redactor.redact(l)),
      redactor,
      clock: () => now,
    });
    const client = createPublicClient({ transport: http(fork.url) });
    const from = await client.getBlockNumber();

    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await mintLocal(nft)).agentId);
      expect((await keeper.tick()).kind).toBe("waiting");
      now += 2_000;
    }
    now += 10_000;
    expect(await keeper.tick()).toMatchObject({ kind: "requested", first: 1, last: 3 });
    expect((await keeper.tick()).kind).toBe("delivered");
    expect(await keeper.tick()).toMatchObject({ kind: "revealed", upTo: 3 });
    expect(await keeper.tick()).toEqual({ kind: "idle" });

    const requests = await client.getLogs({
      address: nft,
      event: parseAbiItem(
        "event RevealRequested(uint64 indexed sequence, uint256 firstAgentId, uint256 lastAgentId, bool retry)",
      ),
      fromBlock: from,
    });
    expect(requests).toHaveLength(1);
    const speciesOf = parseAbi(["function speciesOf(uint256) view returns (uint8)"]);
    for (const id of ids) {
      const species = await client.readContract({
        address: nft,
        abi: speciesOf,
        functionName: "speciesOf",
        args: [id],
      });
      expect(species).toBeGreaterThan(0);
    }
    const revealedAs = (id: bigint) =>
      client.readContract({ address: nft, abi: speciesOf, functionName: "speciesOf", args: [id] });
    // The real contract, fed the steered number, revealed agent #1 as the Bee (D-221).
    expect(ids[0]).toBe(1n);
    expect(await revealedAs(1n)).toBe(14);
    expect(lines.some((l) => /steering agent #1's reveal to Bee/.test(l))).toBe(true);

    // The console's "Reveal next as" for one pending agent: agent #4 reveals as the praying mantis.
    const fourth = (await mintLocal(nft)).agentId;
    const ownerOf = parseAbi(["function ownerOf(uint256) view returns (address)"]);
    const owner4 = await client.readContract({
      address: nft,
      abi: ownerOf,
      functionName: "ownerOf",
      args: [fourth],
    });
    await steering.store.create(143143, { kind: "agent", agentId: 4, owner: owner4 }, 15);
    expect((await keeper.tick()).kind).toBe("waiting");
    now += 12_000;
    expect(await keeper.tick()).toMatchObject({ kind: "requested", first: 4, last: 4 });
    expect((await keeper.tick()).kind).toBe("delivered");
    expect(await keeper.tick()).toMatchObject({ kind: "revealed", upTo: 4 });
    expect(await revealedAs(fourth)).toBe(15);
    expect((await steering.store.recent(143143, 1))[0]).toMatchObject({
      status: "applied",
      appliedAgentId: 4,
    });

    // For a wallet: in a batch of two, the steer lands on that wallet's agent (#6), not the first (#5).
    const wallet = privateKeyToAccount(generatePrivateKey()).address;
    await steering.store.create(143143, { kind: "wallet", wallet }, 16);
    const fifth = (await mintLocal(nft)).agentId;
    const sixth = (await mintLocal(nft, wallet)).agentId;
    expect([fifth, sixth]).toEqual([5n, 6n]);
    expect((await keeper.tick()).kind).toBe("waiting");
    now += 12_000;
    expect(await keeper.tick()).toMatchObject({ kind: "requested", first: 5, last: 6 });
    expect((await keeper.tick()).kind).toBe("delivered");
    expect(await keeper.tick()).toMatchObject({ kind: "revealed", upTo: 6 });
    expect(await revealedAs(sixth)).toBe(16);
    expect(await steering.store.pending(143143)).toHaveLength(0);
    expect(lines.join("\n")).not.toContain(privateKey.slice(2));
  });
});
