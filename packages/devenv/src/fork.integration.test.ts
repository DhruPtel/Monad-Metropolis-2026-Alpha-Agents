import {
  LOCAL_FORK_CHAIN_ID,
  LOCAL_FORK_RPC_URL,
  LOCAL_TEST_FORK_PORT,
} from "@alpha-agents/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  advanceTime,
  anvilState,
  balancesOf,
  forkClock,
  mineBlocks,
  mintTestUsdc,
  readForkConfig,
  resetToBlock,
  revertToSnapshot,
  setMonBalance,
  startTestFork,
  type TestFork,
  takeSnapshot,
  testForkUpstream,
} from "./index.ts";

/**
 * Integration tests of the fork controls, on a fork of their own on port 8546
 * (D-200), never the playtest fork on 8545: the reset test would otherwise
 * wipe a playtest, and a restored state dump has no history (L-63). They
 * skip cleanly when MONAD_RPC_URL is not set, as in CI.
 */
const upstream = testForkUpstream();
const pinned = readForkConfig().blockNumber;
const TEST_ADDRESS = "0x00000000000000000000000000000000000beef1";
// These calls go through anvil to the upstream RPC, so under load they take
// far longer than vitest's 5-second default (L-28).
const SLOW_IO_MS = 120_000;

describe.skipIf(upstream === null)("fork controls on a test fork", { timeout: SLOW_IO_MS }, () => {
  let fork: TestFork;
  let playtestBefore: Awaited<ReturnType<typeof forkClock>> | null = null;
  beforeAll(async () => {
    playtestBefore = await forkClock(LOCAL_FORK_RPC_URL).catch(() => null);
    fork = await startTestFork();
  }, SLOW_IO_MS);
  afterAll(async () => {
    await fork?.stop();
  }, SLOW_IO_MS);

  it("runs on its own port as the monad fork", async () => {
    expect(fork.url).toBe(`http://127.0.0.1:${LOCAL_TEST_FORK_PORT}`);
    expect(await anvilState(fork.url)).toMatchObject({
      chainId: LOCAL_FORK_CHAIN_ID,
      network: "monad",
    });
  });

  it("mines blocks", async () => {
    const before = await forkClock(fork.url);
    const after = await mineBlocks(5, fork.url);
    expect(after.blockNumber).toBe(before.blockNumber + 5);
  });

  it("advances time by a day", async () => {
    const before = await forkClock(fork.url);
    const after = await advanceTime(86_400, fork.url);
    expect(after.timestamp - before.timestamp).toBeGreaterThanOrEqual(86_400);
    expect(after.blockNumber).toBe(before.blockNumber + 1);
  });

  it("reverts to a snapshot, restoring block and time", async () => {
    const before = await forkClock(fork.url);
    const id = await takeSnapshot(fork.url);
    await advanceTime(86_400, fork.url);
    await mineBlocks(3, fork.url);
    expect(await revertToSnapshot(id, fork.url)).toBe(true);
    expect(await forkClock(fork.url)).toEqual(before);
  });

  it("sets a MON balance and reads it back", async () => {
    await setMonBalance(TEST_ADDRESS, 12n * 10n ** 18n, fork.url);
    expect((await balancesOf(TEST_ADDRESS, fork.url)).monWei).toBe(12n * 10n ** 18n);
  });

  it("mints test USDC through the real contract and reads it back", async () => {
    const start = (await balancesOf(TEST_ADDRESS, fork.url)).usdcE6;
    await mintTestUsdc(TEST_ADDRESS, 2_500_000_000n, fork.url);
    await mintTestUsdc(TEST_ADDRESS, 1_000_000n, fork.url);
    expect((await balancesOf(TEST_ADDRESS, fork.url)).usdcE6).toBe(start + 2_501_000_000n);
  });

  it("resets to the pinned block", async () => {
    await mineBlocks(4, fork.url);
    const clock = await resetToBlock(pinned, fork.url);
    expect(clock.blockNumber).toBe(pinned);
    expect((await balancesOf(TEST_ADDRESS, fork.url)).usdcE6).toBe(0n);
  });

  it("never touched the playtest fork", async () => {
    const now = await forkClock(LOCAL_FORK_RPC_URL).catch(() => null);
    expect(now).toEqual(playtestBefore);
  });
});
