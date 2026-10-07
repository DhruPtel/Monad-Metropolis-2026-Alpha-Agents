import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import {
  type TestFork,
  readForkConfig,
  rpc,
  startTestFork,
  testForkUpstream,
} from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import { Indexer, RpcLogSource } from "@alpha-agents/indexer";
import type { Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryGateway } from "./gateway-admin.ts";
import { KEEPER_POLICY, RevealKeeper } from "./keeper.ts";
import { ViemRevealChain } from "./keeper-chain.ts";
import { LeaseManager } from "./leases.ts";
import { Provisioner } from "./provisioner.ts";
import type { JobData } from "./queue.ts";
import { reconcileOnce } from "./reconciler.ts";
import { MemorySteerStore, RevealSteering } from "./reveal-steer.ts";
import { MemoryProvider } from "./sandbox.ts";
import { Redactor } from "./secrets.ts";
import { Store } from "./store.ts";

/**
 * P2-U1 step 0: a fork reset, as `pnpm dev:down` and a fresh fork do it. The
 * real indexer, reveal keeper and reconcile run against a fork of their own
 * (port 8574) and a database of their own. The fork is stopped and a fresh one
 * started on the same port while their state still describes the old one;
 * each must notice at once (no waiting for the new fork to reach the old
 * watermark), drop the old fork's agents, and then index, reveal and
 * provision a new mint. The playtest fork on 8545 is never touched. Skips
 * without MONAD_RPC_URL or Postgres.
 */
const PORT = 8574;
const CHAIN = 143143;
const SLOW = 300_000;
const upstream = testForkUpstream();
const dbUp = await databaseAvailable();

