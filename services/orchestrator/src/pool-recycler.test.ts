import type { Hex, PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import {
  BUY_SIDE_TARGET_WEI,
  MIN_BUY_SIDE_WEI,
  type PoolState,
  type RecycleChain,
  type StandIn,
  liquidityForMon,
  monAbove,
  monToLower,
  parSale,
  planRecycle,
  recyclePass,
  retryingReader,
  tickOfPrice,
} from "./pool-recycler.ts";

const MON = 10n ** 18n;
const sq = (t: number) => Math.sqrt(1.0001 ** t);
const at = (tick: number, liquidity: bigint, nets: [number, bigint][] = []): PoolState => ({
  sqrtPriceX96: BigInt(Math.floor(sq(tick) * 2 ** 96)),
  tick,
  liquidity,
  spacing: 10,
  nets: new Map(nets),
});
const near = (a: bigint, b: number) => expect(Math.abs(Number(a) - b) / b).toBeLessThan(1e-6);
const ORACLE = tickOfPrice(1.0);

describe("pool recycler math", () => {
  it("puts a 1.00 USDC MON at tick -276325, which the 10-tick spacing lands at -276330", () => {
    expect(ORACLE).toBe(-276325);
  });

  it("prices a sale down to a tick and the MON above the price, across a position's edge", () => {
    const L = 8n * 10n ** 14n;
    const s = at(-276300, L, [
      [-276400, L],
      [-276200, -L],
    ]);
    near(monToLower(s, -276330), (Number(L) * (1 / sq(-276330) - 1 / sq(-276300))) / 0.9995);
    // Above -276200 the pool holds nothing, so the buy side ends there.
    near(monAbove(s, -276150), Number(L) * (1 / sq(-276300) - 1 / sq(-276200)));
    expect(monToLower(s, -276290)).toBe(0n);
    expect(monAbove(s, -276310)).toBe(0n);
  });

  it("adds the liquidity that holds a given MON above the price", () => {
    const L = liquidityForMon(6n * MON, -276320, -276170);
    const s = at(-276330, L, [
      [-276320, L],
      [-276170, -L],
    ]);
    near(monAbove({ ...s, liquidity: 0n }, -276170), 6e18);
  });
});

describe("planRecycle", () => {
  it("leaves a centred pool with a deep buy side alone", () => {
    const L = 2n * 10n ** 15n;
    const plan = planRecycle(at(-276330, L, [[-276100, -L]]), ORACLE);
    expect(plan.act).toBe(false);
  });

  it("re-centres a pool above the oracle and tops its buy side up to the target", () => {
    const L = 8n * 10n ** 14n;
    const s = at(-276250, L, [
      [-276400, L],
      [-276200, -L],
    ]);
    const plan = planRecycle(s, ORACLE);
    if (!plan.act) throw new Error("expected a run");
    expect(plan.targetTick).toBe(-276330);
    expect(plan.sellWei).toBe(monToLower(s, -276330));
    const buySide = monAbove(s, -276250 + 150);
    expect(buySide).toBeLessThan(MIN_BUY_SIDE_WEI);
    expect(plan.addWei).toBe(BUY_SIDE_TARGET_WEI - buySide - plan.sellWei);
    expect(plan.why).toContain("above the oracle");
  });
});

/** A stand-in pool that fills sales at par less the fee up to `room` MON, then not at all. */
function fakeChain(o: { pool: PoolState; deployer?: bigint; room?: bigint }) {
  const calls: string[] = [];
  let n = 0;
  const hash = () => `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
  const room = new Map<string, bigint>();
  const chain: RecycleChain = {
    pool: async () => o.pool,
    oracleTick: async () => ORACLE,
    deployerMon: async () => o.deployer ?? 5n * MON,
    tokenBalance: async () => 900_000n * MON,
    quoteSale: async (s, amount) =>
      amount <= (room.get(s.symbol) ?? o.room ?? 2n * MON) ? (amount * 9995n) / 10_000n : null,
    sell: async (s, amount, minOut) => {
      calls.push(`sell ${s.symbol} ${amount} min ${minOut}`);
      room.set(s.symbol, (room.get(s.symbol) ?? o.room ?? 2n * MON) - amount);
      return { hash: hash(), out: (amount * 9995n) / 10_000n };
    },
    sellMon: async (amount, minUsdc) => {
      calls.push(`sellMon ${amount} min ${minUsdc}`);
      return hash();
    },
    unwrap: async (amount) => {
      calls.push(`unwrap ${amount}`);
      return hash();
    },
    addAbove: async (lo, hi, mon) => {
      calls.push(`add ${lo} ${hi} ${mon}`);
      return hash();
    },
  };
  return { chain, calls };
}

const STAND_INS: StandIn[] = [
  { symbol: "TALPHA", address: "0x00000000000000000000000000000000000000a1", poolId: "0x01" },
  { symbol: "TBETA", address: "0x00000000000000000000000000000000000000b1", poolId: "0x02" },
];

describe("recyclePass", () => {
  const L = 8n * 10n ** 14n;
  const high = at(-276250, L, [
    [-276400, L],
    [-276200, -L],
  ]);

  it("recovers MON from the stand-in pools at par, sells it down to the oracle and adds the rest above", async () => {
    const { chain, calls } = fakeChain({ pool: high, room: 10n * MON });
    const run = await recyclePass({
      chain,
      standIns: STAND_INS,
      oraclePrice: async () => 1,
      log: () => undefined,
    });
    if (!run.plan.act) throw new Error("expected a run");
    const need = run.plan.sellWei + run.plan.addWei;
    expect(run.recoveredWei).toBeGreaterThanOrEqual(need);
    expect(calls[0]).toMatch(/^sell TALPHA /);
    expect(calls).toContain(
      `sellMon ${run.plan.sellWei} min ${Math.floor((Number(run.plan.sellWei) / 1e12) * 0.99)}`,
    );
    const left = run.recoveredWei - run.plan.sellWei;
    expect(calls).toContain(`unwrap ${left}`);
    expect(calls.at(-1)).toBe(`add -276240 -276090 ${left}`);
  });

  it("takes from the next stand-in when the first fills too little at par", async () => {
    const { chain, calls } = fakeChain({ pool: high, room: 2n * MON });
    const run = await recyclePass({
      chain,
      standIns: STAND_INS,
      oraclePrice: async () => 1,
      log: () => undefined,
    });
    expect(calls.filter((c) => c.startsWith("sell T"))).toHaveLength(2);
    expect(run.recoveredWei).toBeGreaterThan(3n * MON);
  });

  it("sends nothing into MON/USDC when the stand-in pools hold too little MON, and nothing at all when the deployer cannot pay gas", async () => {
    const dry = fakeChain({ pool: high, room: MON / 100n });
    const run = await recyclePass({
      chain: dry.chain,
      standIns: STAND_INS,
      oraclePrice: async () => 1,
      log: () => undefined,
    });
    expect(run.stopped).toMatch(/too little MON above par/);
    expect(dry.calls.some((c) => c.startsWith("sellMon") || c.startsWith("add"))).toBe(false);
    const broke = fakeChain({ pool: high, deployer: MON / 10n });
    const none = await recyclePass({
      chain: broke.chain,
      standIns: STAND_INS,
      oraclePrice: async () => 1,
      log: () => undefined,
    });
    expect(none.stopped).toMatch(/deployer holds too little MON/);
    expect(broke.calls).toEqual([]);
  });

  it("parSale: the largest sale the pool fills within 0.5% of par", async () => {
    const { chain } = fakeChain({ pool: high, room: 3n * MON });
    const sale = await parSale(chain, STAND_INS[0] as StandIn, 10n * MON);
    expect(sale).toBeLessThanOrEqual(3n * MON);
    expect(sale).toBeGreaterThan((3n * MON * 99n) / 100n);
  });
});

describe("retryingReader", () => {
  it("tries a read again after a provider error, but takes a revert as the answer", async () => {
    let calls = 0;
    const flaky = {
      readContract: async () => {
        calls += 1;
        if (calls < 3) throw new Error("HTTP request failed. Status: 429");
        return 7n;
      },
      simulateContract: async () => {
        throw new Error("The contract function reverted");
      },
      getBalance: async () => 1n,
      request: async () => "0x1",
    } as unknown as PublicClient;
    const r = retryingReader(flaky, { delayMs: 1 });
    expect(await r.readContract({} as never)).toBe(7n);
    expect(calls).toBe(3);
    await expect(r.simulateContract({} as never)).rejects.toThrow("reverted");
  });
});
