import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { type TestFork, rpc, startTestFork, testForkUpstream } from "@alpha-agents/devenv";
import { AGENT_NFT_ABI, addressEntry } from "@alpha-agents/domain";
import { type Hex, createPublicClient, http } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Indexer, type IndexerTarget } from "./indexer.ts";
import { RpcLogSource } from "./rpc-source.ts";

/**
 * The indexer against a real anvil fork of its own (D-200), port 8548 so it
 * never meets the devenv test's fork on 8546 or the playtest fork on 8545:
 * catch-up from AgentNFT's deploy over real events, a restart from the
 * watermark, and a real reorg and rewind made with evm_snapshot and
 * evm_revert. Skips without MONAD_RPC_URL (as in CI) or without Postgres.
 */
const PORT = 8548;
const upstream = testForkUpstream();
const dbUp = await databaseAvailable();
const SLOW = 180_000;

describe.skipIf(upstream === null || !dbUp)("the indexer on a real fork", { timeout: SLOW }, () => {
  let fork: TestFork;
  let t: TestDatabase;
  let nft: Hex;
  let target: IndexerTarget;
  let mintLocal: (nft: Hex, minter?: Hex) => Promise<{ agentId: bigint; minter: Hex }>;
  let revealLocal: (nft: Hex) => Promise<unknown>;
  const previousPort = process.env.LOCAL_FORK_PORT;

  const indexer = () =>
    new Indexer({ db: t.db, source: new RpcLogSource({ url: fork.url }), target });
  const client = () => createPublicClient({ transport: http(fork.url) });
  const agents = () => t.db.selectFrom("indexer.agents").selectAll().orderBy("agent_id").execute();
  const eventCount = async () =>
    Number(
      (
        await t.db
          .selectFrom("indexer.agent_nft_events")
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .executeTakeFirstOrThrow()
      ).n,
    );

  beforeAll(async () => {
    // The fork helpers in scripts/lib read the port when they load.
    process.env.LOCAL_FORK_PORT = String(PORT);
    fork = await startTestFork({ port: PORT });
    t = await createTestDatabase("indexer_fork");
    const { deployLocal } = await import("../../../scripts/lib/agent-nft.js");
    ({ mintLocal } = (await import("../../../scripts/lib/agent-mint.js")) as never);
    ({ revealLocal } = (await import("../../../scripts/lib/agent-reveal.js")) as never);
    nft = (await deployLocal({ quiet: true })) as Hex;
    const entry = addressEntry("local", "agent_nft");
    const usdc = addressEntry("local", "usdc");
    if (entry.status !== "verified" || usdc.status !== "verified") throw new Error("address book");
    expect(nft.toLowerCase()).toBe(entry.address.toLowerCase());
    target = {
      chainId: 143143,
      agentNft: nft,
      usdc: usdc.address as Hex,
      startBlock: entry.verification.block + 1,
    };
  }, SLOW);

  afterAll(async () => {
    await t?.drop();
    await fork?.stop();
    if (previousPort === undefined) delete process.env.LOCAL_FORK_PORT;
    else process.env.LOCAL_FORK_PORT = previousPort;
  }, SLOW);

  it("catches up from the deploy block and agrees with the contract", async () => {
    await mintLocal(nft);
    await mintLocal(nft);
    await revealLocal(nft);
    await indexer().catchUp();
    const rows = await agents();
    expect(rows.map((r) => r.agent_id)).toEqual([1, 2]);
    for (const row of rows) {
      const read = (functionName: "ownerOf" | "speciesOf" | "tbaOf") =>
        client().readContract({
          address: nft,
          abi: AGENT_NFT_ABI,
          functionName,
          args: [BigInt(row.agent_id)],
        });
      expect(row.owner).toBe(String(await read("ownerOf")).toLowerCase());
      expect(row.species).toBe(Number(await read("speciesOf")));
      expect(row.species).toBeGreaterThan(0);
      expect(row.tba).toBe(String(await read("tbaOf")).toLowerCase());
    }
    const wm = await indexer().watermark();
    expect(wm.number).toBe(Number(await client().getBlockNumber()));
  });

  it("a new process continues from the watermark with no gap and no duplicate", async () => {
    const before = await eventCount();
    await mintLocal(nft);
    await indexer().catchUp(); // a fresh instance, as after a restart
    expect((await agents()).map((r) => r.agent_id)).toEqual([1, 2, 3]);
    expect(await eventCount()).toBe(before + 2); // Transfer and AgentMinted
    await indexer().catchUp();
    expect(await eventCount()).toBe(before + 2);
  });

  it("detects a real reorg and follows the new chain", async () => {
    const snapshot = String(await rpc(fork.url, "evm_snapshot", []));
    const first = await mintLocal(nft);
    await indexer().catchUp();
    expect((await agents()).at(-1)?.owner).toBe(first.minter.toLowerCase());

    // Back to before the mint, then a different wallet mints at the same height.
    await rpc(fork.url, "evm_revert", [snapshot]);
    const second = await mintLocal(nft);
    expect(second.agentId).toBe(first.agentId);
    const result = await indexer().step();
    expect(result.kind).toBe("reorg");
    await indexer().catchUp();
    const last = (await agents()).at(-1);
    expect([last?.agent_id, last?.owner]).toEqual([
      Number(second.agentId),
      second.minter.toLowerCase(),
    ]);
    const incidents = await t.db.selectFrom("indexer.incidents").selectAll().execute();
    expect(incidents.map((i) => i.kind)).toContain("reorg");
  });

  it("detects a rewind when the chain goes back below the watermark", async () => {
    const snapshot = String(await rpc(fork.url, "evm_snapshot", []));
    const extra = await mintLocal(nft);
    await rpc(fork.url, "anvil_mine", ["0x3"]);
    await indexer().catchUp();
    expect((await agents()).some((a) => a.agent_id === Number(extra.agentId))).toBe(true);
    await rpc(fork.url, "evm_revert", [snapshot]);
    expect((await indexer().step()).kind).toBe("rewind");
    expect((await agents()).some((a) => a.agent_id === Number(extra.agentId))).toBe(false);
  });
});
