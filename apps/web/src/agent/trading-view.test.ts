import { describe, expect, it } from "vitest";
import type { ActivityJson, IntentJson, PlanCardJson, ProposalJson } from "@/api/client";
import {
  decisionRows,
  holdingLine,
  insightRows,
  insights,
  ago,
  legsLeft,
  liveTradeRows,
  planBanner,
  tradeHistory,
  planIsMet,
  planOfTrade,
  runLabel,
  planMoves,
  planRows,
  skipWords,
  tradeRows,
  tradesInFlight,
} from "./trading-view";

const position = (over: Partial<ProposalJson["positions"][number]>) =>
  ({
    token: "0xfb8bf4c1cc7a94c73d209a149ea2abea852bc541",
    symbol: "WMON",
    targetWeightBps: 2000,
    bandBps: 500,
    currentWeightBps: 0,
    action: "ADD",
    thesisCode: null,
    thesis: "Deep pools and a clean price.",
    killCriterion: "",
    recheckAt: "",
    trimAboveBps: null,
    confidence: "medium",
    sources: { onchain: 1, market: 1, primary: 0, news: 0, social: 0 },
    verdict: null,
    reason: "fallback reason",
    ...over,
  }) as ProposalJson["positions"][number];

describe("the Trading tab's words (UI-FAST)", () => {
  it("turns each plan position into one move: Buy to add, Sell to trim or exit, Hold to keep", () => {
    const moves = planMoves({
      positions: [
        position({}),
        position({
          symbol: "TALPHA",
          action: "TRIM",
          targetWeightBps: 500,
          currentWeightBps: 1200,
        }),
        position({ symbol: "TBETA", action: "EXIT", currentWeightBps: 300, thesis: null }),
        position({ symbol: "USDC", action: "HOLD", targetWeightBps: 8000, currentWeightBps: null }),
      ],
      rationale: { portfolioView: "A view.", allocationNote: null },
    } as unknown as ProposalJson);
    expect(moves.map((m) => [m.side, m.symbol, m.amount, m.reason])).toEqual([
      ["Buy", "WMON", "Target 20% (now 0%)", "Deep pools and a clean price."],
      ["Sell", "TALPHA", "Target 5% (now 12%)", "Deep pools and a clean price."],
      ["Sell", "TBETA", "Sell all (now 3%)", "fallback reason"],
      ["Hold", "USDC", "Target 80%", "Deep pools and a clean price."],
    ]);
  });

  it("writes a past trade as token, side, date, amount and result", () => {
    const [row] = tradeRows([
      {
        intentId: "i1",
        status: "settled",
        sell: { asset: "USDC", amountRaw: "20000" },
        buy: "WMON",
        amountOut: { asset: "WMON", amountRaw: "19980010470007175" },
        expectedOut: null,
        createdAt: "2026-10-13T01:28:42.000Z",
        settledAt: "2026-10-13T01:28:55.000Z",
      } as unknown as IntentJson,
    ]);
    expect(row).toMatchObject({
      symbol: "WMON",
      side: "Buy",
      date: "2026-10-13 01:28",
      amount: "0.02 USDC → 0.01998 WMON",
      result: "Settled",
      resultTone: "positive",
    });
  });

  it("moves a band plan with no position rows by its own targets (agent #4's waiting plan)", () => {
    const band = {
      positions: [],
      plan: {
        targetWmonBps: 2000,
        minTradeUsdcE6: "500000",
        volatilityBrakeBps: 20000,
        costHurdleBps: 40,
        maxLegBps: 1000,
      },
      rationale: {
        portfolioView: "Use the two-asset band plan: WMON at the 20% target, rest in USDC.",
        allocationNote: null,
      },
    } as unknown as ProposalJson;
    expect(planMoves(band, null).map((m) => [m.side, m.symbol, m.amount])).toEqual([
      ["Buy", "WMON", "Target 20%"],
      ["Hold", "USDC", "Keep 80%"],
    ]);
    expect(planMoves(band, null)[0]?.reason).toMatch(/two-asset band plan/);
  });

  it("feeds plans, trades and blocked trades newest first, a plan with its report", () => {
    const pending = {
      proposalId: "prop-1",
      kind: "proposal",
      status: "pending_owner",
      cycleId: "cycle-1",
      createdAt: "2026-10-13T17:48:40.000Z",
      positions: [],
      plan: { targetWmonBps: 2000 },
      explanation: null,
      rationale: {
        portfolioView: "WMON at 20%.",
        whatWouldChangeIt: "A failed screen.",
        evidenceStrength: "mixed",
        allocationNote: null,
      },
    } as unknown as ProposalJson;
    const card = { pending, noChange: null, recent: [], current: null } as unknown as PlanCardJson;
    const trade = {
      intentId: "i1",
      status: "settled",
      sell: { asset: "USDC", amountRaw: "20000" },
      buy: "WMON",
      reason: "Rebalance toward the target.",
      blockers: [],
      failure: null,
      txHash: null,
      createdAt: "2026-10-13T01:28:42.000Z",
      settledAt: "2026-10-13T01:28:55.000Z",
    } as unknown as IntentJson;
    const blocked = {
      entryId: "a1",
      kind: "blocked",
      text: "Did not trade: over the cap.",
      renderedBy: "template",
      at: "2026-10-13T01:29:00.000Z",
    } as ActivityJson;
    const runner = {
      outcome: "hold",
      code: "BELOW_MIN_TRADE",
      message:
        "The account is outside its band, but the trade back would be smaller than the plan's minimum trade.",
      since: "2026-10-13T19:51:34.183Z",
      lastAt: "2026-10-13T19:55:39.864Z",
      intentId: null,
    };
    const feed = decisionRows({
      card,
      intents: [{ ...trade, txHash: "0xabc" } as IntentJson],
      activity: [blocked],
      runner,
      reportFor: (c) => `/r/${c}`,
      txFor: (h) => `https://x/tx/${h}`,
    });
    expect(feed.map((d) => [d.kind, d.token, d.link?.href ?? null])).toEqual([
      ["Skipped", "WMON", null],
      ["Plan", "WMON", "/r/cycle-1"],
      ["Refused", null, null],
      ["Trade", "WMON", "https://x/tx/0xabc"],
    ]);
  });

  it("says what the account holds, with dashes where the data does not exist", () => {
    const row = (symbol: string, shareBps: number, gainBps: number | null, isCash = false) => ({
      symbol,
      decimals: 18,
      amountRaw: "1000",
      isCash,
      valueUsdcE6: "1",
      shareBps,
      costBasisUsdcE6: null,
      gainUsdcE6: null,
      gainBps,
    });
    const out = insights(
      [row("USDC", 7000, null, true), row("WMON", 2500, 300), row("TALPHA", 500, -150)],
      [],
      Date.parse("2026-10-13T18:00:00Z"),
    );
    expect(Object.fromEntries(out.map((i) => [i.label, i.value]))).toMatchObject({
      Positions: "2",
      "Average position age": "–",
      Largest: "WMON 25%",
      Smallest: "TALPHA 5%",
      Best: "WMON +3%",
      Worst: "TALPHA -1.5%",
    });
  });

  it("says a recorded skip plainly, with the plan's target and minimum", () => {
    const runner = {
      outcome: "hold",
      code: "BELOW_MIN_TRADE",
      message: "The trade back would be smaller than the plan's minimum trade.",
      since: "x",
      lastAt: "x",
      intentId: null,
    };
    expect(
      skipWords(runner, { targetWmonBps: 2000, minTradeUsdcE6: "1000000" } as ProposalJson["plan"]),
    ).toBe("Skipped: the trade back to 20% WMON was below the 1.00 USDC minimum.");
    expect(skipWords({ ...runner, code: "OTHER" }, null)).toBe(
      "Skipped: the trade back would be smaller than the plan's minimum trade.",
    );
  });

  it("lays the plan out as rows with each token's target and its share now", () => {
    const band = {
      positions: [],
      plan: { targetWmonBps: 2000 },
      rationale: { portfolioView: "v", allocationNote: null },
    } as unknown as ProposalJson;
    const holdings = [
      { symbol: "USDC", shareBps: 10_000, isCash: true },
      { symbol: "WMON", shareBps: 0, isCash: false },
    ] as unknown as Parameters<typeof planRows>[2];
    expect(planRows(band, null, holdings)).toEqual([
      { symbol: "WMON", side: "Buy", targetBps: 2000, currentBps: 0 },
      { symbol: "USDC", side: "Hold", targetBps: 8000, currentBps: 10_000 },
    ]);
  });

  it("expands the insights with notes where a figure does not exist yet", () => {
    const rows = insightRows(
      [
        {
          symbol: "USDC",
          decimals: 6,
          amountRaw: "5000000",
          isCash: true,
          valueUsdcE6: "5000000",
          shareBps: 10_000,
          costBasisUsdcE6: null,
          gainUsdcE6: null,
          gainBps: null,
        },
      ],
      "5000000",
      [],
      Date.parse("2026-10-13T18:00:00Z"),
    );
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(by["Total value"]?.value).toBe("5.00 USDC");
    expect(by["Cash / invested"]).toMatchObject({ value: "100% / 0%", bar: 10_000 });
    expect(by["Realized PnL"]).toMatchObject({ value: "–", note: "Not recorded per trade yet" });
    expect(by["Unrealized PnL"]).toMatchObject({ value: "–", note: "No cost basis yet" });
  });
});

