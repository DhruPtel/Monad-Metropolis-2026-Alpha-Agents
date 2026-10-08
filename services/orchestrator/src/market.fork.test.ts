import { LOCAL_FORK_CHAIN_ID } from "@alpha-agents/config";
import { type TestFork, startTestFork, testForkUpstream } from "@alpha-agents/devenv";
import { DEPTH_SIZES_USD, viemMainnetReader } from "@alpha-agents/market";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * P3-U2: the mainnet market reader against a fork of Monad mainnet of its
 * own (never the playtest fork on 8545), at the pinned block: Chainlink's
 * MON/USD against the v4 pool, and the pool's depth at the reference sizes
 * through the real StateView and Quoter.
 */
const PORT = 8562;
const upstream = testForkUpstream();

describe.skipIf(!upstream)(
  "mainnet market reads on a fork (needs MONAD_RPC_URL)",
  { timeout: 180_000 },
  () => {
    let fork: TestFork;

    beforeAll(async () => {
      fork = await startTestFork({ port: PORT });
    }, 180_000);
    afterAll(async () => {
      await fork?.stop();
    }, 60_000);

    it("prices the pool against Chainlink, both plausible and close", async () => {
      const reader = viemMainnetReader([fork.url], LOCAL_FORK_CHAIN_ID);
      const now = Math.floor(Date.now() / 1000);
      const r = await reader.oracleVsPool({ now });
      expect(r.chainlinkMonUsd).toMatchObject({ source: "chainlink" });
      expect(r.poolMonUsdc).toMatchObject({ source: "uniswap_v4" });
      const cl = r.chainlinkMonUsd.value as number;
      const pool = r.poolMonUsdc.value as number;
      expect(cl).toBeGreaterThan(0.001);
      expect(pool).toBeGreaterThan(0.001);
      // The launch venue tracked Chainlink within a few bps in P2-U0; 3% is the snapshot's tolerance.
      expect(Math.abs(r.deviationBps.value as number)).toBeLessThan(300);
    });

    it("measures price impact at every reference size, each way, growing with size and never under the fee", async () => {
      const reader = viemMainnetReader([fork.url], LOCAL_FORK_CHAIN_ID);
      const d = await reader.poolDepth({ now: Math.floor(Date.now() / 1000) });
      expect(d.feeBps).toBe(5);
      expect(d.activeLiquidity.value).toBeGreaterThan(0);
      expect(d.rows).toHaveLength(DEPTH_SIZES_USD.length * 2);
      for (const side of ["buy_mon", "sell_mon"] as const) {
        const impacts = d.rows
          .filter((r) => r.side === side)
          .map((r) => r.impactBps.value as number);
        expect(impacts).toHaveLength(DEPTH_SIZES_USD.length);
        for (const i of impacts) expect(i).toBeGreaterThanOrEqual(4.9);
        for (let k = 1; k < impacts.length; k++)
          expect(impacts[k]).toBeGreaterThanOrEqual((impacts[k - 1] as number) - 0.01);
      }
    });

    it("refuses an RPC that serves another chain", async () => {
      const reader = viemMainnetReader([fork.url]);
      await expect(reader.poolDepth({ now: 0 })).rejects.toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
        retryable: false,
      });
    });
  },
);
