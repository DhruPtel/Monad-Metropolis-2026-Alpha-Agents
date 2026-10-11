import type { ChainReaderV3, MarketStateV3 } from "@alpha-agents/chain-tools";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  type PoolSeed,
  Registrar,
  SCREENED_POSITION_BPS,
  type ScreenerChain,
  localScreenerKey,
  poolSeedOf,
  screenHashOf,
} from "./registrar.ts";
import type { PoolRow, ScreenRecord, TokenStore } from "./store.ts";
import { privateKeyToAccount } from "viem/accounts";

/**
 * The screened-lane registrar (F-U12): a passing screen of an unregistered
 * token registers it with its routable pools against listed tokens; a
 * registered token has the screen recorded; a refused re-screen moves a
 * buyable screened token to sell-only and leaves a core token to the
 * guardian; the chain's lanes are mirrored into the token table; and the
 * screener key is anvil account 3.
 */
const MEME = "0x00000000000000000000000000000000000000ab" as Hex;
const WMON = "0x3bd359c1e6a1b7b4c8d1f5a9c4e2b7d6f8a1c3e5" as Hex;
const USDC = "0x754704bc059f8a3fb1a5ae8d4a2fcb3be0ee1b8e" as Hex;
const OTHER = "0x00000000000000000000000000000000000000cd" as Hex;

const screen = (verdict: "passed" | "refused"): ScreenRecord => ({
  screenId: "screen-1",
  chainId: 143,
  address: MEME,
  verdict,
  checks: [],
  route: null,
  forkBlock: 1,
  requestedBy: "test",
  durationMs: 1,
  createdAt: "2026-10-11T12:00:00.000Z",
  expiresAt: "2026-10-11T18:00:00.000Z",
});

const pool = (over: Partial<PoolRow> = {}): PoolRow => ({
  poolId: "0x00000000000000000000000000000000000000b1",
  dex: "uniswap_v3",
  token0: MEME,
  token1: USDC,
  fee: 3000,
  tickSpacing: 60,
  hooks: null,
  routable: true,
  routeNote: "",
  liquidityUsd: 100_000,
  volume24hUsd: 0,
  createdAt: null,
  firstSeenAt: "2026-10-11T00:00:00.000Z",
  ...over,
});

function fakes(record: { lane: number; status: number }) {
  const calls: string[] = [];
  const mirrored: string[] = [];
  const registered = new Set<string>();
  const chain: ScreenerChain = {
    address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    addScreened: async (token, cap, hash, at) => {
      calls.push(`addScreened ${token} ${cap} ${hash.slice(0, 10)} ${at}`);
      return "0xa1";
    },
    recordScreen: async (token, hash) => {
      calls.push(`recordScreen ${token} ${hash.slice(0, 10)}`);
      return "0xa2";
    },
    setSellOnly: async (token) => {
      calls.push(`setSellOnly ${token}`);
      return "0xa3";
    },
    addScreenedPool: async (seed) => {
      calls.push(`addScreenedPool ${seed.venue} ${seed.token0}/${seed.token1} ${seed.fee}`);
      registered.add(`${seed.token0}/${seed.token1}/${seed.fee}`);
      return "0xa4";
    },
    poolRegistered: async (seed) => registered.has(`${seed.token0}/${seed.token1}/${seed.fee}`),
    tokenRecord: async () => record,
  };
  const market = {
    usdc: USDC,
    wmon: WMON,
    tokens: [
      { token: USDC, lane: "CORE", status: "BUYABLE", priceClass: "F" },
      { token: WMON, lane: "CORE", status: "BUYABLE", priceClass: "F" },
      { token: MEME, lane: "SCREENED", status: "SELL_ONLY", priceClass: "A" },
    ],
  } as unknown as MarketStateV3;
  const reader = { market: async () => market } as unknown as ChainReaderV3;
  const store = {
    setRegistry: async (
      _chainId: number,
      address: string,
      lane: string | null,
      status: string | null,
    ) => {
      mirrored.push(`${address} ${lane} ${status}`);
    },
  } as unknown as TokenStore;
  const registrar = new Registrar({ chainId: 143, store, chain, reader, log: () => undefined });
  return { registrar, calls, mirrored };
}