describe("live trades on the Trading tab (2026-10-13)", () => {
  const leg = (over: Partial<IntentJson>): IntentJson =>
    ({
      intentId: "intent-1",
      status: "submitted",
      sell: { asset: "USDC", amount: "0.80", amountRaw: "800000" },
      buy: "WMON",
      txHash: null,
      createdAt: "2026-10-13T22:24:19.000Z",
      submittedAt: null,
      settledAt: null,
      ...over,
    }) as unknown as IntentJson;
  const tx = (h: string) => `https://testnet.monadvision.com/tx/${h}`;

  it("shows each leg since the plan's approval, newest first, pending then settled or failed, with its transaction", () => {
    const rows = liveTradeRows(
      [
        leg({ intentId: "old", createdAt: "2026-10-13T20:00:00.000Z", status: "settled" }),
        leg({
          intentId: "a",
          status: "reconciled",
          txHash: "0x11",
          settledAt: "2026-10-13T22:24:39.000Z",
        }),
        leg({
          intentId: "b",
          createdAt: "2026-10-13T22:25:19.000Z",
          sell: { asset: "WMON", amount: "1.5", amountRaw: "1500000000000000000" },
          buy: "USDC",
        }),
        leg({ intentId: "c", createdAt: "2026-10-13T22:26:00.000Z", status: "failed" }),
        leg({ intentId: "w", createdAt: "2026-10-13T22:27:00.000Z", status: "awaiting_approval" }),
      ],
      "2026-10-13T22:22:47.000Z",
      tx,
    );
    expect(rows.map((r) => [r.id, r.side, r.token, r.amount, r.status])).toEqual([
      ["c", "Buy", "WMON", "0.80 USDC", "failed"],
      ["b", "Sell", "WMON", "1.5 WMON", "pending"],
      ["a", "Buy", "WMON", "0.80 USDC", "settled"],
    ]);
    expect(rows[2]).toMatchObject({ time: "2026-10-13 22:24", txHref: tx("0x11") });
    expect(rows[1]?.txHref).toBeNull();
  });

  it("keeps refreshing while a leg is on its way, not for one waiting for the owner", () => {
    expect(tradesInFlight([leg({ status: "submitted" })])).toBe(true);
    expect(tradesInFlight([leg({ status: "awaiting_approval" }), leg({ status: "settled" })])).toBe(
      false,
    );
  });

  it("says a hold in one plain line, naming the cost limit", () => {
    const runner = {
      outcome: "hold",
      code: "COST_HURDLE",
      message: "The trade would cost more against the oracle than the plan allows.",
      since: "",
      lastAt: "",
      intentId: null,
    };
    expect(holdingLine(runner, 200)).toBe(
      "Holding: the next trade would cost more than the 2% limit.",
    );
    expect(holdingLine(runner, 50)).toBe(
      "Holding: the next trade would cost more than the 0.5% limit.",
    );
    expect(
      holdingLine({ ...runner, code: "IN_BAND", message: "Every position is in its band." }, 50),
    ).toBe("Holding: every position is in its band.");
    expect(holdingLine({ ...runner, outcome: "leg" }, 50)).toBeNull();
    expect(holdingLine(null, 50)).toBeNull();
  });
});

