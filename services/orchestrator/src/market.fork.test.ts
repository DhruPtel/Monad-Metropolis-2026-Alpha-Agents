import { LOCAL_FORK_CHAIN_ID } from "@alpha-agents/config";
import { type TestFork, startTestFork, testForkUpstream } from "@alpha-agents/devenv";
import { addressEntry } from "@alpha-agents/domain";
import { DEPTH_SIZES_USD, viemMainnetLookup, viemMainnetReader } from "@alpha-agents/market";
import { keccak256, toHex } from "viem";
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

    it("reads a token's symbol as length and hash only, and its supply and decimals as numbers (P3-U9)", async () => {
      const lookup = viemMainnetLookup([fork.url], LOCAL_FORK_CHAIN_ID);
      const usdc = addressEntry("beta", "usdc").address as `0x${string}`;
      const symbol = await lookup.read("erc20_symbol", usdc, {});
      expect(symbol.outputs.value).toEqual({
        type: "string",
        length: 4,
        keccak256: keccak256(toHex("USDC")),
      });
      expect(JSON.stringify(symbol)).not.toContain('"USDC"');
      expect((await lookup.read("erc20_decimals", usdc, {})).outputs.value).toEqual({
        type: "uint",
        value: "6",
      });
      const supply = await lookup.read("erc20_total_supply", usdc, {});
      expect(BigInt((supply.outputs.value as { value: string }).value)).toBeGreaterThan(0n);
      expect(Number(symbol.asOf.block)).toBeGreaterThan(0);
    });

    it("reads Chainlink's round, balances and code, and says when an address has no code (P3-U9)", async () => {
      const lookup = viemMainnetLookup([fork.url], LOCAL_FORK_CHAIN_ID);
      const feed = addressEntry("beta", "chainlink_mon_usd").address as `0x${string}`;
      const round = await lookup.read("chainlink_latest_round", feed, {});
      expect(round.outputs).toMatchObject({
        answer: { type: "int" },
        decimals: { type: "uint", value: "8" },
      });
      const wmon = addressEntry("beta", "wmon").address as `0x${string}`;
      const native = await lookup.balance(wmon, "NATIVE");
      expect(BigInt(native.amountRaw)).toBeGreaterThan(0n);
      expect(native.decimals).toBe(18);
      const code = await lookup.code(wmon);
      expect(code).toMatchObject({
        hasCode: true,
        codeHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      });
      const empty = await lookup.code("0x000000000000000000000000000000000000dEaD");
      expect(empty).toMatchObject({ hasCode: false, sizeBytes: 0, codeHash: null });
      expect(empty.note).toMatch(/No code/);
      await expect(lookup.read("owner", wmon, {})).rejects.toMatchObject({ retryable: false });
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
