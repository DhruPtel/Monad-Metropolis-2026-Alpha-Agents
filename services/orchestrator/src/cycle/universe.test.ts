import { type TestDatabase, createTestDatabase, databaseAvailable } from "@alpha-agents/db/testing";
import type { Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScanTheme } from "./stages.ts";
import type { Cycle } from "./store.ts";
import { type UniverseRow, UniverseStore, themeDecisions, universeSnapshot } from "./universe.ts";

/**
 * The universe a cycle considered (F-U12): why each theme was or was not
 * chosen for a Dive, by the Dive rules; and the store's record of every
 * token seen, the themes' decisions and the Zoom out's outcome.
 */
const theme = (
  code: string,
  materiality: ScanTheme["materiality"],
  symbol: string | null,
): ScanTheme =>
  ({
    code,
    materiality,
    scope: symbol ? "TOKEN" : "MARKET",
    symbol,
    token: symbol ? (`0x${code.toLowerCase().padEnd(40, "0").slice(0, 40)}` as Hex) : null,
    whyNow: "because",
  }) as ScanTheme;

describe("why each theme was or was not chosen for a Dive", () => {
  it("names the chosen ones' materiality, and the rule that left each of the others out", () => {
    const themes = [
      theme("A_HIGH", "high", "AAA"),
      theme("B_MED", "medium", "BBB"),
      theme("C_MED_RECENT", "medium", "CCC"),
      theme("D_LOW", "low", "DDD"),
      theme("E_HIGH", "high", "EEE"),
    ];
    const d = themeDecisions({
      kind: "ROUTINE",
      themes,
      chosen: [themes[0] as ScanTheme, themes[1] as ScanTheme],
      divesPerDay: 2,
      divesToday: 0,
      recentlyDived: ["C_MED_RECENT"],
    });
    expect(d.map((x) => [x.code, x.chosen, x.reason])).toEqual([
      ["A_HIGH", true, "chosen for a Dive (high materiality)"],
      ["B_MED", true, "chosen for a Dive (medium materiality)"],
      ["C_MED_RECENT", false, "medium materiality and dived in the last 48 hours"],
      ["D_LOW", false, "low materiality: not worth a Dive today"],
      ["E_HIGH", false, "beyond today's remaining Dives, by materiality"],
    ]);
    expect(d[0]?.token).toMatch(/^0x/);
    // Today's Dives used up: every unchosen theme says so.
    const none = themeDecisions({
      kind: "ROUTINE",
      themes: [themes[0] as ScanTheme],
      chosen: [],
      divesPerDay: 2,
      divesToday: 2,
      recentlyDived: [],
    });
    expect(none[0]?.reason).toBe("today's Dives are used up");
    // An activation sweep dives its top two by materiality.
    const act = themeDecisions({
      kind: "ACTIVATION",
      themes,
      chosen: [themes[0] as ScanTheme, themes[4] as ScanTheme],
      divesPerDay: 2,
      divesToday: 0,
      recentlyDived: [],
    });
    expect(act.filter((x) => !x.chosen).map((x) => x.reason)).toEqual([
      "beyond the activation sweep's two Dives, by materiality",
      "beyond the activation sweep's two Dives, by materiality",
      "beyond the activation sweep's two Dives, by materiality",
    ]);
  });
});

const WMON = "0x00000000000000000000000000000000000000a1" as Hex;
const GHO = "0x00000000000000000000000000000000000000a2" as Hex;
const CHAOS = "0x00000000000000000000000000000000000000a3" as Hex;

const row = (over: Partial<UniverseRow> & { token: Hex; symbol: string }): UniverseRow => ({
  priceClass: "F",
  lane: "core",
  status: "listed",
  buyable: true,
  whyNot: null,
  held: false,
  themeCode: null,
  themeReason: null,
  researched: false,
  proposed: false,
  droppedReason: null,
  ...over,
});

const cycle = {
  cycleId: "cycle-00000000-0000-4000-8000-000000000001",
  chainId: 143,
  agentId: 1,
  kind: "ROUTINE",
} as Cycle;

