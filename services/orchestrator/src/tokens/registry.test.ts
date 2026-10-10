import { writeFileSync } from "node:fs";
import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import { MarketData, TokenDiscovery } from "@alpha-agents/market";
import {
  TOKENS_FIXTURE_NOW_MS,
  fakeTokenChain,
  tokenFixtureFetch,
} from "@alpha-agents/market/testing";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerTokenRoutes } from "../token-routes.ts";
import { RegistryError, TokenRegistry, secondaryFirst } from "./registry.ts";
import type { ScreenFork } from "./screen-fork.ts";
import type { Simulation } from "./simulate.ts";
import { TokenStore } from "./store.ts";
import { registryToolSource } from "./tool-source.ts";

const dbUp = await databaseAvailable();
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const LV = "0x1001ff13bf368aa4fa85f21043648079f00e1001";

const fine: Simulation = {
  amountIn: "250000000",
  buy: {
    ok: true,
    quoted: "4132000000000000000000",
    received: "4132000000000000000000",
    taxBps: 0,
  },
  transfer: {
    ok: true,
    sent: "4132000000000000000000",
    received: "4132000000000000000000",
    taxBps: 0,
  },
  sell: { ok: true, quoted: "249000000", received: "249000000", taxBps: 0, leftover: "0" },
  roundTripBps: 40,
  quoteSources: ["quoter", "quoter"],
};

/** A fork stand-in: a plain contract, and the simulation the test sets; counts its runs. */
function fakeFork() {
  const state = { runs: 0, simulation: fine, gate: null as Promise<void> | null };
  const fork = {
    run: async <T>(fn: (sim: never, block: bigint) => Promise<T>) => {
      state.runs++;
      if (state.gate) await state.gate;
      const client = {
        getCode: async () => "0x6080604052",
        getStorageAt: async () => `0x${"0".repeat(64)}`,
        // MON/USD answers (it sizes a WMON buy); the token itself names no owner.
        readContract: async (a: { functionName: string }) => {
          if (a.functionName === "latestRoundData") return [1n, 2_422_263n, 0n, 0n, 1n];
          throw new Error("execution reverted");
        },
      };
      return fn(
        { publicClient: client, roundTrip: async () => state.simulation } as never,
        111_990_000n,
      );
    },
    stop: async () => undefined,
  };
  return { fork: fork as unknown as ScreenFork, state };
}