describe.skipIf(upstream === null || !dbUp)("recovery from a fork reset", { timeout: SLOW }, () => {
  let fork: TestFork;
  let t: TestDatabase;
  let deployLocal: (o: { quiet: boolean }) => Promise<string>;
  let mintLocal: (nft: Hex) => Promise<{ agentId: bigint }>;
  const previousPort = process.env.LOCAL_FORK_PORT;

  beforeAll(async () => {
    process.env.LOCAL_FORK_PORT = String(PORT);
    fork = await startTestFork({ port: PORT });
    t = await createTestDatabase("fork_reset");
    ({ deployLocal } = (await import("../../../scripts/lib/agent-nft.js")) as never);
    ({ mintLocal } = (await import("../../../scripts/lib/agent-mint.js")) as never);
  }, SLOW);

  afterAll(async () => {
    await fork?.stop();
    await t?.drop();
    if (previousPort === undefined) delete process.env.LOCAL_FORK_PORT;
    else process.env.LOCAL_FORK_PORT = previousPort;
  }, SLOW);

  it("drops the old fork's agents at once, then indexes, reveals and provisions a new mint", async () => {
    const pin = readForkConfig().blockNumber;
    const entropy = addressEntry("local", "pyth_entropy");
    if (entropy.status !== "verified") throw new Error("address book: pyth_entropy");
    const hd = mnemonicToAccount("test test test test test test test test test test test junk", {
      addressIndex: 3,
    }).getHdKey();
    const privateKey = `0x${Buffer.from(hd.privateKey ?? new Uint8Array()).toString("hex")}` as Hex;
    const redactor = new Redactor();
    redactor.add(privateKey);

    const nft = (await deployLocal({ quiet: true })) as Hex;
    const indexer = new Indexer({
      db: t.db,
      source: new RpcLogSource({ url: fork.url }),
      target: { chainId: CHAIN, agentNft: nft, usdc: null, startBlock: pin + 1 },
      log: () => undefined,
    });
    let now = 0;
    const keeper = new RevealKeeper({
      chain: new ViemRevealChain({
        rpcUrl: fork.url,
        chainId: CHAIN,
        agentNft: nft,
        entropy: entropy.address as Hex,
        privateKey,
        localFork: true,
        steering: new RevealSteering(14, new MemorySteerStore(), CHAIN),
      }),
      policy: KEEPER_POLICY.local,
      log: () => undefined,
      redactor,
      clock: () => now,
    });
    const reveal = async () => {
      expect((await keeper.tick()).kind).toBe("waiting");
      now += 12_000;
      expect((await keeper.tick()).kind).toBe("requested");
      expect((await keeper.tick()).kind).toBe("delivered");
      expect((await keeper.tick()).kind).toBe("revealed");
    };
    const store = new Store(t.db);
    const provisioner = new Provisioner({
      store,
      gateway: new MemoryGateway(),
      leases: new LeaseManager({
        store,
        provider: new MemoryProvider(),
        namespace: "reset",
        runTag: "r",
        redactor,
        log: () => undefined,
      }),
      namespace: "reset",
      secret: "test-orchestrator-secret-0123456789abcdef",
      redactor,
      log: () => undefined,
      startingBudgetUsd: 0.5,
    });
    // The orchestrator's loop: reconcile, then run each job the way its queue worker does.
    const reconcile = async () => {
      const jobs: JobData[] = [];
      await reconcileOnce(
        store,
        { add: async (j) => (jobs.push(j), { id: "x", added: true }) },
        CHAIN,
      );
      for (const j of jobs)
        if (j.kind === "provision") await provisioner.provision(j.ref);
        else if (j.kind === "deprovision") await provisioner.deprovision(j.ref, j.reason);
      return jobs.map((j) => `${j.kind} ${j.ref.agentId}`);
    };
    const agents = () => t.db.selectFrom("indexer.agents").selectAll().execute();

    // The old fork: agent #1 minted, revealed, indexed and provisioned; then the
    // fork runs on, so the watermark sits well above where a fresh fork starts.
    await mintLocal(nft);
    await reveal();
    await rpc(fork.url, "anvil_mine", ["0x20"]);
    await indexer.catchUp();
    const oldOwner = (await agents())[0]?.owner;
    expect((await agents()).map((a) => a.agent_id)).toEqual([1]);
    expect(await reconcile()).toEqual(["provision 1"]);
    expect((await store.runtime({ chainId: CHAIN, agentId: 1 }))?.status).toBe("ready");
    const oldWatermark = (await indexer.watermark()).number;

    // pnpm dev:down and a fresh fork: same port, same chain ID, back at the pin.
    await fork.stop();
    fork = await startTestFork({ port: PORT });

    // The keeper, with no AgentNFT on the new fork yet, reports and keeps going.
    expect((await keeper.tick()).kind).toBe("error");
    // The indexer sees the rewind on its first step: no waiting for the old watermark.
    const first = await indexer.step();
    expect(first).toMatchObject({ kind: "rewind", at: oldWatermark, rolledBackTo: pin });
    expect(await agents()).toEqual([]);
    // The orchestrator deprovisions the old fork's agent.
    expect(await reconcile()).toEqual(["deprovision 1"]);
    expect((await store.runtime({ chainId: CHAIN, agentId: 1 }))?.status).toBe("deprovisioned");

    // The new fork: deploy, mint and reveal as on any fresh fork.
    expect(await deployLocal({ quiet: true })).toBe(nft);
    expect((await keeper.tick()).kind).toBe("idle");
    await mintLocal(nft);
    await reveal();
    await indexer.catchUp();
    const [fresh] = await agents();
    expect(fresh).toMatchObject({ agent_id: 1, species: 14 });
    expect(fresh?.owner).not.toBe(oldOwner);
    expect(await reconcile()).toEqual(["provision 1"]);
    const runtime = await store.runtime({ chainId: CHAIN, agentId: 1 });
    expect(runtime).toMatchObject({ status: "ready", species: 14 });

    // A reset caught later, after the fresh fork has run past the old watermark,
    // is a reorg on the first step, and recovers the same way.
    await fork.stop();
    fork = await startTestFork({ port: PORT });
    await rpc(fork.url, "anvil_mine", ["0x40"]);
    expect((await indexer.step()).kind).toBe("reorg");
    expect(await agents()).toEqual([]);
    expect(await reconcile()).toEqual(["deprovision 1"]);
  });
});