const dbUp = await databaseAvailable();
describe.skipIf(!dbUp)("the universe store", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase("universe");
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("records every token seen, marks the themes' decisions and the Zoom out's outcome, and reads them back buyable first", async () => {
    const store = new UniverseStore(t.db);
    await store.record(cycle, [
      row({ token: WMON, symbol: "WMON", held: true }),
      row({ token: GHO, symbol: "GHO", priceClass: "A", lane: "screened" }),
      row({
        token: CHAOS,
        symbol: "CHAOS",
        priceClass: "A",
        lane: "screened",
        buyable: false,
        whyNot: "in the screened lane; the owner has not opted in on chain",
      }),
    ]);
    // Recording again updates what can change and keeps the rest.
    await store.record(cycle, [
      row({ token: CHAOS, symbol: "CHAOS", priceClass: "A", lane: "screened", buyable: true }),
    ]);
    await store.markThemes(cycle, [
      {
        token: WMON,
        code: "TVL_OUTFLOW",
        chosen: true,
        reason: "chosen for a Dive (high materiality)",
      },
      {
        token: null,
        code: "MARKET_WIDE",
        chosen: false,
        reason: "low materiality: not worth a Dive today",
      },
      {
        token: GHO,
        code: "GHO_PEG",
        chosen: false,
        reason: "low materiality: not worth a Dive today",
      },
    ]);
    await store.markOutcome(
      cycle,
      [GHO],
      [{ token: WMON, reason: "the thesis weakened under challenge" }],
    );
    const rows = await store.forCycle(cycle.cycleId);
    expect(rows.map((r) => r.symbol)).toEqual(["CHAOS", "GHO", "WMON"]);
    expect(rows.find((r) => r.symbol === "CHAOS")).toMatchObject({
      buyable: true,
      whyNot: null,
      // P-SWEEP: a token with no theme still says why it was not researched.
      themeCode: null,
      themeReason: "seen at the Scan; not one of its themes this cycle",
    });
    expect(rows.find((r) => r.symbol === "WMON")).toMatchObject({
      held: true,
      themeCode: "TVL_OUTFLOW",
      researched: true,
      proposed: false,
      droppedReason: "the thesis weakened under challenge",
    });
    expect(rows.find((r) => r.symbol === "GHO")).toMatchObject({
      themeCode: "GHO_PEG",
      researched: false,
      proposed: true,
      droppedReason: null,
    });
    expect(await store.forCycle("cycle-00000000-0000-4000-8000-000000000002")).toEqual([]);
  });
});

describe("the research universe beyond the registry (P-SWEEP, D-384)", () => {
  it("adds every research token on Monad and Base as research-only rows, once each", async () => {
    const reader = {
      market: async () => ({ tokens: [], usdc: WMON, prices: {}, attestorSet: false }),
      agent: async () => null,
    } as unknown as Parameters<typeof universeSnapshot>[0];
    const listed: Record<number, { address: string; symbol: string; priceClass: "F" | "A" }[]> = {
      143: [
        { address: GHO, symbol: "GHO", priceClass: "A" },
        { address: WMON, symbol: "WMON", priceClass: "F" },
      ],
      8453: [
        { address: CHAOS, symbol: "AERO", priceClass: "F" },
        { address: GHO, symbol: "GHO", priceClass: "A" },
      ],
    };
    const tokens = {
      token: async () => null,
      listTokens: async (chainId: number) => listed[chainId] ?? [],
    } as unknown as Parameters<typeof universeSnapshot>[1];
    const rows = await universeSnapshot(reader, tokens, cycle, 143, [
      { chainId: 8453, name: "Base", whyNot: "research only: on Base" },
    ]);
    expect(rows.map((r) => [r.symbol, r.buyable, r.whyNot])).toEqual([
      [
        "GHO",
        false,
        "research only: not in this account's token registry, so not buyable here yet",
      ],
      [
        "WMON",
        false,
        "research only: not in this account's token registry, so not buyable here yet",
      ],
      ["AERO (Base)", false, "research only: on Base"],
    ]);
  });
});
