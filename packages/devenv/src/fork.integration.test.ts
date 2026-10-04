import { LOCAL_FORK_RPC_URL } from "@alpha-agents/config";
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
  stackHealth,
  takeSnapshot,
} from "./index.ts";

/**
 * Integration tests against the running local fork (`pnpm dev:up`). They skip
 * cleanly when no anvil fork answers at 127.0.0.1:8545, as in CI. The suite
 * snapshots first and reverts at the end, so it leaves the fork as it found it.
 */
const fork = await anvilState();
const pinned = readForkConfig().blockNumber;
const TEST_ADDRESS = "0x00000000000000000000000000000000000beef1";
// These calls go through anvil to the upstream RPC and through Docker for health,
// so under load they take far longer than vitest's 5-second default (L-28).
const SLOW_IO_MS = 60_000;

describe.skipIf(fork === undefined)(
  "fork controls on the local anvil fork",
  { timeout: SLOW_IO_MS },
  () => {
    let outer = "";
    beforeAll(async () => {
      outer = await takeSnapshot();
    }, SLOW_IO_MS);
    afterAll(async () => {
      await revertToSnapshot(outer);
    }, SLOW_IO_MS);

    it("reports the stack's anvil as the monad fork", async () => {
      const health = await stackHealth();
      const anvil = health.services.find((s) => s.name === "anvil");
      expect(anvil?.up).toBe(true);
      expect(health.anvil).toMatchObject({ chainId: 143, network: "monad" });
    });

    it("mines blocks", async () => {
      const before = await forkClock();
      const after = await mineBlocks(5);
      expect(after.blockNumber).toBe(before.blockNumber + 5);
    });

    it("advances time by a day", async () => {
      const before = await forkClock();
      const after = await advanceTime(86_400);
      expect(after.timestamp - before.timestamp).toBeGreaterThanOrEqual(86_400);
      expect(after.blockNumber).toBe(before.blockNumber + 1);
    });

    it("reverts to a snapshot, restoring block and time", async () => {
      const before = await forkClock();
      const id = await takeSnapshot();
      await advanceTime(86_400);
      await mineBlocks(3);
      expect(await revertToSnapshot(id)).toBe(true);
      expect(await forkClock()).toEqual(before);
    });

    it("sets a MON balance and reads it back", async () => {
      await setMonBalance(TEST_ADDRESS, 12n * 10n ** 18n);
      expect((await balancesOf(TEST_ADDRESS)).monWei).toBe(12n * 10n ** 18n);
    });

    it("mints test USDC through the real contract and reads it back", async () => {
      const start = (await balancesOf(TEST_ADDRESS)).usdcE6;
      await mintTestUsdc(TEST_ADDRESS, 2_500_000_000n);
      await mintTestUsdc(TEST_ADDRESS, 1_000_000n);
      expect((await balancesOf(TEST_ADDRESS)).usdcE6).toBe(start + 2_501_000_000n);
    });

    it("resets to the pinned block", async () => {
      await mineBlocks(4);
      const clock = await resetToBlock(pinned);
      expect(clock.blockNumber).toBe(pinned);
      expect((await balancesOf(TEST_ADDRESS)).usdcE6).toBe(0n);
      // A reset clears snapshots, so take a fresh one for afterAll to revert to.
      outer = await takeSnapshot();
    });

    it("uses the fixed local RPC", () => {
      expect(LOCAL_FORK_RPC_URL).toBe("http://127.0.0.1:8545");
    });
  },
);