describe.skipIf(!dbUp)(
  "the token registry in Postgres (F-U1, needs Postgres)",
  { timeout: 120_000 },
  () => {
    let t: TestDatabase;
    let now = TOKENS_FIXTURE_NOW_MS;
    let registry: TokenRegistry;
    let fork: ReturnType<typeof fakeFork>;

    beforeAll(async () => {
      t = await createTestDatabase("orch_tokens");
      const f = tokenFixtureFetch();
      const market = new MarketData({
        cmcApiKey: null,
        mainnet: null,
        fetch: f.fetch,
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      });
      fork = fakeFork();
      registry = new TokenRegistry({
        chainId: 143,
        store: new TokenStore(t.db, () => now),
        market,
        discovery: new TokenDiscovery({
          market,
          cmcApiKey: "test-key-not-real",
          client: fakeTokenChain(),
          txPages: 0,
        }),
        fork: fork.fork,
        goplus: null,
        now: () => now,
      });
    }, 120_000);
    afterAll(async () => {
      await t?.drop();
    }, 60_000);

    it("writes a discovery: tokens, pools and the run, and counts new pools once", async () => {
      const d = await registry.discover();
      expect(d.tokens).toBeGreaterThan(20);
      expect(d.classF).toBeGreaterThanOrEqual(8);
      expect(d.newPools).toBe(d.pools);
      const usdc = await registry.store.token(143, USDC);
      expect(usdc).toMatchObject({ symbol: "USDC", priceClass: "F", screen: null });
      expect((usdc?.feed as { legs: unknown[] }).legs).toHaveLength(1);
      const again = await registry.discover();
      expect(again.newPools).toBe(0);
      const runs = await registry.store.runs(143);
      expect(runs.map((r) => r.status)).toEqual(["completed", "completed"]);
      const counts = await registry.store.counts(143);
      expect(counts.classF + counts.classA).toBe(counts.tokens);
      expect(counts.passing).toBe(0);
    });

    it("filters the list by class and liquidity, deepest first", async () => {
      const f = await registry.list({ priceClass: "F", minLiquidityUsd: 50_000 });
      expect(f.length).toBeGreaterThan(5);
      expect(f.every((x) => x.priceClass === "F" && x.liquidityUsd >= 50_000)).toBe(true);
      const depths = f.map((x) => x.liquidityUsd);
      expect(depths).toEqual([...depths].sort((a, b) => b - a));
      expect((await registry.list({ screen: "unscreened" })).length).toBeGreaterThan(0);
    });

    it("screens a token, keeps it as history, serves it fresh, and lets it expire", async () => {
      const s = await registry.screen(LV, "agent:7");
      expect(s.requestedBy).toBe("agent:7");
      expect(s.checks.map((c) => c.code)).toContain("SELL");
      expect(Date.parse(s.expiresAt) - Date.parse(s.createdAt)).toBe(6 * 3600_000);
      const row = await registry.store.token(143, LV);
      expect(row?.screen).toMatchObject({ screenId: s.screenId, verdict: s.verdict, fresh: true });
      // Fresh: served from the registry, no new fork run.
      const runs = fork.state.runs;
      const cached = await registry.screenOrCached(LV, "agent:8");
      expect(cached).toMatchObject({ cacheHit: true });
      expect(cached.record.screenId).toBe(s.screenId);
      expect(fork.state.runs).toBe(runs);
      // Six hours later it has expired: a new screen runs, and both stay in the history.
      now += 6 * 3600_000 + 1;
      expect(await registry.freshScreen(LV)).toBeNull();
      expect(
        (await registry.store.listTokens(143, { screen: "expired" })).map((x) => x.address),
      ).toContain(LV);
      const next = await registry.screenOrCached(LV, "platform");
      expect(next.cacheHit).toBe(false);
      expect((await registry.store.screens(143, LV)).map((x) => x.screenId)).toEqual([
        next.record.screenId,
        s.screenId,
      ]);
    });

    it("runs one screen per token at a time, and refuses a token outside the registry", async () => {
      let open: () => void = () => undefined;
      fork.state.gate = new Promise<void>((r) => {
        open = r;
      });
      const before = fork.state.runs;
      const a = registry.screen(USDC, "agent:1");
      const b = registry.screen(USDC, "agent:2");
      open();
      const [ra, rb] = await Promise.all([a, b]);
      fork.state.gate = null;
      expect(ra.screenId).toBe(rb.screenId);
      expect(fork.state.runs - before).toBe(1);
      await expect(
        registry.screen("0x00000000000000000000000000000000000000aa", "agent:1"),
      ).rejects.toThrow(RegistryError);
    });

    it("refuses a sell that reverts, and records the evidence", async () => {
      fork.state.simulation = {
        ...fine,
        sell: { ok: false, error: "transfers are closed" },
        roundTripBps: null,
      };
      const s = await registry.screen(LV, "console");
      fork.state.simulation = fine;
      expect(s.verdict).toBe("refused");
      expect(s.checks.find((c) => c.code === "SELL")?.evidence.error).toBe("transfers are closed");
    });

    it("gives the tools typed rows, and the console its routes", async () => {
      const src = registryToolSource(registry, () => now);
      const list = await src.list({ minLiquidityUsd: 50_000, screen: "any", limit: 10 });
      expect(list[0]).toHaveProperty("listedOnCoinGecko");
      const view = await src.freshScreen(LV);
      expect(view?.summary).toMatch(/^Refused: Simulated sell/);
      expect(view?.buyable).toBe(false);

      const app = new Hono();
      registerTokenRoutes(app, { registry, canAct: false });
      const res = await app.request("/v1/tokens?priceClass=F");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        tokens: unknown[];
        counts: { tokens: number };
        canAct: boolean;
      };
      expect(body.tokens.length).toBeGreaterThan(5);
      expect(body.canAct).toBe(false);
      const detail = (await (await app.request(`/v1/tokens/${LV}`)).json()) as {
        screens: unknown[];
        pools: unknown[];
      };
      expect(detail.screens.length).toBeGreaterThanOrEqual(3);
      expect(detail.pools.length).toBeGreaterThan(0);
      expect((await app.request("/v1/tokens/nope")).status).toBe(400);
      // Without operator actions there is no way to screen from the console.
      expect((await app.request(`/v1/tokens/${LV}/screen`, { method: "POST" })).status).toBe(404);
      // The console's e2e fixture is these answers, as an operator sees them
      // (TOKENS_FIXTURE_DIR=apps/console/e2e).
      const dir = process.env.TOKENS_FIXTURE_DIR;
      if (dir) {
        const op = new Hono();
        registerTokenRoutes(op, { registry, canAct: true });
        const list = await (await op.request("/v1/tokens")).json();
        const one = await (await op.request(`/v1/tokens/${LV}`)).json();
        writeFileSync(`${dir}/tokens-fixture.json`, `${JSON.stringify(list, null, 2)}\n`);
        writeFileSync(`${dir}/token-detail-fixture.json`, `${JSON.stringify(one, null, 2)}\n`);
      }
    });
  },
);

describe("the token reads' RPC order (F-U2 Step 0)", () => {
  it("puts the secondary first and keeps the primary as the fallback", () => {
    expect(secondaryFirst(["primary", "secondary"])).toEqual(["secondary", "primary"]);
    expect(secondaryFirst(["only"])).toEqual(["only"]);
    expect(secondaryFirst([])).toEqual([]);
  });
});