describe("the screened-lane registrar", () => {
  it("registers a passing unregistered token with its routable pools against listed tokens, then mirrors the lanes", async () => {
    const { registrar, calls, mirrored } = fakes({ lane: 0, status: 0 });
    const actions = await registrar.afterScreen(MEME, screen("passed"), [
      pool(),
      pool({
        poolId: "0x00000000000000000000000000000000000000b2",
        dex: "uniswap_v4",
        token0: WMON,
        token1: MEME,
        fee: 500,
        tickSpacing: 10,
      }),
      pool({ poolId: "0x00000000000000000000000000000000000000b3", token1: OTHER }),
      pool({ poolId: "0x00000000000000000000000000000000000000b4", routable: false }),
    ]);
    expect(actions.map((a) => a.action)).toEqual(["ADD_SCREENED", "ADD_POOL", "ADD_POOL"]);
    expect(calls[0]).toBe(
      `addScreened ${MEME} ${SCREENED_POSITION_BPS} ${screenHashOf(screen("passed")).slice(0, 10)} ${BigInt(Date.parse("2026-10-11T12:00:00.000Z") / 1000)}`,
    );
    expect(calls.slice(1)).toEqual([
      `addScreenedPool 1 ${MEME}/${USDC} 3000`,
      `addScreenedPool 3 ${MEME}/${WMON} 500`,
    ]);
    expect(mirrored).toEqual([
      `${USDC} core listed`,
      `${WMON} core listed`,
      `${MEME} screened sell_only`,
    ]);
  });

  it("records a passing screen of a registered token, and notes one with no pool against a listed token", async () => {
    const { registrar, calls } = fakes({ lane: 2, status: 1 });
    const actions = await registrar.afterScreen(MEME, screen("passed"), [pool()]);
    expect(actions.map((a) => a.action)).toEqual(["RECORD_SCREEN"]);
    expect(calls).toEqual([`recordScreen ${MEME} ${screenHashOf(screen("passed")).slice(0, 10)}`]);
    const none = fakes({ lane: 0, status: 0 });
    const noted = await none.registrar.afterScreen(MEME, screen("passed"), [
      pool({ token1: OTHER }),
    ]);
    expect(noted.map((a) => a.action)).toEqual(["NOTE"]);
    expect(none.calls).toEqual([]);
  });

  it("moves a buyable screened token to sell-only on a refused re-screen, and leaves a core token to the guardian", async () => {
    const { registrar, calls } = fakes({ lane: 2, status: 1 });
    expect((await registrar.afterScreen(MEME, screen("refused"), [])).map((a) => a.action)).toEqual(
      ["SELL_ONLY"],
    );
    expect(calls).toEqual([`setSellOnly ${MEME}`]);
    const core = fakes({ lane: 1, status: 1 });
    expect(
      (await core.registrar.afterScreen(MEME, screen("refused"), [])).map((a) => a.action),
    ).toEqual(["NOTE"]);
    expect(core.calls).toEqual([]);
    // Already sell-only: nothing to tighten.
    const already = fakes({ lane: 2, status: 2 });
    expect(await already.registrar.afterScreen(MEME, screen("refused"), [])).toEqual([]);
  });

  it("builds a pool seed with sorted tokens, a zero pool for v4, and refuses a hooked pool; the screener key is anvil account 3", () => {
    const v3 = poolSeedOf(pool({ token0: USDC, token1: MEME })) as PoolSeed;
    expect(v3).toEqual({
      venue: 1,
      token0: MEME,
      token1: USDC,
      fee: 3000,
      tickSpacing: 60,
      pool: pool().poolId,
    });
    const v4 = poolSeedOf(pool({ dex: "uniswap_v4", fee: 500, tickSpacing: 10 })) as PoolSeed;
    expect(v4.pool).toBe("0x0000000000000000000000000000000000000000");
    expect(v4.venue).toBe(3);
    expect(
      poolSeedOf(pool({ dex: "uniswap_v4", hooks: "0x00000000000000000000000000000000000000ff" })),
    ).toBeNull();
    expect(poolSeedOf(pool({ fee: null }))).toBeNull();
    expect(privateKeyToAccount(localScreenerKey()).address).toBe(
      "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    );
  });
});
