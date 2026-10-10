import { SCREEN_CHECK_CODES, type ScreenCheck, bridgedException } from "@alpha-agents/domain";
import type { GoPlusReport } from "@alpha-agents/market";
import { toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { goplusCheck, lookAlikeCheck, marketChecks, runScreen, verifyBridged } from "./screen.ts";
import { type RoutePool, type Simulation, chooseRoute } from "./simulate.ts";
import { hasSelector, scanPowers, timelockDelay } from "./static-checks.ts";

const NOW = Date.parse("2026-10-09T20:40:00Z");
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const TOKEN = "0x00000000000000000000000000000000000000aa";

const pool = (o: Partial<RoutePool> & { routable?: boolean } = {}) => ({
  dex: "uniswap_v3" as const,
  poolId: "0x00000000000000000000000000000000000000b1",
  token0: TOKEN,
  token1: USDC,
  fee: 3000,
  tickSpacing: 60,
  hooks: null,
  liquidityUsd: 400_000,
  createdAt: "2026-01-01T00:00:00Z",
  routable: true,
  ...o,
});

const fine: Simulation = {
  amountIn: "250000000",
  buy: {
    ok: true,
    quoted: "1000000000000000000000",
    received: "1000000000000000000000",
    taxBps: 0,
  },
  transfer: {
    ok: true,
    sent: "1000000000000000000000",
    received: "1000000000000000000000",
    taxBps: 0,
  },
  sell: { ok: true, quoted: "249000000", received: "249000000", taxBps: 0, leftover: "0" },
  roundTripBps: 40,
  quoteSources: ["quoter", "quoter"],
};

/** A fake fork: a plain contract with no owner, no proxy, and the simulation the test gives. */
function fakeFork(simulation: Simulation | (() => never), code = "0x6080604052") {
  const client = {
    getCode: async () => code,
    getStorageAt: async () => "0x" + "0".repeat(64),
    readContract: async () => {
      throw new Error("execution reverted");
    },
  };
  const sim = {
    publicClient: client,
    roundTrip: async () => (typeof simulation === "function" ? simulation() : simulation),
  };
  return <T>(fn: (s: never, block: bigint) => Promise<T>) => fn(sim as never, 1n);
}

const target = { address: TOKEN, symbol: "AAA", name: "Token A", decimals: 18 };
const status = (checks: readonly ScreenCheck[], code: ScreenCheck["code"]) =>
  checks.find((c) => c.code === code)?.status;

async function screen(
  o: {
    sim?: Simulation;
    pools?: ReturnType<typeof pool>[];
    code?: string;
    goplus?: GoPlusReport | null;
  } = {},
) {
  return runScreen(
    {
      token: target,
      pools: o.pools ?? [pool()],
      listings: [{ symbol: "USDC", name: "USDC", monadAddress: USDC, source: "reviewed" }],
    },
    {
      onFork: fakeFork(o.sim ?? fine, o.code),
      goplus: async () => (o.goplus === undefined ? null : o.goplus),
      now: () => NOW,
    },
  );
}

describe("the token screen (F-U1)", () => {
  it("passes a legitimate token with every check's reason and evidence", async () => {
    const r = await screen();
    expect(r.verdict).toBe("passed");
    expect(r.checks.map((c) => c.code)).toEqual([...SCREEN_CHECK_CODES]);
    for (const c of r.checks) expect(c.reason.length).toBeGreaterThan(10);
    // GoPlus unavailable: skipped and said so, never a refusal.
    expect(r.checks.find((c) => c.code === "GOPLUS")).toMatchObject({
      status: "skipped",
      reason: "GoPlus did not answer; the screen ran without it.",
    });
    expect(r.route?.baseSymbol).toBe("USDC");
  });

  it("refuses an unsellable token", async () => {
    const r = await screen({
      sim: { ...fine, sell: { ok: false, error: "transfers are closed" }, roundTripBps: null },
    });
    expect(r.verdict).toBe("refused");
    expect(r.checks.find((c) => c.code === "SELL")).toMatchObject({
      status: "fail",
      reason: "Unsellable: the sell reverted (transfers are closed).",
    });
    expect(status(r.checks, "ROUND_TRIP")).toBe("skipped");
  });

  it("refuses a taxed token on whichever step takes the tax", async () => {
    const buyTax = await screen({
      sim: { ...fine, buy: { ok: true, quoted: "1000", received: "950", taxBps: 500 } },
    });
    expect(buyTax.verdict).toBe("refused");
    expect(buyTax.checks.find((c) => c.code === "BUY")?.reason).toBe(
      "A buy tax of 5.00%, above the 1.00% limit.",
    );
    const transferTax = await screen({
      sim: { ...fine, transfer: { ok: true, sent: "1000", received: "980", taxBps: 200 } },
    });
    expect(status(transferTax.checks, "TRANSFER")).toBe("fail");
    // Under the limit passes, with the shortfall stated.
    const small = await screen({
      sim: { ...fine, buy: { ok: true, quoted: "1000", received: "995", taxBps: 50 } },
    });
    expect(small.verdict).toBe("passed");
    expect(small.checks.find((c) => c.code === "BUY")?.reason).toMatch(/0.50%, within/);
  });

  it("refuses a sell that leaves part of the balance, and a costly round trip", async () => {
    const left = await screen({
      sim: { ...fine, sell: { ...fine.sell, leftover: "5" } as Simulation["sell"] },
    });
    expect(left.checks.find((c) => c.code === "SELL")?.reason).toBe(
      "The whole balance could not be sold.",
    );
    const costly = await screen({ sim: { ...fine, roundTripBps: 450 } });
    expect(status(costly.checks, "ROUND_TRIP")).toBe("fail");
  });

  it("refuses an owner able to blacklist, and passes the same powers when renounced", async () => {
    const blacklist = toFunctionSelector("function blacklist(address)").slice(2);
    const code = `0x6080${"63" + blacklist}14`;
    const r = await screen({ code });
    expect(r.verdict).toBe("refused");
    // The fake fork answers no owner(): an unknown admin is treated as live.
    expect(r.checks.find((c) => c.code === "OWNER_POWERS")?.reason).toMatch(/can call blacklist/);
    expect(scanPowers([code]).found.blacklist).toEqual(["blacklist"]);
  });

  it("refuses a young pool and a thin pool", async () => {
    const young = await screen({ pools: [pool({ createdAt: "2026-10-08T20:40:00Z" })] });
    expect(young.checks.find((c) => c.code === "POOL_AGE")).toMatchObject({
      status: "fail",
      reason: "The pool is 24 hours old, younger than 72 hours.",
    });
    const thin = await screen({ pools: [pool({ liquidityUsd: 30_000 })] });
    expect(thin.checks.find((c) => c.code === "LIQUIDITY")?.reason).toBe(
      "The route pool holds only $30,000, under $50,000.",
    );
    expect(marketChecks(null, [], NOW).every((c) => c.status === "fail")).toBe(true);
  });

  it("refuses a look-alike name at another address", async () => {
    const fake = { ...target, symbol: "USDC" };
    const c = lookAlikeCheck(fake, [
      { symbol: "USDC", name: "USDC", monadAddress: USDC, source: "coingecko" },
    ]);
    expect(c.status).toBe("fail");
    expect(c.reason).toBe(`Its symbol matches USDC (USDC), listed on coingecko at ${USDC}.`);
  });

  it("refuses a token with no route, and skips the simulation", async () => {
    const r = await screen({ pools: [pool({ routable: false })] });
    expect(status(r.checks, "ROUTE")).toBe("fail");
    expect(status(r.checks, "BUY")).toBe("skipped");
    expect(r.verdict).toBe("refused");
  });

  it("lets GoPlus block but never approve alone", async () => {
    const report = (flags: GoPlusReport["flags"]): GoPlusReport => ({
      found: true,
      flags,
      buyTax: 0,
      sellTax: 0,
      transferTax: 0,
      holderCount: 10,
      topHolderShare: 0.2,
      isOpenSource: true,
    });
    const flagged = await screen({ goplus: report(["is_honeypot"]) });
    expect(flagged.verdict).toBe("refused");
    expect(flagged.checks.find((c) => c.code === "GOPLUS")?.reason).toBe(
      "GoPlus flags is_honeypot.",
    );
    // A clean GoPlus does not rescue a failing token.
    const clean = await screen({
      goplus: report([]),
      sim: { ...fine, sell: { ok: false, error: "x" }, roundTripBps: null },
    });
    expect(clean.verdict).toBe("refused");
    // The reviewed list accepts USDC's documented powers in GoPlus's flags too.
    expect(goplusCheck(USDC, report(["is_blacklisted", "is_proxy"])).status).toBe("pass");
    expect(goplusCheck(TOKEN, report(["is_blacklisted"])).status).toBe("fail");
  });

  it("chooses the deepest routable pool against a base asset", () => {
    const deep = pool({ poolId: "0xdeep", token1: WMON, liquidityUsd: 900_000 });
    const hooked = pool({ poolId: "0xhook", liquidityUsd: 5_000_000, routable: false });
    const native = pool({
      poolId: "0xnative",
      token0: "0x0000000000000000000000000000000000000000",
      token1: TOKEN,
    });
    expect(chooseRoute(TOKEN, [pool(), deep, hooked])?.pool.poolId).toBe("0xdeep");
    // Native MON routes only through Uniswap v4.
    expect(chooseRoute(TOKEN, [native])).toBeNull();
    expect(chooseRoute(TOKEN, [{ ...native, dex: "uniswap_v4" as const }])?.baseSymbol).toBe("MON");
    expect(hasSelector("0x62abcdef", "00abcdef")).toBe(true);
  });
});

describe("reviewed bridged tokens and known timelocks (F-U2 Step 0, D-359)", () => {
  const SOL = "0xea17e5a9efebf1477db45082d67010e2245217f1";
  const sol = { address: SOL, symbol: "SOL", name: "Wrapped SOL", decimals: 9 };
  const listings = [
    { symbol: "SOL", name: "Solana", monadAddress: null, source: "coinmarketcap" as const },
  ];
  const wormhole = (mapsTo: string, wrapped = true) =>
    ({
      readContract: async (a: { functionName: string }) =>
        a.functionName === "isWrappedAsset" ? wrapped : mapsTo,
    }) as unknown as Parameters<typeof verifyBridged>[0];

  it("passes Wormhole's wrapped SOL only when the token bridge maps SOL's origin to it", async () => {
    const ex = bridgedException("sol");
    if (!ex) throw new Error("no SOL exception");
    const ok = await verifyBridged(
      wormhole(SOL.toUpperCase().replace("0X", "0x")),
      SOL,
      ex,
      async () => [],
    );
    expect(ok.ok).toBe(true);
    expect(lookAlikeCheck(sol, listings, ok)).toMatchObject({ status: "pass" });
    expect(lookAlikeCheck(sol, listings, ok).reason).toMatch(
      /^A bridged SOL on the reviewed list, confirmed by Wormhole/,
    );
    // A different address claiming SOL is still a look-alike, with why the proof failed.
    const fake = await verifyBridged(wormhole(SOL), TOKEN, ex, async () => []);
    expect(fake.ok).toBe(false);
    const c = lookAlikeCheck({ ...sol, address: TOKEN }, listings, fake);
    expect(c.status).toBe("fail");
    expect(c.evidence.bridgeProof).toMatch(/^not confirmed/);
    // Not wrapped at all: refused.
    expect((await verifyBridged(wormhole(SOL, false), SOL, ex, async () => [])).ok).toBe(false);
  });

  it("checks an issuer's bridged coin against the issuer's official list", async () => {
    const ex = bridgedException("CAKE");
    if (!ex) throw new Error("no CAKE exception");
    const CAKE = "0xf59d81cd43f620e722e07f9cb3f6e41b031017a3";
    const list = async () => [
      { chainId: 143, address: CAKE.toUpperCase().replace("0X", "0x"), symbol: "Cake" },
    ];
    expect((await verifyBridged(wormhole(""), CAKE, ex, list)).ok).toBe(true);
    expect((await verifyBridged(wormhole(""), TOKEN, ex, list)).ok).toBe(false);
    expect(
      (
        await verifyBridged(wormhole(""), CAKE, ex, async () => {
          throw new Error("down");
        })
      ).detail,
    ).toBe("the bridge's record could not be read");
  });

  it("recognizes an Aave Governance v3 executor as a timelock, and a plain owner as none", async () => {
    const EXECUTOR = "0xa9d0eaff48ce1df468f9eaeb7e628c413343f6a2";
    const CONTROLLER = "0x442ca936e5e6db875357d0a16481145c96dd9a82";
    const client = (delay: number, executor = EXECUTOR) => ({
      readContract: async (a: { address: string; functionName: string; args?: unknown[] }) => {
        const at = a.address.toLowerCase();
        if (at === EXECUTOR && a.functionName === "owner") return CONTROLLER;
        if (at === CONTROLLER && a.functionName === "getExecutorSettingsByAccessControl")
          return a.args?.[0] === 1
            ? { executor, delay }
            : { executor: "0x0000000000000000000000000000000000000000", delay: 0 };
        throw new Error("execution reverted");
      },
    });
    expect(await timelockDelay(client(86_400) as never, EXECUTOR)).toEqual({
      seconds: 86_400,
      kind: "aave_governance_v3",
    });
    // A controller that does not name this executor is not its timelock.
    expect(await timelockDelay(client(86_400, TOKEN) as never, EXECUTOR)).toBeNull();
  });
});