describe("which run a plan and a trade came from (2026-10-13)", () => {
  const plans = [
    {
      cycleId: "cycle-a",
      createdAt: "2026-10-13T22:10:06.000Z",
      decidedAt: "2026-10-13T22:22:47.000Z",
    },
    {
      cycleId: "cycle-b",
      createdAt: "2026-10-14T01:28:03.000Z",
      decidedAt: "2026-10-14T01:40:00.000Z",
    },
  ];
  it("names the run by its time, and gives a trade the plan approved before it", () => {
    expect(runLabel(plans[1])).toBe("From the research run of 2026-10-14 01:28 UTC");
    expect(runLabel({ cycleId: null, createdAt: "x" })).toBeNull();
    expect(planOfTrade({ createdAt: "2026-10-13T22:24:19.000Z" }, plans)?.cycleId).toBe("cycle-a");
    expect(planOfTrade({ createdAt: "2026-10-14T02:00:00.000Z" }, plans)?.cycleId).toBe("cycle-b");
    expect(planOfTrade({ createdAt: "2026-10-13T20:00:00.000Z" }, plans)).toBeNull();
  });
});

describe("trading toward a plan (2026-10-13)", () => {
  const intent = (over: Partial<IntentJson>): IntentJson =>
    ({
      intentId: "i",
      status: "reconciled",
      sell: { asset: "USDC", amount: "0.80", amountRaw: "800000" },
      buy: "WMON",
      amountOut: { asset: "WMON", amount: "0.795", amountRaw: "795000000000000000" },
      txHash: "0x11",
      failure: null,
      blockers: [],
      reason: "",
      createdAt: "2026-10-14T02:10:00.000Z",
      submittedAt: null,
      settledAt: "2026-10-14T02:10:20.000Z",
      ...over,
    }) as unknown as IntentJson;
  const now = Date.parse("2026-10-14T02:14:20.000Z");

  it("counts the legs a plan still needs, and says how far it has come", () => {
    const rows = [
      { targetBps: 3_000, currentBps: 1_000 },
      { targetBps: 7_000, currentBps: 9_000 },
      { targetBps: null, currentBps: 500 },
    ];
    expect(legsLeft(rows, 1_000, 500)).toBe(4);
    expect(legsLeft([{ targetBps: 2_000, currentBps: 1_900 }], 1_000, 500)).toBe(0);
    expect(
      planBanner({
        approvedAt: "2026-10-14T02:07:37.000Z",
        intents: [intent({})],
        rows: [{ targetBps: 3_000, currentBps: 1_800 }],
        maxLegBps: 1_000,
        bandBps: 500,
      }),
    ).toBe("Trading toward the new plan: 1 of 3 trades done");
    expect(
      planBanner({
        approvedAt: "2026-10-14T02:07:37.000Z",
        intents: [],
        rows: [{ targetBps: 2_000, currentBps: 2_000 }],
        maxLegBps: 1_000,
        bandBps: 500,
      }),
    ).toBeNull();
  });

  it("lists every trade with its price and says how many and how long ago", () => {
    const h = tradeHistory(
      [
        intent({}),
        intent({
          intentId: "f",
          status: "failed",
          txHash: null,
          failure: "The pool moved.",
          createdAt: "2026-10-14T02:12:00.000Z",
        }),
        intent({ intentId: "w", status: "awaiting_approval" }),
      ],
      (x) => `https://x/tx/${x}`,
      now,
    );
    expect(h.line).toBe("1 trade · last 4 min ago");
    expect(h.rows.map((r) => [r.id, r.stage, r.reason])).toEqual([
      ["f", "Failed", "The pool moved."],
      ["i", "Settled", null],
    ]);
    expect(h.rows[1]?.amount).toBe("0.80 USDC at 1.0063 USDC");
    expect(ago("2026-10-14T00:14:20.000Z", now)).toBe("2 h ago");
  });

  it("names each live leg's state in words", () => {
    const rows = liveTradeRows(
      [
        intent({ intentId: "a", status: "approved", createdAt: "2026-10-14T02:11:00.000Z" }),
        intent({ intentId: "b", status: "submitted", createdAt: "2026-10-14T02:12:00.000Z" }),
        intent({ intentId: "c", status: "confirmed", createdAt: "2026-10-14T02:13:00.000Z" }),
      ],
      null,
      (x) => x,
    );
    expect(rows.map((r) => r.stage)).toEqual([
      "Confirming",
      "Sending",
      "Waiting for the next check",
    ]);
  });
});

