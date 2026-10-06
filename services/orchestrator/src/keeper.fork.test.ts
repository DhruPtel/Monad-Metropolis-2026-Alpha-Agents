import { type TestFork, startTestFork, testForkUpstream } from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import { type Hex, createPublicClient, http, parseAbi, parseAbiItem } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEEPER_POLICY, RevealKeeper } from "./keeper.ts";
import { ViemRevealChain } from "./keeper-chain.ts";
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
  let mintLocal: (nft: Hex) => Promise<{ agentId: bigint }>;
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
    const chain = new ViemRevealChain({
      rpcUrl: fork.url,
      chainId: 143143,
      agentNft: nft,
      entropy: entropy.address as Hex,
      privateKey,
      localFork: true,
    });
    const redactor = new Redactor();
    redactor.add(privateKey);
    const lines: string[] = [];
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
    expect(lines.join("\n")).not.toContain(privateKey.slice(2));
  });
});
