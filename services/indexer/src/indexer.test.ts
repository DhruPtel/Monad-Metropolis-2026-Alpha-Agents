import { createTestDatabase, databaseAvailable, type TestDatabase } from "@alpha-agents/db/testing";
import type { Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Indexer, type IndexerTarget } from "./indexer.ts";
import {
  MemoryLogSource,
  adminLog,
  mintLogs,
  revealLog,
  transferLogs,
  usdcLog,
} from "./memory-source.ts";

const available = await databaseAvailable();

const NFT = "0x60cacA6dE327331b321E140Ae19AcbCc4188Be6E" as Hex;
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Hex;
const ALICE = "0x1111111111111111111111111111111111111111" as Hex;
const BOB = "0x2222222222222222222222222222222222222222" as Hex;
const ESCROW = "0x3333333333333333333333333333333333333333" as Hex;
const FUNDER = "0x4444444444444444444444444444444444444444" as Hex;
const tba = (id: number) => `0x${"7ba".padEnd(37, "0")}${id.toString(16).padStart(3, "0")}` as Hex;
const START = 1_000;
const CHAIN = 143143;
const target: IndexerTarget = { chainId: CHAIN, agentNft: NFT, usdc: USDC, startBlock: START };

describe.skipIf(!available)("the indexer (needs pnpm dev:up for Postgres)", () => {
  let t: TestDatabase;
  let chain: MemoryLogSource;
  const indexer = (maxRange = 2_000) => new Indexer({ db: t.db, source: chain, target, maxRange });

  beforeAll(async () => {
    t = await createTestDatabase("indexer");
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(() => {
    chain = new MemoryLogSource(CHAIN, START);
  });
  afterEach(async () => {
    for (const table of [
      "indexer.watermarks",
      "indexer.indexed_blocks",
      "indexer.agent_nft_events",
      "indexer.agents",
      "indexer.usdc_transfers",
      "indexer.incidents",
    ] as const) {
      await t.db.deleteFrom(table).execute();
    }
  });

  const agents = () => t.db.selectFrom("indexer.agents").selectAll().orderBy("agent_id").execute();
  const count = async (table: "indexer.agent_nft_events" | "indexer.usdc_transfers") =>
    Number(
      (
        await t.db
          .selectFrom(table)
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .executeTakeFirstOrThrow()
      ).n,
    );
  const incidents = () => t.db.selectFrom("indexer.incidents").selectAll().orderBy("id").execute();

  it("catches up from the deploy block: agents, reveals, transfers and admin events", async () => {
    chain.mine(adminLog(NFT, true));
    chain.mine(...mintLogs(NFT, 1n, ALICE, tba(1)));
    chain.mine(usdcLog(USDC, FUNDER, tba(1), 5_000_000n));
    chain.mine(...mintLogs(NFT, 2n, BOB, tba(2)), revealLog(NFT, 1n, 3, 14));
    chain.mine(usdcLog(USDC, tba(1), tba(2), 1_000_000n));
    chain.mine(usdcLog(USDC, FUNDER, ALICE, 7n)); // no agent involved: not indexed
    const steps = await indexer().catchUp();
    expect(steps).toBe(2); // one range, then idle

    const rows = await agents();
    expect(rows.map((r) => [r.agent_id, r.owner, r.tba, r.species, r.tier, r.owner_epoch])).toEqual(
      [
        [1, ALICE.toLowerCase(), tba(1), 14, 3, 0],
        [2, BOB.toLowerCase(), tba(2), 0, 0, 0],
      ],
    );
    // 1 admin + 2 per mint x2 + 1 reveal, every one stored raw.
    expect(await count("indexer.agent_nft_events")).toBe(6);
    const transfers = await t.db
      .selectFrom("indexer.usdc_transfers")
      .select(["agent_id", "direction", "value"])
      .orderBy("block_number")
      .orderBy("direction")
      .execute();
    expect(transfers).toEqual([
      { agent_id: 1, direction: "in", value: "5000000" },
      { agent_id: 2, direction: "in", value: "1000000" },
      { agent_id: 1, direction: "out", value: "1000000" },
    ]);
    const wm = await indexer().watermark();
    expect(wm.number).toBe(START + 5);
    expect(wm.hash).toBe((await chain.block(START + 5))?.hash.toLowerCase());
  });

  it("stores the block number and hash with every record", async () => {
    const at = chain.mine(...mintLogs(NFT, 1n, ALICE, tba(1)));
    await indexer().catchUp();
    const hash = (await chain.block(at))?.hash.toLowerCase();
    const events = await t.db.selectFrom("indexer.agent_nft_events").selectAll().execute();
    expect(events.every((e) => e.block_number === at && e.block_hash === hash)).toBe(true);
    const [agent] = await agents();
    expect([agent?.block_number, agent?.block_hash]).toEqual([at, hash]);
  });

  it("restarts from the watermark with no gap and no duplicate", async () => {
    for (let i = 1; i <= 5; i++) chain.mine(...mintLogs(NFT, BigInt(i), ALICE, tba(i)));
    // Small ranges, so the first instance stops part way.
    const first = indexer(2);
    await first.step();
    await first.step();
    expect((await first.watermark()).number).toBe(START + 3);
    expect(await count("indexer.agent_nft_events")).toBe(8);

    // A new process picks up where the last one committed, and a range indexed
    // twice (a crash after the fetch, before the commit) changes nothing.
    for (let i = 6; i <= 7; i++) chain.mine(...mintLogs(NFT, BigInt(i), BOB, tba(i)));
    await indexer(2).catchUp();
    expect((await agents()).map((a) => a.agent_id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(await count("indexer.agent_nft_events")).toBe(14);
    const replay = await chain.block(START + 1);
    if (!replay) throw new Error("no block to replay from");
    await t.db
      .updateTable("indexer.watermarks")
      .set({ block_number: replay.number, block_hash: replay.hash.toLowerCase() })
      .execute();
    await indexer().catchUp();
    expect(await count("indexer.agent_nft_events")).toBe(14);
    expect((await agents()).length).toBe(7);
  });

  it("detects a reorg, rolls back to the common ancestor and indexes the new branch", async () => {
    chain.mine(...mintLogs(NFT, 1n, ALICE, tba(1)));
    const fork = chain.mine(...mintLogs(NFT, 2n, ALICE, tba(2)), revealLog(NFT, 1n, 1, 3));
    chain.mine(usdcLog(USDC, FUNDER, tba(2), 10n));
    await indexer().catchUp();
    const oldHash = (await indexer().watermark()).hash;

    // The block holding agent 2's mint and agent 1's reveal is replaced: on the
    // new branch Bob mints agent 2 and agent 1 is revealed as another species.
    chain.reorgFrom(fork, "b");
    chain.mine(...mintLogs(NFT, 2n, BOB, tba(2)), revealLog(NFT, 1n, 2, 9));
    chain.mine();
    const result = await indexer().step();
    expect(result).toEqual({ kind: "reorg", at: fork + 1, rolledBackTo: fork - 1 });
    // Rolled back: only agent 1, unrevealed, and nothing above the ancestor.
    expect((await agents()).map((a) => [a.agent_id, a.species])).toEqual([[1, 0]]);
    expect(await count("indexer.usdc_transfers")).toBe(0);

    await indexer().catchUp();
    expect((await agents()).map((a) => [a.agent_id, a.owner, a.species, a.tier])).toEqual([
      [1, ALICE.toLowerCase(), 9, 2],
      [2, BOB.toLowerCase(), 0, 0],
    ]);
    const [incident] = await incidents();
    expect(incident).toMatchObject({
      kind: "reorg",
      block_number: fork + 1,
      stored_hash: oldHash,
      rolled_back_to: fork - 1,
    });
    expect(incident?.chain_hash).not.toBe(oldHash);
  });

  it("a reorg below every stored block re-indexes from the deploy block", async () => {
    chain.mine(...mintLogs(NFT, 1n, ALICE, tba(1)));
    await indexer().catchUp();
    chain.reorgFrom(START, "c");
    chain.mine(...mintLogs(NFT, 1n, BOB, tba(1)));
    expect(await indexer().step()).toMatchObject({ kind: "reorg", rolledBackTo: START - 1 });
    await indexer().catchUp();
    expect((await agents()).map((a) => a.owner)).toEqual([BOB.toLowerCase()]);
  });

  it("detects a rewind (the head below the watermark) and rolls back", async () => {
    chain.mine(...mintLogs(NFT, 1n, ALICE, tba(1)));
    chain.mine(...mintLogs(NFT, 2n, ALICE, tba(2)));
    await indexer().catchUp();
    chain.rewindTo(START);
    expect(await indexer().step()).toEqual({ kind: "rewind", at: START + 1, rolledBackTo: START });
    expect((await agents()).map((a) => a.agent_id)).toEqual([1]);
    expect((await incidents())[0]?.kind).toBe("rewind");
  });

  it("follows a transfer: the new owner and the bumped ownership epoch", async () => {
    chain.mine(...mintLogs(NFT, 1n, ALICE, tba(1)));
    chain.mine(...transferLogs(NFT, 1n, ALICE, ESCROW, 1n));
    chain.mine(...transferLogs(NFT, 1n, ESCROW, BOB, 2n));
    await indexer().catchUp();
    const [agent] = await agents();
    expect([agent?.owner, agent?.owner_epoch]).toEqual([BOB.toLowerCase(), 2]);
  });

  it("halves its range when the source refuses one as too large", async () => {
    for (let i = 1; i <= 9; i++) chain.mine(...mintLogs(NFT, BigInt(i), ALICE, tba(i)));
    chain.maxLogRange = 3;
    await indexer(100).catchUp();
    expect((await agents()).length).toBe(9);
  });

  it("is idle at the head and asks for nothing but the head and the watermark block", async () => {
    chain.mine(...mintLogs(NFT, 1n, ALICE, tba(1)));
    await indexer().catchUp();
    const before = { ...chain.calls };
    expect(await indexer().step()).toMatchObject({ kind: "idle" });
    expect(chain.calls.logs - before.logs).toBe(0);
    expect(chain.calls.block - before.block).toBe(1);
  });
});