describe("a plan's side from the account's share (2026-10-13)", () => {
  const proposal = (target: number) =>
    ({
      proposalId: "p",
      status: "pending_owner",
      positions: [],
      plan: {
        targetWmonBps: target,
        bandHalfWidthBps: 500,
        minTradeUsdcE6: "500000",
        volatilityBrakeBps: 25_000,
        costHurdleBps: 50,
        maxLegBps: 1_000,
      },
      rationale: { portfolioView: "", allocationNote: null },
    }) as unknown as ProposalJson;
  const card = { current: { targetWmonBps: 3_000 } } as unknown as PlanCardJson;
  const rows = (wmonBps: number) =>
    [
      { symbol: "WMON", shareBps: wmonBps },
      { symbol: "USDC", shareBps: 10_000 - wmonBps, isCash: true },
    ] as never;

  it("holds when the account is already within the plan's range, whatever the previous plan said", () => {
    // The previous plan targeted 30%; the account holds 19.9% WMON and the new plan targets 20%.
    const met = planRows(proposal(2_000), card, rows(1_990));
    expect(met.find((r) => r.symbol === "WMON")?.side).toBe("Hold");
    expect(planIsMet(met)).toBe(true);
    expect(
      planRows(proposal(3_000), card, rows(1_000)).find((r) => r.symbol === "WMON")?.side,
    ).toBe("Buy");
    expect(
      planRows(proposal(1_000), card, rows(3_000)).find((r) => r.symbol === "WMON")?.side,
    ).toBe("Sell");
    expect(planIsMet(planRows(proposal(3_000), card, rows(1_000)))).toBe(false);
  });
});
